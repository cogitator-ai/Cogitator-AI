import { WorkspaceError, type Tool, type ToolContext, type Workspace } from '@cogitator-ai/types';
import { z } from 'zod';
import { tool } from '../tool';
import { globMatcher } from '../workspace/glob';

const DEFAULT_READ_LINES = 2000;
const READ_CHAR_BUDGET = 80_000;
const MAX_LIST_ENTRIES = 1000;
const MAX_GLOB_RESULTS = 1000;
const DEFAULT_GREP_MATCHES = 200;
const MAX_GREP_MATCHES = 2000;
const MAX_GREP_FILES = 5000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_GREP_SCANNED_BYTES = 50 * 1024 * 1024;
const MAX_GREP_LINE_TESTED = 10_000;
const MAX_GREP_LINE_SHOWN = 500;
const BINARY_SNIFF_BYTES = 8192;
const DEFAULT_SKIP_DIRS = ['.git', 'node_modules'];

/** Names of the tools `workspaceTools()` returns. */
export const WORKSPACE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_files',
  'glob',
  'grep',
  'exec',
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export interface WorkspaceToolsOptions {
  /**
   * Which tools must be approved before they run. Default: `exec`, the tool that can do
   * anything a shell can. Return `true` for `write_file` and `edit_file` too to review every
   * change
   */
  requireApproval?: (name: WorkspaceToolName) => boolean;
  /** Directory names `list_files`, `glob` and `grep` do not descend into (default: `.git`, `node_modules`) */
  skipDirs?: readonly string[];
  /** Only these tools, e.g. everything but `exec` for an agent that should not run commands (default: all) */
  tools?: readonly WorkspaceToolName[];
  /** Milliseconds `exec` lets a command run when the call sets none (default: the workspace's timeout) */
  execTimeout?: number;
}

/**
 * Tools that work in a workspace: `read_file` (with line ranges), `write_file`, `edit_file`
 * (exact replacement of a unique string), `list_files`, `glob`, `grep` and `exec`. Each call
 * uses `workspace` when given, else the run's (`context.workspace`, from `RunOptions.workspace`
 * or the agent's `workspace`), and fails with a clear error when there is none. Paths are
 * relative to the workspace root and cannot leave it.
 *
 * @example
 * ```ts
 * const workspace = new LocalWorkspace({ root: './project' });
 * const agent = new Agent({ name: 'coder', instructions: '...', tools: workspaceTools(), workspace });
 * ```
 */
export function workspaceTools(workspace?: Workspace, options: WorkspaceToolsOptions = {}): Tool[] {
  const needsApproval = options.requireApproval ?? ((name) => name === 'exec');
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

  const readFile = tool({
    name: 'read_file',
    description: `Read a text file of the workspace, by line range. Paths are relative to the workspace root. Returns up to ${DEFAULT_READ_LINES} lines from \`offset\` (1-based line number, default 1), and \`nextOffset\` when more lines follow. Use offset and limit to page through long files, such as saved tool results.`,
    parameters: z.object({
      path: z.string().min(1).describe('File path relative to the workspace root'),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('First line to read, 1-based (default: 1)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe(`Number of lines to read (default: ${DEFAULT_READ_LINES})`),
    }),
    category: 'file',
    ...approval('read_file'),
    execute: async ({ path, offset = 1, limit = DEFAULT_READ_LINES }, context) => {
      const ws = resolveWorkspace(context);
      const bytes = await call(() => ws.readBytes(path));
      if (looksBinary(bytes)) throw new Error(`${path} is a binary file`);
      const lines = splitLines(Buffer.from(bytes).toString('utf8'));
      const totalLines = lines.length;
      if (offset > Math.max(totalLines, 1)) {
        throw new Error(`${path} has ${totalLines} lines, offset ${offset} is past the end`);
      }
      const picked: string[] = [];
      let chars = 0;
      for (let i = offset - 1; i < Math.min(totalLines, offset - 1 + limit); i++) {
        const line = lines[i];
        if (picked.length > 0 && chars + line.length + 1 > READ_CHAR_BUDGET) break;
        picked.push(line);
        chars += line.length + 1;
      }
      const endLine = offset - 1 + picked.length;
      return {
        path,
        content: picked.join('\n'),
        startLine: offset,
        endLine,
        totalLines,
        ...(endLine < totalLines && { nextOffset: endLine + 1 }),
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
    sideEffects: ['filesystem'],
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
      'Edit a text file of the workspace by replacing an exact string. `oldString` must appear exactly once (include surrounding lines to make it unique), or set `replaceAll` to replace every occurrence. Read the file first.',
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
    sideEffects: ['filesystem'],
    ...approval('edit_file'),
    execute: async ({ path, oldString, newString, replaceAll = false }, context) => {
      const ws = resolveWorkspace(context);
      if (oldString === newString) throw new Error('oldString and newString are the same');
      const text = await call(() => ws.read(path));
      const count = occurrences(text, oldString);
      if (count === 0) throw new Error(`oldString was not found in ${path}`);
      if (count > 1 && !replaceAll) {
        throw new Error(
          `oldString appears ${count} times in ${path}: add surrounding lines to make it unique, or set replaceAll`
        );
      }
      const updated = replaceAll
        ? text.split(oldString).join(newString)
        : text.replace(oldString, () => newString);
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
    ...approval('list_files'),
    execute: async ({ path = '.', recursive = false, includeHidden = false }, context) => {
      const ws = resolveWorkspace(context);
      const entries = await call(() =>
        ws.list(path, { recursive, includeHidden, skipDirs, limit: MAX_LIST_ENTRIES + 1 })
      );
      return {
        path,
        entries: entries
          .slice(0, MAX_LIST_ENTRIES)
          .map(({ path: entryPath, type, size }) => ({ path: entryPath, type, size })),
        truncated: entries.length > MAX_LIST_ENTRIES,
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
      const files = entries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
      return {
        pattern,
        files: files.slice(0, MAX_GLOB_RESULTS),
        count: files.length,
        truncated: files.length > MAX_GLOB_RESULTS,
      };
    },
  });

  const grep = tool({
    name: 'grep',
    description: `Search the text files of the workspace for a regular expression (JavaScript syntax), line by line. Binary files and files over ${MAX_GREP_FILE_BYTES / 1024} KiB are skipped. Returns matching lines with their file and line number, at most \`maxMatches\` (default ${DEFAULT_GREP_MATCHES}).`,
    parameters: z.object({
      pattern: z.string().min(1).describe('Regular expression to search for'),
      path: z.string().optional().describe('File or directory to search (default: the root)'),
      glob: z
        .string()
        .optional()
        .describe('Only files whose path matches this glob, e.g. "**/*.ts"'),
      ignoreCase: z.boolean().optional().describe('Case-insensitive search (default: false)'),
      maxMatches: z
        .number()
        .int()
        .min(1)
        .max(MAX_GREP_MATCHES)
        .optional()
        .describe(`Stop after this many matches (default: ${DEFAULT_GREP_MATCHES})`),
    }),
    category: 'file',
    ...approval('grep'),
    execute: async (
      {
        pattern,
        path = '.',
        glob: fileGlob,
        ignoreCase = false,
        maxMatches = DEFAULT_GREP_MATCHES,
      },
      context
    ) => {
      const ws = resolveWorkspace(context);
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch (error) {
        throw new Error(
          `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      const target = await call(() => ws.stat(path));
      const matchesGlob = fileGlob ? globMatcher(fileGlob) : undefined;
      const listLimit = MAX_GREP_FILES * 4;
      const listed =
        target.type === 'file'
          ? [{ path: target.path, size: target.size, type: target.type }]
          : await call(() => ws.list(path, { recursive: true, skipDirs, limit: listLimit }));
      const candidates = listed.filter(
        (entry) =>
          entry.type === 'file' &&
          (!matchesGlob || matchesGlob(relativeTo(target.path, entry.path)))
      );

      const matches: { path: string; line: number; text: string }[] = [];
      let filesSearched = 0;
      let skipped = 0;
      let scanned = 0;
      let truncated = listed.length >= listLimit;
      for (let f = 0; f < candidates.length && !truncated; f++) {
        const file = candidates[f];
        if (filesSearched >= MAX_GREP_FILES) {
          truncated = true;
          break;
        }
        if (file.size > MAX_GREP_FILE_BYTES || scanned + file.size > MAX_GREP_SCANNED_BYTES) {
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
        const lines = splitLines(Buffer.from(bytes).toString('utf8'));
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const tested =
            line.length > MAX_GREP_LINE_TESTED ? line.slice(0, MAX_GREP_LINE_TESTED) : line;
          if (!regex.test(tested)) continue;
          if (matches.length >= maxMatches) {
            truncated = true;
            break;
          }
          matches.push({
            path: file.path,
            line: i + 1,
            text:
              line.length > MAX_GREP_LINE_SHOWN ? `${line.slice(0, MAX_GREP_LINE_SHOWN)}...` : line,
          });
        }
      }
      return { pattern, matches, filesSearched, filesSkipped: skipped, truncated };
    },
  });

  const exec = tool({
    name: 'exec',
    description:
      'Run a shell command in the workspace (sh -c), in its current directory or `cwd` (relative to the root). Returns stdout, stderr, the exit code, and whether it timed out or its output was cut.',
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
    }),
    category: 'system',
    sideEffects: ['process', 'filesystem', 'network'],
    ...approval('exec'),
    execute: async ({ command, cwd, timeout }, context) => {
      const ws = resolveWorkspace(context);
      const result = await call(() =>
        ws.exec(command, {
          ...(cwd !== undefined && { cwd }),
          ...((timeout ?? options.execTimeout) !== undefined && {
            timeout: timeout ?? options.execTimeout,
          }),
          signal: context.signal,
        })
      );
      return { command, ...result };
    },
  });

  const all = [readFile, writeFile, editFile, listFiles, glob, grep, exec];
  const wanted = options.tools ? new Set<string>(options.tools) : undefined;
  return wanted ? all.filter((t) => wanted.has(t.name)) : all;
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
