import { describe, it, expect, afterAll } from 'vitest';
import { z } from 'zod';
import { Cogitator, RedisDurableRunStore, tool } from '@cogitator-ai/core';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { JobQueue, WorkerPool, type JobResult } from '@cogitator-ai/worker';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const describeRedisOllama = describe.skipIf(
  process.env.TEST_REDIS !== 'true' || (await ollamaSkipReason()) !== null
);

const redisUrl = new URL(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379');
const redis = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };

describeRedisOllama('Worker: durable agent jobs on Redis and Ollama', () => {
  const queueName = `e2e-durable-${Date.now()}`;
  const pools: WorkerPool[] = [];
  let queue: JobQueue | undefined;
  let client: RedisClient | undefined;

  afterAll(async () => {
    for (const pool of pools) await pool.forceStop().catch(() => undefined);
    if (queue) {
      await queue
        .getQueue()
        .obliterate({ force: true })
        .catch(() => undefined);
      await queue.close();
    }
    await client?.quit();
  });

  it(
    'go on from the last step on another worker after the first one stopped',
    { timeout: 240_000 },
    async () => {
      client = await createRedisClient({ mode: 'standalone', url: redisUrl.toString() });
      const store = new RedisDurableRunStore({ client, keyPrefix: `${queueName}:durable` });
      let notes = 0;
      let emails = 0;
      let emailStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        emailStarted = resolve;
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
          emailStarted();
          return new Promise<string>(() => undefined);
        },
      });
      const tools = [saveNote, sendEmail];
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
      const timing = { lockDuration: 2_000, stalledInterval: 1_000 };
      const first = new WorkerPool({
        name: queueName,
        redis,
        ...timing,
        durable: true,
        tools,
        cogitator: new Cogitator({
          llm: { backends: { ollama: planned } },
          durable: { store, owner: 'worker-1', enabled: false },
        }),
      });
      pools.push(first);
      queue = new JobQueue({
        name: queueName,
        redis,
        defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 100 } },
      });
      await first.start();
      const job = await queue.addAgentJob(
        {
          name: 'support',
          instructions:
            'You help customers. After tools ran, tell the user in one sentence what happened. Do not call tools again.',
          model: `ollama/${getTestModel()}`,
          provider: 'ollama',
          tools: tools.map((entry) => entry.toJSON()),
        },
        'Note my refund request and email me',
        { threadId: `${queueName}-thread` }
      );
      await started;
      await first.stop(0);

      const results = new Map<string, JobResult>();
      const second = new WorkerPool(
        {
          name: queueName,
          redis,
          ...timing,
          durable: true,
          tools,
          cogitator: new Cogitator({ durable: { store, owner: 'worker-2', enabled: false } }),
        },
        { onJobCompleted: (jobId, result) => results.set(jobId, result) }
      );
      pools.push(second);
      await second.start();
      const deadline = Date.now() + 180_000;
      while (!results.has(job.id!) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const result = results.get(job.id!);
      expect(result?.type).toBe('agent');
      if (result?.type !== 'agent') return;
      expect(result.status).toBe('completed');
      expect(result.output.trim().length).toBeGreaterThan(0);
      expect(notes).toBe(1);
      expect(emails).toBe(1);
      expect(await store.list()).toEqual([]);
    }
  );
});
