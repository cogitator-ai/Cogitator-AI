import { z } from 'zod';
import {
  isMemoryFileAdapter,
  MemoryFiles,
  memoryPath,
  type MemoryFileAccess,
  type MemoryFileCommand,
  type MemoryFilePlace,
  MEMORY_RESERVED_PATHS,
} from '@cogitator-ai/memory';
import type {
  BaseToolContext,
  MemoryAdapter,
  MemoryItemScope,
  Tool,
  ToolContentResult,
} from '@cogitator-ai/types';
import { tool } from '../tool';
import { toolContent } from '../tool-content';

/** Name of the memory tool, as Anthropic's `memory_20250818` tool is named */
export const MEMORY_FILE_TOOL = 'memory';

/** Runs whose viewed files the tool remembers, the oldest forgotten past it */
const RUNS_REMEMBERED = 1024;

/** Where a run keeps its conversation, for the memory tool to see the files of its branch */
export interface MemoryFilePlaceOfRun {
  threadId: string;
  /** The run's newest entry, null for a branch that holds nothing yet, the active one when absent */
  leafId?: string | null;
}

export interface MemoryFileToolConfig {
  /**
   * The store the run's thread is read from, for the branch it stands on, and the files are kept
   * in unless `files` is given: then it must keep memory files
   */
  memory: MemoryAdapter;
  /** The id the agent's memory is kept under (`memoryAgentId(agent)`) */
  agentId: string;
  /**
   * Who the files belong to: `user` (default) the run's user, the thread for a run without one,
   * `agent` everyone the agent talks to, `thread` the thread alone
   */
  scope?: 'user' | 'agent' | 'thread';
  /** The agent views the files and never changes them */
  readOnly?: boolean;
  /**
   * Where a run keeps its conversation, so it sees the files of its own branch: the runtime names
   * it, and a run it names no place for reads no thread's files. Without it the thread of the
   * tool's context is read, its active branch.
   */
  placeOf?: (runId: string) => MemoryFilePlaceOfRun | undefined;
  /** The files service, one over `memory` by default */
  files?: MemoryFiles;
}

const memoryParams = z.object({
  command: z
    .enum(['view', 'create', 'str_replace', 'insert', 'delete', 'rename'])
    .describe('What to do'),
  path: z
    .string()
    .optional()
    .describe('The file or directory, under /memories (all commands but rename)'),
  view_range: z
    .array(z.number().int())
    .length(2)
    .optional()
    .describe('view: the first and last line to show, -1 for the end'),
  file_text: z.string().optional().describe('create: the text of the new file'),
  old_str: z.string().optional().describe('str_replace: the text to replace, found once'),
  new_str: z.string().optional().describe('str_replace: the text to put in its place'),
  insert_line: z
    .number()
    .int()
    .optional()
    .describe('insert: the line to insert after, 0 for the start'),
  insert_text: z.string().optional().describe('insert: the text to insert'),
  old_path: z.string().optional().describe('rename: the file or directory to rename'),
  new_path: z.string().optional().describe('rename: its new path'),
});

export type MemoryFileToolParams = z.infer<typeof memoryParams>;

function required<T>(value: T | undefined, field: string, command: string): T {
  if (value === undefined) throw new Error(`The ${command} command needs \`${field}\``);
  return value;
}

/** A call of the tool as the command it names, its fields checked */
export function memoryFileCommand(params: MemoryFileToolParams): MemoryFileCommand {
  const { command } = params;
  switch (command) {
    case 'view':
      return {
        command,
        path: required(params.path, 'path', command),
        ...(params.view_range && { view_range: params.view_range }),
      };
    case 'create':
      return {
        command,
        path: required(params.path, 'path', command),
        file_text: required(params.file_text, 'file_text', command),
      };
    case 'str_replace':
      return {
        command,
        path: required(params.path, 'path', command),
        old_str: required(params.old_str, 'old_str', command),
        new_str: required(params.new_str, 'new_str', command),
      };
    case 'insert':
      return {
        command,
        path: required(params.path, 'path', command),
        insert_line: required(params.insert_line, 'insert_line', command),
        insert_text: required(params.insert_text, 'insert_text', command),
      };
    case 'delete':
      return { command, path: required(params.path, 'path', command) };
    case 'rename':
      return {
        command,
        old_path: required(params.old_path, 'old_path', command),
        new_path: required(params.new_path, 'new_path', command),
      };
  }
}

/**
 * Where the memory tool writes a run's files: the run's user (`user`, by default, the thread
 * for a run without one), the agent (`agent`), or the thread (`thread`)
 */
export function memoryFileScope(
  agentId: string,
  scope: 'user' | 'agent' | 'thread' = 'user',
  run: { userId?: string; threadId?: string }
): MemoryItemScope {
  const anonymous = scope === 'user' && run.userId === undefined;
  return {
    agentId,
    ...(scope === 'user' && run.userId !== undefined && { userId: run.userId }),
    ...((scope === 'thread' || anonymous) &&
      run.threadId !== undefined && { threadId: run.threadId }),
  };
}

/** What a run sees of the memory files: its user's, its thread's and the agent's */
export function memoryFileVisibility(
  agentId: string,
  run: { userId?: string; threadId?: string }
): MemoryItemScope {
  return {
    agentId,
    ...(run.userId !== undefined && { userId: run.userId }),
    ...(run.threadId !== undefined && { threadId: run.threadId }),
  };
}

/**
 * The branch of `conversation` as memory files see it: the ids of its entries, and its newest
 * entry, where a write is placed. Undefined for a run outside a conversation.
 */
export async function memoryFilePlace(
  memory: MemoryAdapter,
  conversation: MemoryFilePlaceOfRun | undefined
): Promise<MemoryFilePlace | undefined> {
  if (!conversation) return undefined;
  if (conversation.leafId === null) return { threadId: conversation.threadId, pathIds: new Set() };
  const read = memory.getPath
    ? await memory.getPath({
        threadId: conversation.threadId,
        ...(conversation.leafId !== undefined && { leafId: conversation.leafId }),
      })
    : await memory.getEntries({ threadId: conversation.threadId });
  if (!read.success) {
    throw new Error(`Reading thread ${conversation.threadId} failed: ${read.error}`);
  }
  const newest = read.data.at(-1)?.id;
  return {
    threadId: conversation.threadId,
    pathIds: new Set(read.data.map((entry) => entry.id)),
    ...(newest !== undefined && { entryId: newest }),
  };
}

function filesOf(memory: MemoryAdapter): MemoryFiles {
  if (!isMemoryFileAdapter(memory)) {
    throw new Error(`The ${memory.provider} memory adapter keeps no memory files`);
  }
  return new MemoryFiles({ adapter: memory });
}

/**
 * The memory tool: notes under `/memories` the agent views and edits across conversations, with
 * the commands of Anthropic's memory tool (`view`, `create`, `str_replace`, `insert`, `delete`,
 * `rename`) and their answers. Anthropic models get it as their native `memory_20250818` tool,
 * every other model as a tool with the same commands.
 *
 * Every change is kept as a version (see `MemoryFiles`). A run sees the files of its scope and,
 * in its own thread, only the versions of its branch. An edit of a file another writer changed
 * after the run viewed it fails with a note to view it again.
 */
export function memoryFileTool(
  config: MemoryFileToolConfig
): Tool<MemoryFileToolParams, ToolContentResult> {
  const { memory, agentId, placeOf } = config;
  const files = config.files ?? filesOf(memory);
  const viewed = new Map<string, Map<string, string>>();

  /**
   * The conversation the run may read: the one the runtime names when it names places, none when
   * it names none for the run (a run it let into no thread), else the thread of the tool's context
   */
  const conversationOf = (context: BaseToolContext): MemoryFilePlaceOfRun | undefined =>
    placeOf
      ? placeOf(context.runId)
      : context.threadId !== undefined
        ? { threadId: context.threadId }
        : undefined;

  /** Who the run is to memory files: its user, and its thread when it may read one */
  const runOf = (context: BaseToolContext) => {
    const threadId = conversationOf(context)?.threadId;
    return {
      ...(context.userId !== undefined && { userId: context.userId }),
      ...(threadId !== undefined && { threadId }),
    };
  };

  /** Where the run's files go, refused when the run has neither a user nor a conversation */
  const scopeOf = (context: BaseToolContext): MemoryItemScope => {
    const run = runOf(context);
    const scope = memoryFileScope(agentId, config.scope, run);
    if (config.scope !== 'agent' && scope.userId === undefined && scope.threadId === undefined) {
      throw new Error('The memory tool needs a run with a user or a conversation');
    }
    return scope;
  };

  /** The branch the run stands on, read from its thread */
  const placeFor = (context: BaseToolContext): Promise<MemoryFilePlace | undefined> =>
    memoryFilePlace(memory, conversationOf(context));

  /** The files the run viewed, by path, the runs used least lately forgotten past the limit */
  const viewedBy = (runId: string): Map<string, string> => {
    const paths = viewed.get(runId) ?? new Map<string, string>();
    viewed.delete(runId);
    viewed.set(runId, paths);
    if (viewed.size > RUNS_REMEMBERED) {
      const oldest = viewed.keys().next().value;
      if (oldest !== undefined) viewed.delete(oldest);
    }
    return paths;
  };

  return tool({
    name: MEMORY_FILE_TOOL,
    description:
      'Your memory directory, /memories, kept across conversations. Before you start a task, view ' +
      '/memories to see what you noted earlier. Record what you learn that will matter later, such ' +
      'as decisions, progress and what the user prefers, and keep the notes tidy: edit and remove ' +
      'what no longer holds. Commands: view (a directory or a file, with view_range), create (a new ' +
      'file), str_replace (old_str found once), insert (insert_text after insert_line, 0 for the ' +
      'start), delete, rename (old_path to new_path). Paths start with /memories.',
    parameters: memoryParams,
    providerTypes: { anthropic: 'memory_20250818' },
    maxResultLength: 200_000,
    annotations: { openWorldHint: false },
    execute: async (params, context) =>
      toolContent({ type: 'text', text: await answer(params, context) }),
  });

  async function answer(params: MemoryFileToolParams, context: BaseToolContext): Promise<string> {
    const command = memoryFileCommand(params);
    const place = await placeFor(context);
    const seen = viewedBy(context.runId);
    const access: MemoryFileAccess = {
      scope: scopeOf(context),
      visibleTo: memoryFileVisibility(agentId, runOf(context)),
      ...(place && { place }),
      ...(config.readOnly && { readOnly: true }),
      reserved: MEMORY_RESERVED_PATHS,
      author: 'model',
      observe: (path, sha256) => {
        if (sha256 === null) seen.delete(path);
        else seen.set(path, sha256);
      },
    };
    switch (command.command) {
      case 'str_replace':
        return files.strReplace(
          access,
          command.path,
          command.old_str,
          command.new_str,
          seen.get(memoryPath(command.path))
        );
      case 'insert':
        return files.insert(
          access,
          command.path,
          command.insert_line,
          command.insert_text,
          seen.get(memoryPath(command.path))
        );
      case 'delete':
        return files.delete(access, command.path, seen.get(memoryPath(command.path)));
      case 'rename':
        return files.rename(
          access,
          command.old_path,
          command.new_path,
          seen.get(memoryPath(command.old_path))
        );
      default:
        return files.run(access, command);
    }
  }
}
