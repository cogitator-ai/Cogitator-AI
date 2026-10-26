import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Agent, Cogitator, OUTCOME_UNKNOWN, RedisDurableRunStore, tool } from '@cogitator-ai/core';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { DurableRunRecord, LLMBackend } from '@cogitator-ai/types';
import { ollamaSkipReason } from '../../helpers/setup';

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);
const describeRedis = describe.skipIf(process.env.TEST_REDIS !== 'true');
const MODEL = `ollama/${process.env.TEST_MODEL || 'gpt-oss:20b'}`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-durable-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A runtime on the SQLite file of the test: a process of the host `host-a` */
function processOn(backends?: Record<string, LLMBackend>): Cogitator {
  return new Cogitator({
    llm: { ...(backends && { backends }) },
    memory: { adapter: 'sqlite', sqlite: { path: join(dir, 'memory.db') } },
    durable: { owner: 'host-a' },
  });
}

describeOllama('Core: durable runs on Ollama', () => {
  it(
    'keeps a checkpoint while the run goes on and none once it completed',
    { timeout: 120_000 },
    async () => {
      const cog = processOn();
      const agent = new Agent({
        name: 'brief',
        model: MODEL,
        instructions: 'Answer in one short sentence.',
      });
      let keptDuringRun = 0;

      const result = await cog.run(agent, {
        input: 'Name a planet.',
        threadId: 'e2e-durable-plain',
        middleware: [
          {
            name: 'probe',
            beforeModel: async () => {
              keptDuringRun = (await cog.durableRuns()).length;
            },
          },
        ],
      });

      expect(result.status).toBe('completed');
      expect(result.output.length).toBeGreaterThan(0);
      expect(keptDuringRun).toBe(1);
      expect(await cog.durableRuns()).toEqual([]);
      await cog.close();
    }
  );

  it(
    'recovers a run whose process stopped while a tool ran, and the model finishes it',
    { timeout: 180_000 },
    async () => {
      let notes = 0;
      let emails = 0;
      let emailSent!: () => void;
      const emailStarted = new Promise<void>((resolve) => {
        emailSent = resolve;
      });
      const saveNote = tool({
        name: 'save_note',
        description: 'Save a note about the customer',
        parameters: z.object({ text: z.string() }),
        execute: async () => {
          notes++;
          return 'Note saved';
        },
      });
      const sendEmail = tool({
        name: 'send_email',
        description: 'Email the customer',
        parameters: z.object({ to: z.string() }),
        execute: async () => {
          emails++;
          emailSent();
          return new Promise<string>(() => undefined);
        },
      });
      const agent = new Agent({
        id: 'support-durable',
        name: 'support',
        model: MODEL,
        instructions:
          'You help customers. After tools ran, tell the user in one sentence what happened. Do not call tools again.',
        tools: [saveNote, sendEmail],
      });
      const planned = new MockLLMBackend().setResponses([
        {
          content: '',
          toolCalls: [
            { id: 'n1', name: 'save_note', arguments: { text: 'Wants a refund' } },
            { id: 'e1', name: 'send_email', arguments: { to: 'ada@example.com' } },
          ],
          finishReason: 'tool_calls',
        },
      ]);
      const crashed = processOn({ ollama: planned });
      crashed
        .run(agent, { input: 'Note my refund request and email me', threadId: 'e2e-durable' })
        .catch(() => undefined);
      await emailStarted;
      await crashed.close();

      const recovering = processOn();
      const kept = await recovering.durableRuns();
      expect(kept).toEqual([
        expect.objectContaining({ threadId: 'e2e-durable', agentId: 'support-durable' }),
      ]);
      const { resumed, skipped } = await recovering.recoverRuns({ agents: [agent] });
      expect(skipped).toEqual([]);
      const result = await resumed[0].handle.result;

      expect(result.status).toBe('completed');
      expect(result.output.trim().length).toBeGreaterThan(0);
      expect(notes).toBe(1);
      expect(emails).toBe(1);
      const answers = result.messages.filter((message) => message.role === 'tool');
      expect(answers.find((message) => message.toolCallId === 'n1')?.content).toContain(
        'Note saved'
      );
      expect(answers.find((message) => message.toolCallId === 'e1')?.content).toContain(
        OUTCOME_UNKNOWN
      );
      expect(await recovering.durableRuns()).toEqual([]);
      await recovering.close();
    }
  );
});

describeRedis('Core: durable runs in Redis', () => {
  const prefix = `e2e-durable-${Date.now()}`;
  let client: RedisClient | undefined;

  afterAll(async () => {
    await client?.quit();
  });

  it('holds a run for one owner at a time and keeps the base and the journal', async () => {
    client = await createRedisClient({
      mode: 'standalone',
      url: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379',
    });
    const store = new RedisDurableRunStore({ client, keyPrefix: `{${prefix}}` });
    const ref = { runId: 'r1', threadId: 't1' };
    const one = { owner: 'host', instance: 'one' };
    const two = { owner: 'host', instance: 'two' };
    const record: DurableRunRecord = {
      ...ref,
      agentId: 'a',
      agentName: 'clerk',
      checkpoint: {
        version: 1,
        status: 'running',
        runId: 'r1',
        agentId: 'a',
        threadId: 't1',
        model: 'mock/m',
        input: 'Go',
        messages: [],
        toolCalls: [],
        turn: { toolCalls: [], decisions: {} },
        iterations: 1,
        lastToolCallSignature: '',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        reasoning: [],
        startedAt: 1,
      },
      base: [{ role: 'system', content: 'You help.' }],
      journal: [],
      savedAt: 2,
    };

    expect(await store.save(record, one)).toBe(false);
    expect(await store.acquire(ref, one, 5_000)).toBe(true);
    expect(await store.save(record, one)).toBe(true);
    expect(await store.acquire(ref, two, 5_000)).toBe(false);
    expect(await store.save(record, two)).toBe(false);
    expect(await store.renew(ref, two, 5_000)).toBe(false);
    expect(await store.renew(ref, one, 5_000)).toBe(true);
    await store.append(ref, [{ kind: 'started', toolCallId: 'c1' }], one);
    expect(await store.save({ ...record, base: undefined, journal: [] }, one)).toBe(true);
    await store.append(ref, [{ kind: 'started', toolCallId: 'c2' }], one);
    expect(await store.append(ref, [{ kind: 'started', toolCallId: 'c3' }], two)).toBe(false);

    const loaded = await store.load(ref);
    expect(loaded?.base).toEqual(record.base);
    expect(loaded?.journal).toEqual([{ kind: 'started', toolCallId: 'c2' }]);
    expect(loaded?.lease).toMatchObject({ owner: 'host', instance: 'one' });
    expect((await store.list()).map((run) => run.runId)).toEqual(['r1']);
    expect((await store.list({ threadId: 't1' })).map((run) => run.runId)).toEqual(['r1']);
    expect(await store.list({ threadId: 't2' })).toEqual([]);
    expect(
      await client.eval('return redis.call("TTL", KEYS[1])', 1, `{${prefix}}:run:r1`)
    ).toBeGreaterThan(0);

    expect(await store.acquire(ref, two, 5_000, { replacing: 'one' })).toBe(true);
    expect(await store.renew(ref, one, 5_000)).toBe(false);
    expect(await store.delete(ref, one)).toBe(false);
    expect(await store.delete(ref, two)).toBe(true);
    expect(await store.load(ref)).toBeNull();
    expect(await store.renew(ref, two, 5_000)).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});
