import { appendFile, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { SubagentMemoryScope, Tool } from '@cogitator-ai/types';
import { tool } from '../tool';

/** The tool a subagent with `memory` keeps its notes with */
export const AGENT_MEMORY = 'agent_memory';

/** The index file of a subagent's memory, read into its prompt */
export const MEMORY_INDEX = 'MEMORY.md';

/** Lines of `MEMORY.md` the prompt gets at most, as in Claude Code */
export const MEMORY_INDEX_LINES = 200;

/** Bytes of `MEMORY.md` the prompt gets at most, as in Claude Code */
export const MEMORY_INDEX_BYTES = 25 * 1024;

/** Largest note the tool reads or writes */
const MAX_NOTE_BYTES = 256 * 1024;

/**
 * The folder of subagent `name`'s memory, where Claude Code keeps it so both share it:
 * `~/.claude/agent-memory/<name>/` for `user` (`CLAUDE_CONFIG_DIR` when set),
 * `<root>/.claude/agent-memory/<name>/` for `project` and `<root>/.claude/agent-memory-local/<name>/`
 * for `local`
 */
export function agentMemoryDir(scope: SubagentMemoryScope, name: string, root: string): string {
  const claude = process.env.CLAUDE_CONFIG_DIR?.trim();
  const base =
    scope === 'user'
      ? join(claude ? resolve(claude) : join(homedir(), '.claude'), 'agent-memory')
      : join(resolve(root), '.claude', scope === 'project' ? 'agent-memory' : 'agent-memory-local');
  const dir = resolve(base, name);
  const under = relative(base, dir);
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(name) ||
    under === '' ||
    under.startsWith('..') ||
    under.includes(sep)
  ) {
    throw new Error(
      `The memory folder of subagent "${name}" would not be its own folder under ${base}`
    );
  }
  return dir;
}

/** The first {@link MEMORY_INDEX_LINES} lines of `path`, at most {@link MEMORY_INDEX_BYTES}, empty when it cannot be read */
async function readIndex(path: string): Promise<string> {
  try {
    const lines = (await readFile(path, 'utf8'))
      .split('\n')
      .slice(0, MEMORY_INDEX_LINES)
      .join('\n');
    return Buffer.byteLength(lines) > MEMORY_INDEX_BYTES
      ? Buffer.from(lines).subarray(0, MEMORY_INDEX_BYTES).toString('utf8')
      : lines;
  } catch {
    return '';
  }
}

/**
 * What a subagent's prompt says about its memory: where it is, how to keep it, and the start of
 * `MEMORY.md` (its first 200 lines or 25 KB)
 */
export async function agentMemorySection(dir: string): Promise<string> {
  const index = await readIndex(join(dir, MEMORY_INDEX));
  return [
    '<agent_memory>',
    `You have a persistent memory folder at ${dir}. It outlives this task: read it for what you learned before, and save what you learn (codepaths, patterns, decisions) with the ${AGENT_MEMORY} tool.`,
    `Keep ${MEMORY_INDEX} as a short index of your notes: only its first ${MEMORY_INDEX_LINES} lines reach your prompt, so move details to other files and curate it when it grows past that.`,
    index.trim() !== ''
      ? `Current ${MEMORY_INDEX}:\n${index.trim()}`
      : `${MEMORY_INDEX} is empty so far.`,
    '</agent_memory>',
  ].join('\n');
}

const MemoryArgs = z.object({
  action: z
    .enum(['list', 'read', 'write', 'append'])
    .describe('list the notes, read one, write (replace) one, or append to one'),
  path: z
    .string()
    .optional()
    .describe(`The note, relative to the memory folder (default ${MEMORY_INDEX})`),
  content: z.string().optional().describe('What to write or append'),
});

/** The tool that reads and writes the notes in `dir`, never outside it */
export function agentMemoryTool(dir: string): Tool {
  const outside = (path: string | undefined) =>
    new Error(`${path ?? MEMORY_INDEX} is outside the memory folder`);
  /**
   * `path` inside `dir`, every step from `dir` down to it a real folder or file, never a symbolic
   * link: checked before anything is created and again after, so no step can lead out
   */
  const inside = async (path: string | undefined, create: boolean): Promise<string> => {
    const target = resolve(dir, path ?? MEMORY_INDEX);
    const under = relative(dir, target);
    if (under === '' || under.startsWith('..') || isAbsolute(under)) throw outside(path);
    const steps = [
      dir,
      ...under.split(sep).map((_, index, all) => join(dir, ...all.slice(0, index + 1))),
    ];
    const check = async () => {
      for (const step of steps) {
        let info;
        try {
          info = await lstat(step);
        } catch {
          return;
        }
        if (info.isSymbolicLink()) throw outside(path);
      }
    };
    await check();
    if (create) {
      await mkdir(dirname(target), { recursive: true });
      await check();
    }
    return target;
  };
  return tool({
    name: AGENT_MEMORY,
    description: `Lists, reads, writes or appends to the notes of your persistent memory folder (${dir})`,
    parameters: MemoryArgs,
    sideEffects: ['filesystem'],
    execute: async ({ action, path, content }) => {
      if (action === 'list') {
        const info = await lstat(dir).catch(() => undefined);
        if (!info) return 'The memory folder is empty';
        if (info.isSymbolicLink()) throw outside(undefined);
        const files: string[] = [];
        const walk = async (folder: string) => {
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            const full = join(folder, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) files.push(relative(dir, full).split(sep).join('/'));
          }
        };
        await walk(dir);
        return files.length > 0 ? files.sort().join('\n') : 'The memory folder is empty';
      }
      const target = await inside(path, action !== 'read');
      if (action === 'read') {
        try {
          const info = await stat(target);
          if (info.size > MAX_NOTE_BYTES)
            return `${path ?? MEMORY_INDEX} is larger than ${MAX_NOTE_BYTES} bytes`;
          return await readFile(target, 'utf8');
        } catch {
          return `${path ?? MEMORY_INDEX} does not exist yet`;
        }
      }
      const text = content ?? '';
      if (Buffer.byteLength(text) > MAX_NOTE_BYTES) {
        throw new Error(`A note may hold at most ${MAX_NOTE_BYTES} bytes`);
      }
      if (action === 'write') await writeFile(target, text);
      else await appendFile(target, text.endsWith('\n') ? text : `${text}\n`);
      return `Saved ${relative(dir, target).split(sep).join('/')}`;
    },
  });
}
