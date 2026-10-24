import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Cogitator,
  EXIT_PLAN_MODE,
  LocalWorkspace,
  tool,
  workspaceTools,
} from '@cogitator-ai/core';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { MemoryEntry, Message, ToolCall } from '@cogitator-ai/types';
import {
  createTestAgent,
  createTestCogitator,
  getTestModel,
  ollamaSkipReason,
} from '../../helpers/setup';

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (...calls: ToolCall[]): MockChatResponse => ({
  content: '',
  toolCalls: calls,
  finishReason: 'tool_calls',
});

const toolTexts = (messages: readonly Message[]): string[] =>
  messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

async function approvalEntries(cogitator: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const memory = await cogitator.getMemory();
  const entries = await memory!.getEntries({ threadId, types: 'all' });
  if (!entries.success) throw new Error(entries.error);
  return entries.data.filter((entry) => entry.type === 'approval');
}

describe('Core: permission engine with settings files on disk', () => {
  let base: string;
  let root: string;
  let workspace: LocalWorkspace;

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-permissions-')));
    root = join(base, 'repo');
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(echo *)', 'Edit(src/**)'],
          deny: ['Read(.env)', 'Bash(git push *)'],
        },
      })
    );
    workspace = new LocalWorkspace({ root });
    await workspace.start();
  });

  afterEach(async () => {
    await workspace.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  function runtime(responses: MockChatResponse[]) {
    const backend = new MockLLMBackend().setResponses([...responses, { content: 'done' }]);
    const cogitator = new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      memory: { adapter: 'memory' },
      permissions: { settings: { root, userDirs: [join(base, 'home')], managedDirs: [] } },
    });
    const agent = new Agent({
      name: 'repo-agent',
      model: 'mock/m',
      instructions: 'Work in the repository.',
      tools: workspaceTools(),
      workspace,
    });
    return { cogitator, agent, backend };
  }

  it('applies the Claude Code rules of .claude/settings.json and logs each decision', async () => {
    const { cogitator, agent } = runtime([
      turn(
        call('c1', 'run_command', { command: 'echo hello' }),
        call('c2', 'read_file', { path: '.env' }),
        call('c3', 'run_command', { command: 'git push origin main' }),
        call('c4', 'write_file', { path: 'src/new.ts', content: 'export {};\n' })
      ),
    ]);

    const result = await cogitator.run(agent, { input: 'go', threadId: 'e2e-settings' });

    expect(result.status).toBe('completed');
    const texts = toolTexts(result.messages);
    expect(texts[0]).toContain('hello');
    expect(texts[1]).toContain('Permission denied');
    expect(texts[2]).toContain('Permission denied');
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('export {};\n');
    const decisions = (await approvalEntries(cogitator, 'e2e-settings')).map(
      (entry) => entry.event
    );
    expect(decisions).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        decision: 'allow',
        rule: expect.objectContaining({ rule: 'Bash(echo *)', layer: 'project' }),
      }),
      expect.objectContaining({
        toolCallId: 'c2',
        decision: 'deny',
        rule: expect.objectContaining({ rule: 'Read(.env)' }),
      }),
      expect.objectContaining({ toolCallId: 'c3', decision: 'deny' }),
      expect.objectContaining({
        toolCallId: 'c4',
        decision: 'allow',
        rule: expect.objectContaining({ rule: 'Edit(src/**)' }),
      }),
    ]);
    await cogitator.close();
  });

  it('saves "always allow" to .cogitator/settings.local.json and reads it on the next run', async () => {
    const { cogitator, agent } = runtime([
      turn(call('c1', 'run_command', { command: 'ls src' })),
      { content: 'listed' },
      turn(call('c2', 'run_command', { command: 'ls src' })),
    ]);
    const paused = await cogitator.run(agent, { input: 'list', threadId: 'e2e-always' });
    expect(paused.pendingApprovals?.[0]).toMatchObject({ suggestedRule: 'run_command(ls src *)' });

    await cogitator.resume(agent, 'e2e-always', {
      decisions: { c1: { approved: true, remember: { layer: 'local' } } },
    });
    const saved = JSON.parse(readFileSync(join(root, '.cogitator', 'settings.local.json'), 'utf8'));
    expect(saved.permissions.allow).toEqual(['run_command(ls src *)']);

    const second = await cogitator.run(agent, { input: 'again', threadId: 'e2e-always-2' });
    expect(second.status).toBe('completed');
    await cogitator.close();
  });

  it('plans read-only, then carries the approved plan out in acceptEdits mode', async () => {
    const { cogitator, agent } = runtime([
      turn(call('c1', 'write_file', { path: 'src/index.ts', content: 'export const a = 2;\n' })),
      turn(call('c2', EXIT_PLAN_MODE, { plan: 'Set a to 2 in src/index.ts' })),
      turn(call('c3', 'edit_file', { path: 'src/index.ts', oldString: '1', newString: '2' })),
    ]);
    const paused = await cogitator.run(agent, {
      input: 'set a to 2',
      threadId: 'e2e-plan',
      permissions: { mode: 'plan' },
    });
    expect(paused.interrupts?.[0]).toMatchObject({
      kind: 'plan',
      details: { plan: 'Set a to 2 in src/index.ts' },
    });
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const a = 1;\n');

    const done = await cogitator.resume(agent, 'e2e-plan', {
      responses: { [paused.interrupts![0].id]: { approved: true, mode: 'acceptEdits' } },
    });
    expect(done.status).toBe('completed');
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const a = 2;\n');
    await cogitator.close();
  });
});

describeOllama('Core: permissions and budgets on Ollama', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = createTestCogitator({ memory: true });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it(
    'pauses the next run of a session past its token budget and stops it on the answer',
    { timeout: 120_000 },
    async () => {
      const agent = createTestAgent({ instructions: 'Answer in one short sentence.' });
      const budget = { session: { maxTokens: 20 } };
      const first = await cogitator.run(agent, {
        input: 'Name a color.',
        threadId: 'e2e-budget',
        budget,
      });
      expect(first.sessionSpend?.tokens).toBeGreaterThan(20);

      const second = await cogitator.run(agent, {
        input: 'Name a fruit.',
        threadId: 'e2e-budget',
        budget,
      });
      expect(second.status).toBe('paused');
      expect(second.interrupts?.[0]).toMatchObject({ kind: 'budget', id: 'budget:session.tokens' });

      const stopped = await cogitator.resume(agent, 'e2e-budget', {
        budget,
        responses: { 'budget:session.tokens': { action: 'stop' } },
      });
      expect(stopped.status).toBe('completed');
      expect(stopped.budgetStop).toMatchObject({ scope: 'session', metric: 'tokens', limit: 20 });
    }
  );

  it(
    'lets an Ollama classifier decide calls in auto mode, logging its reason',
    { timeout: 180_000 },
    async () => {
      const notify = tool({
        name: 'notify_team',
        description: 'Post a short note to the team channel',
        parameters: z.object({ note: z.string() }),
        requiresApproval: true,
        execute: async ({ note }) => `posted: ${note}`,
      });
      const backend = new MockLLMBackend().setResponses([
        turn(call('c1', 'notify_team', { note: 'The build is green' })),
        { content: 'Posted.' },
      ]);
      const auto = new Cogitator({
        llm: { backends: { mock: backend }, retry: false },
        memory: { adapter: 'memory' },
        permissions: {
          mode: 'auto',
          classifier: { model: `ollama/${getTestModel()}`, timeout: 90_000 },
        },
      });
      const agent = new Agent({
        name: 'notifier',
        model: 'mock/m',
        instructions: 'Notify.',
        tools: [notify],
      });

      const result = await auto.run(agent, {
        input: 'Tell the team the build is green',
        threadId: 'e2e-auto',
        onApproval: () => 'pause',
      });

      const decision = (await approvalEntries(auto, 'e2e-auto'))[0]?.event;
      expect(decision).toBeDefined();
      if (decision?.decidedBy === 'classifier') {
        expect(['allow', 'deny']).toContain(decision.decision);
        expect(typeof decision.reason).toBe('string');
        expect(result.status).toBe('completed');
      } else {
        expect(result.status).toBe('paused');
        expect(result.pendingApprovals?.[0].reason).toContain('classifier failed');
      }
      await auto.close();
    }
  );
});
