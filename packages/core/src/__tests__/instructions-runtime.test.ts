import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { CogitatorConfig, Message } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';

let base: string;
let root: string;
let workspace: LocalWorkspace;

const write = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'instructions-run-')));
  root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  write('AGENTS.md', 'Use pnpm.');
  write('app/CLAUDE.md', 'The app is in TypeScript.');
  write('app/pkg/AGENTS.md', 'The pkg folder is generated.');
  write('app/pkg/a.txt', 'a');
  write('app/.claude/rules/api.md', '---\npaths:\n  - "api/**"\n---\nAPI handlers validate input.');
  write('app/api/x.ts', 'x');
  workspace = new LocalWorkspace({ root, cwd: 'app' });
  await workspace.start();
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

const askHuman = tool({
  name: 'ask_human',
  description: 'Ask',
  parameters: z.object({}),
  requiresApproval: true,
  execute: async () => 'asked',
});

function setup(responses: MockChatResponse[], config: CogitatorConfig = {}) {
  const backend = new MockLLMBackend().setResponses([...responses, { content: 'done' }]);
  const cog = new Cogitator({
    memory: { adapter: 'memory' },
    ...config,
    llm: { backends: { mock: backend }, retry: false },
  });
  return { cog, backend };
}

const agent = () =>
  new Agent({
    name: 'coder',
    model: 'mock/m',
    instructions: 'You code.',
    tools: [...workspaceTools(), askHuman],
    workspace,
  });

const read = (id: string, path: string): MockChatResponse => ({
  content: '',
  toolCalls: [{ id, name: 'read_file', arguments: { path } }],
  finishReason: 'tool_calls',
});

const systemOf = (messages: readonly Message[] | undefined) => String(messages?.[0]?.content);

describe('project instructions in a run', () => {
  it('reads none unless asked to', async () => {
    const { cog, backend } = setup([]);
    const result = await cog.run(agent(), { input: 'go' });
    expect(systemOf(backend.getCalls()[0]?.messages)).toBe('You code.');
    expect(result.instructions).toBeUndefined();
    await cog.close();
  });

  it('puts the files from the root down to the cwd into the system prompt, and lists them', async () => {
    const { cog, backend } = setup([], { instructions: { projectFiles: true } });
    const result = await cog.run(agent(), { input: 'go', threadId: 't1' });
    const prompt = systemOf(backend.getCalls()[0]?.messages);
    expect(prompt.startsWith('You code.\n\n')).toBe(true);
    expect(prompt.indexOf('Use pnpm.')).toBeLessThan(prompt.indexOf('The app is in TypeScript.'));
    expect(prompt).not.toContain('generated');
    expect(result.instructions?.map((file) => [file.path, file.reason])).toEqual([
      ['AGENTS.md', 'project'],
      ['app/CLAUDE.md', 'project'],
    ]);
    const memory = await cog.getMemory();
    const entries = await memory!.getEntries({ threadId: 't1', types: 'all' });
    const logged = (entries.success ? entries.data : []).filter(
      (entry) => entry.type === 'custom' && entry.event?.kind === 'instructions'
    );
    expect(logged).toHaveLength(1);
    await cog.close();
  });

  it('brings a nested directory file and a scoped rule once a tool reads a file there', async () => {
    const { cog, backend } = setup(
      [read('c1', 'app/pkg/a.txt'), read('c2', 'app/api/x.ts'), read('c3', 'app/pkg/a.txt')],
      { instructions: { projectFiles: true } }
    );
    const result = await cog.run(agent(), { input: 'go' });
    const calls = backend.getCalls();
    const systemTexts = (index: number) =>
      (calls[index]?.messages ?? [])
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n');
    expect(systemTexts(1)).toContain('The pkg folder is generated.');
    expect(systemTexts(2)).toContain('API handlers validate input.');
    expect(systemTexts(3).match(/The pkg folder is generated\./g)).toHaveLength(1);
    expect(result.instructions?.map((file) => [file.path, file.reason])).toEqual([
      ['AGENTS.md', 'project'],
      ['app/CLAUDE.md', 'project'],
      ['app/pkg/AGENTS.md', 'nested'],
      ['app/.claude/rules/api.md', 'scoped'],
    ]);
    await cog.close();
  });

  it('keeps the list of a paused run for its resume', async () => {
    const { cog } = setup(
      [
        {
          content: '',
          toolCalls: [{ id: 'c1', name: 'ask_human', arguments: {} }],
          finishReason: 'tool_calls',
        },
      ],
      { instructions: { projectFiles: true } }
    );
    const paused = await cog.run(agent(), { input: 'go', threadId: 't2' });
    expect(paused.status).toBe('paused');
    expect(paused.checkpoint?.instructions?.map((file) => file.path)).toEqual([
      'AGENTS.md',
      'app/CLAUDE.md',
    ]);
    const resumed = await cog.resume(agent(), paused.checkpoint!, {
      decisions: { c1: { approved: true } },
    });
    expect(resumed.instructions?.map((file) => file.path)).toEqual(['AGENTS.md', 'app/CLAUDE.md']);
    await cog.close();
  });

  it('brings what a call reached before a later call of its step paused the run', async () => {
    const { cog, backend } = setup(
      [
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'read_file', arguments: { path: 'app/pkg/a.txt' } },
            { id: 'c2', name: 'ask_human', arguments: {} },
          ],
          finishReason: 'tool_calls',
        },
      ],
      { instructions: { projectFiles: true } }
    );
    const gate = { name: 'gate', beforeToolCall: () => undefined };
    const paused = await cog.run(agent(), { input: 'go', threadId: 't3', middleware: [gate] });
    expect(paused.status).toBe('paused');
    expect(paused.checkpoint?.context?.join('\n')).toContain('The pkg folder is generated.');
    await cog.resume(agent(), paused.checkpoint!, {
      decisions: { c2: { approved: true } },
      middleware: [gate],
    });
    const next = backend.getCalls()[1]?.messages ?? [];
    expect(
      next
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n')
    ).toContain('The pkg folder is generated.');
    await cog.close();
  });

  it('brings the nested file of another workspace at the same path after a handoff', async () => {
    const otherRoot = join(base, 'other');
    mkdirSync(join(otherRoot, 'app', 'pkg'), { recursive: true });
    writeFileSync(join(otherRoot, 'app', 'pkg', 'AGENTS.md'), 'The other pkg is hand written.');
    writeFileSync(join(otherRoot, 'app', 'pkg', 'a.txt'), 'b');
    const other = new LocalWorkspace({ root: otherRoot, cwd: 'app' });
    await other.start();
    const expert = new Agent({
      name: 'expert',
      model: 'mock/m',
      instructions: 'Expert.',
      tools: workspaceTools(),
      workspace: other,
    });
    const { cog, backend } = setup(
      [
        read('c1', 'app/pkg/a.txt'),
        {
          content: '',
          toolCalls: [{ id: 'h1', name: 'transfer_to_expert', arguments: {} }],
          finishReason: 'tool_calls',
        },
        read('c2', 'app/pkg/a.txt'),
      ],
      { instructions: { projectFiles: true } }
    );
    const lead = new Agent({
      name: 'coder',
      model: 'mock/m',
      instructions: 'You code.',
      tools: workspaceTools(),
      workspace,
      handoffs: [expert],
    });
    await cog.run(lead, { input: 'go' });
    const last = backend.getCalls().at(-1)?.messages ?? [];
    const notes = last
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n');
    expect(notes).toContain('The pkg folder is generated.');
    expect(notes).toContain('The other pkg is hand written.');
    await other.dispose();
    await cog.close();
  });

  it('keeps the size limit across a pause', async () => {
    const { cog } = setup(
      [
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'read_file', arguments: { path: 'app/pkg/a.txt' } },
            { id: 'c2', name: 'ask_human', arguments: {} },
          ],
          finishReason: 'tool_calls',
        },
        read('c3', 'app/api/x.ts'),
      ],
      { instructions: { projectFiles: { maxChars: 62 } } }
    );
    const gate = { name: 'gate', beforeToolCall: () => undefined };
    const paused = await cog.run(agent(), { input: 'go', threadId: 't4', middleware: [gate] });
    expect(paused.checkpoint?.instructions?.map((file) => file.path)).toContain(
      'app/pkg/AGENTS.md'
    );
    const resumed = await cog.resume(agent(), paused.checkpoint!, {
      decisions: { c2: { approved: true } },
      middleware: [gate],
    });
    expect(resumed.instructions?.map((file) => file.path)).not.toContain(
      'app/.claude/rules/api.md'
    );
    await cog.close();
  });
});
