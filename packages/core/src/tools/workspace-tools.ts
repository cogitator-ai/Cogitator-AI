import {
  WorkspaceError,
  workspaceGlobMatcher,
  type SandboxHostDecider,
  type Tool,
  type ToolContext,
  type Workspace,
  type WorkspaceEntry,
} from '@cogitator-ai/types';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { tool } from '../tool';
import { fileLockKey } from './path-guard';
import { RegexWorker } from './regex-worker';

const DEFAULT_READ_LINES = 2000;
const READ_CHAR_BUDGET = 80_000;
const MAX_LIST_ENTRIES = 1000;
const MAX_GLOB_RESULTS = 1000;
const DEFAULT_GREP_MATCHES = 200;
const MAX_GREP_MATCHES = 2000;
const MAX_GREP_FILES = 5000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_GREP_SCANNED_BYTES = 50 * 1024 * 1024;
const MAX_GREP_LINE_SHOWN = 500;
const BINARY_SNIFF_BYTES = 8192;
const DEFAULT_GREP_TIMEOUT = 5_000;
const DEFAULT_SKIP_DIRS = ['.git', 'node_modules'];

/** The `read_file` tools `workspaceTools()` made, with the workspace each was bound to (if any). */
const readFileBindings = new WeakMap<Tool, { workspace?: Workspace }>();

/**
 * Which workspace a `read_file` tool reads: `{ workspace }` for one `workspaceTools()` made (its
 * bound workspace, or `undefined` when it reads the run's), `undefined` for any other tool,
 * whose reach cannot be told.
 */
export function readFileBinding(tool: Tool): { workspace?: Workspace } | undefined {
  return readFileBindings.get(tool);
}

/** The workspace and options a tool `workspaceTools(workspace)` made is bound to */
const workspaceBindings = new WeakMap<
  Tool,
  { workspace: Workspace; options: WorkspaceToolsOptions }
>();

/**
 * The same tool as `tool`, which `workspaceTools(from)` made for a workspace `from`, made for
 * `to` instead with the same options. Undefined for any other tool, and for a tool that uses the
 * run's workspace (`workspaceTools()` without one), which follows the run already
 */
export function reboundWorkspaceTool(tool: Tool, from: Workspace, to: Workspace): Tool | undefined {
  const binding = workspaceBindings.get(tool);
  if (binding?.workspace !== from) return undefined;
  const name = tool.name as WorkspaceToolName;
  return binding ? workspaceTools(to, { ...binding.options, tools: [name] })[0] : undefined;
}

/** Names of the tools `workspaceTools()` returns. */
export const WORKSPACE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_files',
  'glob',
  'grep',
  'run_command',
  'delete_file',
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export interface WorkspaceToolsOptions {
  /**
   * Which tools must be approved before they run. Default: `run_command`, the tool that can do
   * anything a shell can. Return `true` for `write_file` and `edit_file` too to review every
   * change
   */
  requireApproval?: (name: WorkspaceToolName) => boolean;
  /** Directory names `list_files`, `glob` and `grep` do not descend into (default: `.git`, `node_modules`) */
  skipDirs?: readonly string[];
  /** Only these tools, e.g. everything but `run_command` for an agent that should not run commands (default: all) */
  tools?: readonly WorkspaceToolName[];
  /** Milliseconds `run_command` lets a command run when the call sets none (default: the workspace's timeout) */
  execTimeout?: number;
  /**
   * Milliseconds `grep` may spend on one file before it stops, so a pattern that backtracks
   * catastrophically fails instead of running on (default: 5000). Matching runs in a worker
   * thread, so it never blocks other runs
   */
  grepTimeout?: number;
}

/** Entries a search or a listing left out because the permission rules refuse or ask for them */
interface Withheld {
  count: number;
  reason: string;
}

const WITHHELD_REASON =
  'The permission rules refuse these entries or ask before they are read, so a search leaves them out. Read one with read_file to ask for it.';

/**
 * Tools that work in a workspace: `read_file` (with line ranges), `write_file`, `edit_file`
 * (exact replacement of a unique string), `list_files`, `glob`, `grep`, `run_command` and
 * `delete_file`, which moves what it deletes to the workspace's trash. Each
 * call uses `workspace` when given, else the run's (`context.workspace`, from
 * `RunOptions.workspace` or the agent's `workspace`), and fails with a clear error when there is
 * none. Paths are relative to the workspace root and cannot leave it. Their names differ from
 * the global `file_read`, `file_write` and `exec` built-in tools, which reach the whole file
 * system, so both sets can be registered side by side.
 *
 * @example
 * ```ts
 * const workspace = new LocalWorkspace({ root: './project' });
 * const agent = new Agent({ name: 'coder', instructions: '...', tools: workspaceTools(), workspace });
 * ```
 */
export function workspaceTools(workspace?: Workspace, options: WorkspaceToolsOptions = {}): Tool[] {
  const needsApproval = options.requireApproval ?? ((name) => name === 'run_command');
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const resolveWorkspace = (context: ToolContext): Workspace => {
    const found = workspace ?? context.workspace;
    if (!found) {
      throw new Error(
        'No workspace: pass one to workspaceTools(), the agent (workspace) or the run (RunOptions.workspace)'
      );
    }
    return found;
  };
  const approval = (name: WorkspaceToolName) =>
    needsApproval(name) ? { requiresApproval: true } : {};
  const bound = (path: string): string =>
    workspace && !isAbsolute(path) ? resolve(workspace.root, path) : path;
  const boundCwd = (cwd: string | undefined): string | undefined =>
    workspace ? resolve(workspace.root, cwd ?? workspace.cwd) : cwd;
  const readable = async <T extends Pick<WorkspaceEntry, 'path'>>(
    ws: Workspace,
    entries: readonly T[],
    context: ToolContext
  ): Promise<{ kept: T[]; withheld?: Withheld }> => {
    const permissions = context.permissions;
    if (!permissions) return { kept: [...entries] };
    const kept: T[] = [];
    for (const entry of entries) {
      if (await permissions.canRead(resolve(ws.root, entry.path))) kept.push(entry);
    }
    const count = entries.length - kept.length;
    return { kept, ...(count > 0 && { withheld: { count, reason: WITHHELD_REASON } }) };
  };
  const lockFile = async (path: string, context: ToolContext): Promise<string[]> => {
    const ws = resolveWorkspace(context);
    return [await fileLockKey(isAbsolute(path) ? path : resolve(ws.root, path))];
  };

  const readFile = tool({
    name: 'read_file',
    description: `Read a text file of the workspace, by line range. Paths are relative to the workspace root. Returns up to ${DEFAULT_READ_LINES} lines from \`offset\` (1-based line number, default 1), at most ${READ_CHAR_BUDGET} characters, and \`nextOffset\` (with \`nextColumn\` inside a very long line) when more follows: call again with them to continue. Lines are shown without their line endings.`,
    parameters: z.object({
      path: z.string().min(1).describe('File path relative to the workspace root'),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('First line to read, 1-based (default: 1)'),
      column: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Character of the first line to start at, 1-based, to continue a long line (default: 1)'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe(`Number of lines to read (default: ${DEFAULT_READ_LINES})`),
    }),
    category: 'file',
    annotations: { readOnlyHint: true },
    access: { kind: 'read', paths: ({ path }) => [bound(path)] },
    isConcurrencySafe: true,
    presentation: ({ path }) => ({ label: 'Read file', icon: 'file-text', detail: path }),
    ...approval('read_file'),
    execute: async ({ path, offset = 1, column = 1, limit = DEFAULT_READ_LINES }, context) => {
      const ws = resolveWorkspace(context);
      const bytes = await call(() => ws.readBytes(path));
      if (looksBinary(bytes)) throw new Error(`${path} is a binary file`);
      const text = Buffer.from(bytes).toString('utf8');
      const lines = splitLines(text);
      const totalLines = lines.length;
      if (offset > Math.max(totalLines, 1)) {
        throw new Error(`${path} has ${totalLines} lines, offset ${offset} is past the end`);
      }
      const first = lines[offset - 1] ?? '';
      if (column > first.length + 1) {
        throw new Error(
          `Line ${offset} of ${path} has ${first.length} characters, column ${column} is past its end`
        );
      }

      const picked: string[] = [];
      let chars = 0;
      let next: { offset: number; column?: number } | undefined;
      const last = Math.min(totalLines, offset - 1 + limit);
      for (let i = offset - 1; i < last; i++) {
        const start = i === offset - 1 ? column - 1 : 0;
        const rest = lines[i].slice(start);
        const room = READ_CHAR_BUDGET - chars - (picked.length > 0 ? 1 : 0);
        if (rest.length <= room) {
          picked.push(rest);
          chars += rest.length + (picked.length > 1 ? 1 : 0);
          continue;
        }
        if (picked.length > 0) {
          next = { offset: i + 1 };
        } else {
          const piece = rest.slice(0, cutAt(rest, room));
          picked.push(piece);
          next = { offset: i + 1, column: start + piece.length + 1 };
        }
        break;
      }
      if (!next && last < totalLines) next = { offset: last + 1 };
      const endings = lineEndings(text);
      return {
        path,
        content: picked.join('\n'),
        startLine: offset,
        ...(column > 1 && { startColumn: column }),
        endLine: offset - 1 + picked.length,
        totalLines,
        ...(next && { nextOffset: next.offset }),
        ...(next?.column !== undefined && { nextColumn: next.column }),
        ...(endings !== 'lf' && { lineEndings: endings }),
      };
    },
  });

  const writeFile = tool({
    name: 'write_file',
    description:
      'Write a text file in the workspace, replacing its content, creating it and its parent directories when missing. Paths are relative to the workspace root.',
    parameters: z.object({
      path: z.string().min(1).describe('File path relative to the workspace root'),
      content: z.string().describe('The whole new content of the file'),
    }),
    category: 'file',
    access: { kind: 'edit', paths: ({ path }) => [bound(path)] },
    sideEffects: ['filesystem'],
    lockKeys: ({ path }, context) => lockFile(path, context),
    presentation: ({ path }) => ({ label: 'Write file', icon: 'file-plus', detail: path }),
    ...approval('write_file'),
    execute: async ({ path, content }, context) => {
      const ws = resolveWorkspace(context);
      const existed = await call(() => ws.exists(path));
      await call(() => ws.write(path, content));
      return { path, bytes: Buffer.byteLength(content), created: !existed };
    },
  });

  const editFile = tool({
    name: 'edit_file',
    description:
      'Edit a text file of the workspace by replacing an exact string. `oldString` must appear exactly once (include surrounding lines to make it unique), or set `replaceAll` to replace every occurrence. Read the file first. In a file with CRLF line endings, write the strings with plain newlines: the CRLF endings are kept. Binary files and files that are not UTF-8 are refused.',
    parameters: z.object({
      path: z.string().min(1).describe('File path relative to the workspace root'),
      oldString: z.string().min(1).describe('The exact text to replace, whitespace included'),
      newString: z.string().describe('The text to put in its place'),
      replaceAll: z
        .boolean()
        .optional()
        .describe('Replace every occurrence instead of requiring exactly one (default: false)'),
    }),
    category: 'file',
    access: { kind: 'edit', paths: ({ path }) => [bound(path)] },
    sideEffects: ['filesystem'],
    lockKeys: ({ path }, context) => lockFile(path, context),
    presentation: ({ path }) => ({ label: 'Edit file', icon: 'file-pen', detail: path }),
    ...approval('edit_file'),
    execute: async ({ path, oldString, newString, replaceAll = false }, context) => {
      const ws = resolveWorkspace(context);
      if (oldString === newString) throw new Error('oldString and newString are the same');
      const bytes = await call(() => ws.readBytes(path));
      if (looksBinary(bytes))
        throw new Error(`${path} is a binary file, edit_file only edits text`);
      let original: string;
      try {
        original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        throw new Error(`${path} is not valid UTF-8, edit_file would corrupt it`, { cause: error });
      }
      const crlf = lineEndings(original) === 'crlf';
      const text = crlf ? original.replace(/\r\n/g, '\n') : original;
      const search = crlf ? oldString.replace(/\r\n/g, '\n') : oldString;
      const replacement = crlf ? newString.replace(/\r\n/g, '\n') : newString;
      const count = occurrences(text, search);
      if (count === 0) throw new Error(`oldString was not found in ${path}`);
      if (count > 1 && !replaceAll) {
        throw new Error(
          `oldString appears ${count} times in ${path}: add surrounding lines to make it unique, or set replaceAll`
        );
      }
      const edited = replaceAll
        ? text.split(search).join(replacement)
        : text.replace(search, () => replacement);
      const updated = crlf ? edited.replace(/\n/g, '\r\n') : edited;
      await call(() => ws.write(path, updated));
      return { path, replacements: replaceAll ? count : 1 };
    },
  });

  const listFiles = tool({
    name: 'list_files',
    description: `List the entries of a workspace directory (the root by default), with type and size. At most ${MAX_LIST_ENTRIES} entries, \`truncated\` says when there were more.`,
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe('Directory relative to the workspace root (default: the root)'),
      recursive: z.boolean().optional().describe('Include subdirectories (default: false)'),
      includeHidden: z
        .boolean()
        .optional()
        .describe('Include entries whose name starts with a dot (default: false)'),
    }),
    category: 'file',
    annotations: { readOnlyHint: true },
    access: { kind: 'read', paths: ({ path }) => [bound(path ?? '.')] },
    isConcurrencySafe: true,
    presentation: ({ path }) => ({ label: 'List files', icon: 'folder', detail: path ?? '.' }),
    ...approval('list_files'),
    execute: async ({ path = '.', recursive = false, includeHidden = false }, context) => {
      const ws = resolveWorkspace(context);
      const { kept: entries, withheld } = await readable(
        ws,
        await call(() =>
          ws.list(path, { recursive, includeHidden, skipDirs, limit: MAX_LIST_ENTRIES + 1 })
        ),
        context
      );
      return {
        path,
        entries: entries
          .slice(0, MAX_LIST_ENTRIES)
          .map(({ path: entryPath, type, size }) => ({ path: entryPath, type, size })),
        truncated: entries.length > MAX_LIST_ENTRIES,
        ...(withheld && { withheld }),
      };
    },
  });

  const glob = tool({
    name: 'glob',
    description: `Find workspace files whose path matches a glob, such as "**/*.ts" or "src/**/*.{ts,tsx}". \`*\` stays within one directory, \`**\` spans any depth. Paths are relative to \`path\` (default: the root). At most ${MAX_GLOB_RESULTS} files.`,
    parameters: z.object({
      pattern: z.string().min(1).describe('Glob pattern, e.g. "**/*.test.ts"'),
      path: z.string().optional().describe('Directory to search in (default: the root)'),
    }),
    category: 'file',
    annotations: { readOnlyHint: true },
    access: { kind: 'read', paths: ({ path }) => [bound(path ?? '.')] },
    isConcurrencySafe: true,
    presentation: ({ pattern }) => ({ label: 'Find files', icon: 'search', detail: pattern }),
    ...approval('glob'),
    execute: async ({ pattern, path = '.' }, context) => {
      const ws = resolveWorkspace(context);
      const entries = await call(() =>
        ws.list(path, {
          recursive: true,
          includeHidden: pattern.split('/').some((part) => part.startsWith('.')),
          glob: pattern,
          skipDirs,
        })
      );
      const { kept, withheld } = await readable(ws, entries, context);
      const files = kept.filter((entry) => entry.type === 'file').map((entry) => entry.path);
      return {
        pattern,
        files: files.slice(0, MAX_GLOB_RESULTS),
        count: files.length,
        truncated: files.length > MAX_GLOB_RESULTS,
        ...(withheld && { withheld }),
      };
    },
  });

  const grep = tool({
    name: 'grep',
    description: `Search the text files of the workspace for a regular expression (JavaScript syntax), line by line. Binary files and files over ${MAX_GREP_FILE_BYTES / 1024} KiB are skipped, and so are hidden files unless \`includeHidden\` is set. Returns matching lines with their file and line number, at most \`maxMatches\` (default ${DEFAULT_GREP_MATCHES}): \`truncated\` says more lines matched, \`incomplete\` that not every file was searched.`,
    parameters: z.object({
      pattern: z.string().min(1).describe('Regular expression to search for'),
      path: z.string().optional().describe('File or directory to search (default: the root)'),
      glob: z
        .string()
        .optional()
        .describe('Only files whose path matches this glob, e.g. "**/*.ts"'),
      ignoreCase: z.boolean().optional().describe('Case-insensitive search (default: false)'),
      includeHidden: z
        .boolean()
        .optional()
        .describe(
          'Also search files and directories whose name starts with a dot (default: false)'
        ),
      maxMatches: z
        .number()
        .int()
        .min(1)
        .max(MAX_GREP_MATCHES)
        .optional()
        .describe(`Stop after this many matches (default: ${DEFAULT_GREP_MATCHES})`),
    }),
    category: 'file',
    annotations: { readOnlyHint: true },
    access: { kind: 'read', paths: ({ path }) => [bound(path ?? '.')] },
    isConcurrencySafe: true,
    presentation: ({ pattern }) => ({
      label: 'Search files',
      icon: 'text-search',
      detail: pattern,
    }),
    ...approval('grep'),
    execute: async (
      {
        pattern,
        path = '.',
        glob: fileGlob,
        ignoreCase = false,
        includeHidden = false,
        maxMatches = DEFAULT_GREP_MATCHES,
      },
      context
    ) => {
      const ws = resolveWorkspace(context);
      const flags = ignoreCase ? 'i' : '';
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        throw new Error(
          `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      const target = await call(() => ws.stat(path));
      const matchesGlob = fileGlob ? workspaceGlobMatcher(fileGlob) : undefined;
      const listLimit = MAX_GREP_FILES * 4;
      const listed: Array<Pick<WorkspaceEntry, 'path' | 'size' | 'type'>> =
        target.type === 'file'
          ? [{ path: target.path, size: target.size, type: target.type }]
          : await call(() =>
              ws.list(path, { recursive: true, includeHidden, skipDirs, limit: listLimit })
            );
      const { kept: readableFiles, withheld } = await readable(ws, listed, context);
      const candidates = readableFiles.filter(
        (entry) =>
          entry.type === 'file' &&
          (!matchesGlob || matchesGlob(relativeTo(target.path, entry.path)))
      );

      const matches: { path: string; line: number; text: string }[] = [];
      let filesSearched = 0;
      let skipped = 0;
      let scanned = 0;
      let truncated = false;
      let incomplete = listed.length >= listLimit;
      const matcher = new RegexWorker({
        pattern,
        flags,
        timeout: options.grepTimeout ?? DEFAULT_GREP_TIMEOUT,
        maxShown: MAX_GREP_LINE_SHOWN,
      });
      const onAbort = () => matcher.stop(new Error('The search was cancelled'));
      context.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for (const file of candidates) {
          if (truncated) break;
          if (filesSearched >= MAX_GREP_FILES || scanned >= MAX_GREP_SCANNED_BYTES) {
            incomplete = true;
            break;
          }
          if (file.size > MAX_GREP_FILE_BYTES) {
            skipped++;
            continue;
          }
          let bytes: Uint8Array;
          try {
            bytes = await ws.readBytes(file.path, { maxBytes: MAX_GREP_FILE_BYTES });
          } catch {
            skipped++;
            continue;
          }
          filesSearched++;
          scanned += bytes.byteLength;
          if (looksBinary(bytes)) {
            skipped++;
            continue;
          }
          const remaining = maxMatches - matches.length;
          const hits = await matcher.match(
            Buffer.from(bytes).toString('utf8'),
            remaining,
            file.path
          );
          for (const hit of hits.slice(0, remaining)) matches.push({ path: file.path, ...hit });
          if (hits.length > remaining) truncated = true;
        }
      } finally {
        context.signal.removeEventListener('abort', onAbort);
        matcher.stop();
      }
      return {
        pattern,
        matches,
        filesSearched,
        filesSkipped: skipped,
        truncated,
        ...(incomplete && { incomplete: true }),
        ...(withheld && { withheld }),
      };
    },
  });

  const runCommand = tool({
    name: 'run_command',
    description:
      'Run a shell command in the workspace (sh -c), in its current directory or `cwd` (relative to the root). Returns stdout, stderr, the exit code, and whether it timed out or its output was cut. In a workspace whose commands run in an OS sandbox, `sandbox` says how it ran and a `<sandbox_violations>` block in stderr names what the sandbox refused (a file outside the writable directories, a host not allowed). Note that `rm` in a command deletes for good: use delete_file to remove files recoverably.',
    parameters: z.object({
      command: z.string().min(1).describe('The shell command to run'),
      cwd: z.string().optional().describe('Directory to run in, relative to the workspace root'),
      timeout: z
        .number()
        .int()
        .min(100)
        .max(600_000)
        .optional()
        .describe('Milliseconds before the command is killed'),
      background: z
        .boolean()
        .optional()
        .describe(
          'Keep processes the command starts in the background (with &) running after it returns, e.g. a dev server. Redirect their output to a file, it is not captured (default: false, they are stopped)'
        ),
      allowedDomains: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe(
          'Sandboxed workspaces only: hosts this command needs to reach (such as registry.npmjs.org, *.pythonhosted.org, an IP with an optional :port), for this command alone. A command that lists hosts is always checked before it runs'
        ),
      dangerouslyDisableSandbox: z
        .boolean()
        .optional()
        .describe(
          'Sandboxed workspaces only: run the command outside the sandbox, after it failed inside because of the sandbox. Honored only when the sandbox policy allows it, and always checked before it runs'
        ),
    }),
    category: 'system',
    sideEffects: ['process', 'filesystem', 'network'],
    presentation: ({ command }) => ({ label: 'Run command', icon: 'terminal', detail: command }),
    ...approval('run_command'),
    access: {
      kind: 'command',
      command: ({ command }) => command,
      cwd: ({ cwd }) => boundCwd(cwd),
    },
    execute: async (
      { command, cwd, timeout, background, allowedDomains, dangerouslyDisableSandbox },
      context
    ) => {
      const ws = resolveWorkspace(context);
      const onUnknownHost = hostDecider(context);
      const result = await call(() =>
        ws.exec(command, {
          ...(cwd !== undefined && { cwd }),
          ...((timeout ?? options.execTimeout) !== undefined && {
            timeout: timeout ?? options.execTimeout,
          }),
          signal: context.signal,
          background: background ? 'keep' : 'kill',
          ...(allowedDomains !== undefined && { allowedDomains }),
          ...(dangerouslyDisableSandbox !== undefined && { dangerouslyDisableSandbox }),
          ...(onUnknownHost && { onUnknownHost }),
        })
      );
      return { command, ...result };
    },
  });

  const deleteFile = tool({
    name: 'delete_file',
    description:
      'Delete a file or a directory of the workspace by moving it to the workspace trash, from where it can be restored. A directory with entries needs `recursive`. Paths are relative to the workspace root.',
    parameters: z.object({
      path: z.string().min(1).describe('File or directory path relative to the workspace root'),
      recursive: z
        .boolean()
        .optional()
        .describe('Delete a directory with everything in it (default: false, only an empty one)'),
    }),
    category: 'file',
    access: {
      kind: 'edit',
      paths: ({ path }) => [bound(path)],
      subtree: ({ recursive }) => recursive === true,
    },
    sideEffects: ['filesystem'],
    lockKeys: ({ path }, context) => lockFile(path, context),
    presentation: ({ path }) => ({ label: 'Delete file', icon: 'trash-2', detail: path }),
    ...approval('delete_file'),
    execute: async ({ path, recursive = false }, context) => {
      const ws = resolveWorkspace(context);
      const removed = await call(() => ws.remove(path, { recursive, trash: true }));
      return { path: removed.path, trashedTo: removed.trashedTo, recoverable: true };
    },
  });

  readFileBindings.set(readFile, workspace ? { workspace } : {});
  const all = [readFile, writeFile, editFile, listFiles, glob, grep, runCommand, deleteFile];
  if (workspace) {
    for (const made of all) workspaceBindings.set(made, { workspace, options });
  }
  const wanted = options.tools ? new Set<string>(options.tools) : undefined;
  return wanted ? all.filter((t) => wanted.has(t.name)) : all;
}

/**
 * How a sandboxed command's connection to a host no sandbox list decides is decided in a run:
 * as a `WebFetch(domain:...)` call by the run's permissions, a person asked through the run's
 * approval decider when the permissions would ask (and the host remembered for the session once
 * allowed). Undefined without permissions, so the workspace's own decider (or a refusal) applies
 */
function hostDecider(context: ToolContext): SandboxHostDecider | undefined {
  const permissions = context.permissions;
  const decideHost = permissions?.decideHost;
  if (!permissions || !decideHost) return undefined;
  return async ({ host, port, command }) => {
    const verdict = await decideHost.call(permissions, host, port);
    if (verdict === 'allow') return true;
    if (verdict === 'deny') return false;
    const ask = context.delegation?.onApproval;
    if (!ask) return false;
    const shown = host.includes(':') ? `[${host}]` : host;
    const answer = await ask({
      toolCallId: `${context.toolCallId ?? 'call'}/network/${shown}:${port}`,
      toolName: 'WebFetch',
      arguments: { url: `https://${shown}:${port}/`, command },
      description: `A sandboxed command connects to ${shown}:${port}, a host the sandbox does not allow by itself`,
      reason: `The command ${command} connects to ${shown}:${port}`,
      suggestedRule: `WebFetch(domain:${host})`,
      mode: permissions.mode,
    });
    if (!answer || answer === 'pause' || !answer.approved) return false;
    permissions.allowHost?.(host);
    return true;
  };
}

/** Runs a workspace operation, its `WorkspaceError` turned into a plain error the model reads. */
async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceError) throw new Error(error.message, { cause: error });
    throw error;
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** How the lines of `text` end: all `\n`, all `\r\n`, or both. */
function lineEndings(text: string): 'lf' | 'crlf' | 'mixed' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const all = (text.match(/\n/g) ?? []).length;
  if (crlf === 0) return 'lf';
  return crlf === all ? 'crlf' : 'mixed';
}

/** Where to cut `text` to at most `max` characters without splitting a surrogate pair. */
function cutAt(text: string, max: number): number {
  const at = Math.max(1, Math.min(max, text.length));
  const code = text.charCodeAt(at - 1);
  return at > 1 && code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

function occurrences(text: string, search: string): number {
  let count = 0;
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + search.length)) {
    count++;
  }
  return count;
}

function relativeTo(dir: string, path: string): string {
  if (dir === '.' || dir === '') return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}
