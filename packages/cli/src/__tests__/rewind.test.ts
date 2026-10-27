import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, Cogitator, LocalWorkspace, workspaceTools } from '@cogitator-ai/core';
import type { ChatRequest, ChatResponse, LLMBackend } from '@cogitator-ai/types';
import { createProgram } from '../program.js';
import { UsageError } from '../utils/cli.js';
import { loadRewindProject, runRewind, type RewindIo } from '../commands/rewind.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** A model that writes `app.ts` with the text of the user message, then answers */
const writer: LLMBackend = {
  provider: 'openai',
  chat: async (request: ChatRequest): Promise<ChatResponse> => {
    const last = request.messages.at(-1);
    if (last?.role === 'tool') return { id: 'a', content: 'written', finishReason: 'stop', usage };
    const said = [...request.messages].reverse().find((message) => message.role === 'user');
    return {
      id: 't',
      content: '',
      toolCalls: [
        {
          id: `w${request.messages.length}`,
          name: 'write_file',
          arguments: { path: 'app.ts', content: String(said?.content ?? '') },
        },
      ],
      finishReason: 'tool_calls',
      usage,
    };
  },
  chatStream: async function* () {
    yield { id: 's', delta: {}, finishReason: 'stop' };
  },
};

let base: string;
let workspace: LocalWorkspace;
let cog: Cogitator;
let agent: Agent;
const printed: string[] = [];

function io(answer?: boolean): RewindIo {
  return {
    print: (line) => printed.push(line),
    confirm: async () => answer,
  };
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cli-rewind-')));
  workspace = new LocalWorkspace({ root: join(base, 'project') });
  cog = new Cogitator({
    llm: { backends: { mock: writer } },
    memory: { adapter: 'memory' },
    checkpoints: true,
  });
  agent = new Agent({
    id: 'coder',
    name: 'coder',
    model: 'mock/m',
    instructions: 'Write files.',
    tools: workspaceTools(),
    workspace,
  });
  await cog.run(agent, { input: 'v1', threadId: 'chat' });
  await cog.run(agent, { input: 'v2', threadId: 'chat' });
  printed.length = 0;
});

afterEach(async () => {
  await cog.close();
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

async function firstTurnEnd(): Promise<string> {
  const memory = await cog.getMemory();
  const path = await memory!.getPath!({ threadId: 'chat', types: 'all' });
  if (!path.success) throw new Error(path.error);
  const second = path.data.findIndex((entry) => entry.message.content === 'v2');
  return path.data[second - 1]!.id;
}

const project = () => ({ cogitator: cog, agents: new Map([['coder', agent]]) });

describe('cogitator rewind', () => {
  it('lists the active branch, marking the entries with a file checkpoint', async () => {
    expect(await runRewind(project(), 'chat', undefined, {}, io())).toBe(0);
    expect(printed[0]).toContain('Thread chat');
    expect(
      printed.filter((line) => line.includes('entry_') && line.includes('[files]'))
    ).toHaveLength(2);
  });

  it('shows a dry run and changes nothing', async () => {
    const point = await firstTurnEnd();
    await runRewind(project(), 'chat', point, { files: true, dryRun: true }, io());
    expect(printed.join('\n')).toContain('would leave the active branch');
    expect(printed.join('\n')).toContain('restore app.ts');
    expect(readFileSync(join(workspace.root, 'app.ts'), 'utf8')).toBe('v2');
  });

  it('asks before it rewinds, and does nothing on a no', async () => {
    const point = await firstTurnEnd();
    await runRewind(project(), 'chat', point, { files: true }, io(false));
    expect(printed.at(-1)).toBe('Nothing changed.');
    expect(readFileSync(join(workspace.root, 'app.ts'), 'utf8')).toBe('v2');
    await expect(
      runRewind(project(), 'chat', point, { files: true }, io(undefined))
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('rewinds the conversation and the files once confirmed', async () => {
    const point = await firstTurnEnd();
    await runRewind(project(), 'chat', point, { files: true, yes: true }, io());
    expect(readFileSync(join(workspace.root, 'app.ts'), 'utf8')).toBe('v1');
    const memory = await cog.getMemory();
    const thread = await memory!.getThread('chat');
    expect(thread.success && thread.data?.activeLeafId).toBe(point);
  });

  it('refuses an unknown agent or thread', async () => {
    await expect(
      runRewind(project(), 'chat', undefined, { agent: 'nobody' }, io())
    ).rejects.toBeInstanceOf(UsageError);
    await expect(runRewind(project(), 'missing', undefined, {}, io())).rejects.toThrow(
      'does not exist'
    );
  });

  it('is a command of the CLI', () => {
    const command = createProgram().commands.find((each) => each.name() === 'rewind');
    expect(command?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--files', '--no-memory', '--dry-run', '--yes', '--force'])
    );
  });
});

describe('loadRewindProject', () => {
  const scratch = join(dirname(fileURLToPath(import.meta.url)), '.scratch-rewind');

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('takes the runtime and the agents a registry exports', async () => {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    writeFileSync(join(scratch, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(scratch, 'src', 'cogitator.mjs'),
      `import { Agent, Cogitator } from '@cogitator-ai/core';
export const cogitator = new Cogitator({});
export const agents = { helper: new Agent({ name: 'helper', model: 'mock/m', instructions: 'x' }) };
`
    );
    const loaded = await loadRewindProject(scratch, 'src/cogitator.mjs');
    expect([...loaded.agents.keys()]).toEqual(['helper']);
    await expect(loadRewindProject(scratch, 'src/missing.ts')).rejects.toThrow(
      'Registry not found'
    );
  });
});
