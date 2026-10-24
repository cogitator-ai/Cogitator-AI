import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import {
  ABORTED_BEFORE_DISPATCH,
  Agent,
  Cogitator,
  OUTCOME_UNKNOWN,
  tool,
} from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { ErrorCode, type MemoryEntry, type RunCheckpoint } from '@cogitator-ai/types';
import { createTestAgent, createTestCogitator, ollamaSkipReason } from '../../helpers/setup';

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

async function entriesOf(cogitator: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const memory = await cogitator.getMemory();
  const entries = await memory!.getEntries({ threadId, includeToolCalls: true, types: 'all' });
  if (!entries.success) throw new Error(entries.error);
  return entries.data;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describeOllama('Core: run queues, interrupts and cancellation on Ollama', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = createTestCogitator({ memory: true });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it(
    'runs a follow-up queued on the handle once the agent would stop',
    { timeout: 120_000 },
    async () => {
      const agent = createTestAgent({ instructions: 'Answer in one short sentence.' });
      const handle = cogitator.start(agent, { input: 'Name a color.', threadId: 'e2e-follow-up' });
      expect(handle.followUp('Now name an animal.')).toBe(true);

      const result = await handle.result;

      const users = result.messages.filter((message) => message.role === 'user');
      expect(users.at(-1)?.content).toBe('Now name an animal.');
      expect(result.messages.at(-1)?.role).toBe('assistant');
      expect(result.output.length).toBeGreaterThan(0);
      const entries = await entriesOf(cogitator, 'e2e-follow-up');
      expect(entries.filter((entry) => entry.metadata?.queued === 'followUp')).toHaveLength(1);
      expect(handle.steer('too late')).toBe(false);
    }
  );

  it(
    'keeps the streamed part of an aborted answer as an interrupted message',
    { timeout: 120_000 },
    async () => {
      const agent = createTestAgent({ instructions: 'You write long, detailed stories.' });
      const firstToken = deferred();
      const handle = cogitator.start(agent, {
        input: 'Write a long story about a lighthouse keeper, at least 500 words.',
        threadId: 'e2e-partial',
        stream: true,
        onToken: () => firstToken.resolve(),
      });
      await firstToken.promise;
      handle.abort(new Error('stopped by the user'));
      await expect(handle.result).rejects.toThrow('stopped by the user');

      const entries = await entriesOf(cogitator, 'e2e-partial');
      const partial = entries.find((entry) => entry.metadata?.interrupted === true);
      expect(partial?.message.role).toBe('assistant');
      expect(String(partial?.message.content).length).toBeGreaterThan(0);
      expect(entries.at(-1)?.type).toBe('interrupt');
    }
  );

  it(
    'interrupts the run going on in a thread for a newer message',
    { timeout: 120_000 },
    async () => {
      const agent = createTestAgent({ instructions: 'You write long, detailed stories.' });
      const firstToken = deferred();
      const older = cogitator.run(agent, {
        input: 'Write a long story about a sailing ship, at least 500 words.',
        threadId: 'e2e-double-text',
        stream: true,
        onToken: () => firstToken.resolve(),
      });
      await firstToken.promise;
      const stopped = expect(older).rejects.toMatchObject({ code: ErrorCode.RUN_INTERRUPTED });

      const newer = await cogitator.run(createTestAgent(), {
        input: 'Reply with one word: hello.',
        threadId: 'e2e-double-text',
        multitaskStrategy: 'interrupt',
      });

      await stopped;
      expect(newer.status).toBe('completed');
      expect(newer.output.length).toBeGreaterThan(0);
    }
  );
});

describe('Core: interrupts and history repair through the package API', () => {
  const roundTrip = (checkpoint: RunCheckpoint | undefined): RunCheckpoint =>
    JSON.parse(JSON.stringify(checkpoint)) as RunCheckpoint;

  it('pauses on a question a tool asks and resumes with the answer', async () => {
    const asked: unknown[] = [];
    const deploy = tool({
      name: 'deploy',
      description: 'Deploys after the user picks a region',
      parameters: z.object({ service: z.string() }),
      execute: async ({ service }, context) => {
        const { region } = await context.interrupt!({
          reason: 'pick_region',
          message: `Where should ${service} go?`,
          responseSchema: z.object({ region: z.enum(['eu', 'us']) }),
        });
        asked.push(region);
        return `${service} deployed to ${region}`;
      },
    });
    const backend = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [{ id: 'd1', name: 'deploy', arguments: { service: 'api' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Deployed.', finishReason: 'stop' },
    ]);
    const cogitator = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
    });
    const agent = new Agent({
      name: 'ops',
      model: 'mock/m',
      instructions: 'Ops.',
      tools: [deploy],
    });

    const paused = await cogitator.run(agent, { input: 'Deploy the api', threadId: 'e2e-ask' });
    expect(paused.status).toBe('paused');
    expect(paused.interrupts).toEqual([
      expect.objectContaining({ id: 'd1#0', kind: 'input', reason: 'pick_region' }),
    ]);

    await expect(
      cogitator.resume(agent, roundTrip(paused.checkpoint), {
        responses: { 'd1#0': { region: 'mars' } },
      })
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    const done = await cogitator.resume(agent, 'e2e-ask', {
      responses: { 'd1#0': { region: 'eu' } },
    });
    expect(done.status).toBe('completed');
    expect(done.output).toBe('Deployed.');
    expect(asked).toEqual(['eu']);
    const events = (await entriesOf(cogitator, 'e2e-ask')).filter(
      (entry) => entry.type === 'interrupt'
    );
    expect(events.map((entry) => entry.event?.status)).toEqual(['paused', 'resumed']);
    await cogitator.close();
  });

  it('answers calls an aborted run left behind when the thread is read again', async () => {
    const started = deferred();
    const slow = tool({
      name: 'slow',
      description: 'Never returns',
      parameters: z.object({}),
      execute: async () => {
        started.resolve();
        return new Promise<string>(() => undefined);
      },
    });
    const quick = tool({
      name: 'quick',
      description: 'Returns at once',
      parameters: z.object({}),
      execute: async () => 'quick',
    });
    const backend = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [
          { id: 's1', name: 'slow', arguments: {} },
          { id: 'q1', name: 'quick', arguments: {} },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Picked up again.', finishReason: 'stop' },
    ]);
    const cogitator = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
    });
    const agent = new Agent({
      name: 'w',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [slow, quick],
    });
    const controller = new AbortController();
    const run = cogitator.run(agent, {
      input: 'Work',
      threadId: 'e2e-repair',
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(new Error('crash'));
    await expect(run).rejects.toThrow('crash');

    await cogitator.run(agent, { input: 'Where were we?', threadId: 'e2e-repair' });
    const sent =
      backend
        .getCalls()
        .at(-1)
        ?.messages.filter((message) => message.role === 'tool') ?? [];
    expect(sent.map((message) => message.content)).toEqual([
      JSON.stringify({ error: OUTCOME_UNKNOWN }),
      JSON.stringify({ error: ABORTED_BEFORE_DISPATCH }),
    ]);
    await cogitator.close();
  });
});
