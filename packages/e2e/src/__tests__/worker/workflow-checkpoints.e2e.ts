import { describe, it, expect, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { JobQueue, WorkerPool, serializeAgent, type WorkflowJobResult } from '@cogitator-ai/worker';
import { RedisCheckpointStore } from '@cogitator-ai/workflows';
import type { RunOptions, RunResult } from '@cogitator-ai/types';

const redisUrl =
  process.env.TEST_REDIS === 'true'
    ? (process.env.TEST_REDIS_URL ?? 'redis://localhost:6379')
    : undefined;
const describeLive = redisUrl && process.env.GOOGLE_API_KEY ? describe : describe.skip;
const describeRedis = redisUrl ? describe : describe.skip;

const MODEL = 'google/gemini-3.5-flash-lite';

/** A runtime whose reviewer fails its first run, and that counts the runs of every agent */
class FlakyCogitator extends Cogitator {
  readonly runs: string[] = [];
  private failed = false;

  override async run(agent: Agent, options: RunOptions): Promise<RunResult> {
    this.runs.push(agent.name);
    if (agent.name === 'reviewer' && !this.failed) {
      this.failed = true;
      throw new Error('provider down for a moment');
    }
    return super.run(agent, options);
  }
}

describeLive('Worker: workflow jobs on the workflow executor', () => {
  const name = `e2e-workflows-${Date.now()}`;
  const redis = { url: redisUrl! };
  const cogitator = new FlakyCogitator({
    llm: { defaultModel: MODEL, providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
  });
  const queue = new JobQueue({
    name,
    redis,
    defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 200 } },
  });
  const pool = new WorkerPool({ name, redis, cogitator, concurrency: 1 });

  afterAll(async () => {
    await pool.stop(5_000);
    await queue.close();
    await cogitator.close();
    const client = new Redis(redisUrl!);
    const keys = await client.keys(`*${name}*`);
    if (keys.length > 0) await client.del(...keys);
    client.disconnect();
  });

  it(
    'goes on from its checkpoint when a job is retried, adds a job id once and counts its usage',
    { timeout: 120_000 },
    async () => {
      await pool.start();
      const writer = new Agent({
        name: 'writer',
        model: MODEL,
        instructions: 'Answer in one short sentence.',
        temperature: 0,
      });
      const reviewer = new Agent({
        name: 'reviewer',
        model: MODEL,
        instructions: 'Say whether the sentence is polite, in one word.',
        temperature: 0,
      });
      const workflowConfig = {
        id: 'review',
        name: `review-${name}`,
        nodes: [
          {
            id: 'write',
            type: 'agent' as const,
            config: {
              agentConfig: JSON.parse(JSON.stringify(serializeAgent(writer))),
              prompt: 'Greet {{name}}.',
              outputKey: 'greeting',
            },
          },
          {
            id: 'review',
            type: 'agent' as const,
            config: {
              agentConfig: JSON.parse(JSON.stringify(serializeAgent(reviewer))),
              prompt: '{{greeting}}',
              outputKey: 'verdict',
            },
          },
        ],
        edges: [{ from: 'write', to: 'review' }],
      };

      const job = await queue.addWorkflowJob(
        workflowConfig,
        { name: 'Ada' },
        { jobId: `${name}-1` }
      );
      const again = await queue.addWorkflowJob(
        workflowConfig,
        { name: 'Ada' },
        { jobId: `${name}-1` }
      );
      expect(again.id).toBe(job.id);

      let state = await queue.getJobState(job.id!);
      for (
        let waited = 0;
        state !== 'completed' && state !== 'failed' && waited < 100_000;
        waited += 250
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        state = await queue.getJobState(job.id!);
      }
      expect(state).toBe('completed');

      const done = await queue.getJob(job.id!);
      const result = done?.returnvalue as WorkflowJobResult;
      expect(cogitator.runs).toEqual(['writer', 'reviewer', 'reviewer']);
      expect(done?.attemptsMade).toBe(2);
      expect(typeof result.output.greeting).toBe('string');
      expect(typeof result.output.verdict).toBe('string');
      expect(result.usage.runs).toBe(2);
      expect(result.usage.totalTokens).toBeGreaterThan(0);

      const client = new Redis(redisUrl!);
      const store = new RedisCheckpointStore({
        client: {
          get: (key) => client.get(key),
          set: (key, value) => client.set(key, value),
          del: (...keys) => client.del(...keys),
          zadd: (key, score, member) => client.zadd(key, score, member),
          zrange: (key, start, stop) => client.zrange(key, String(start), String(stop)),
          zrem: (key, ...members) => client.zrem(key, ...members),
        },
        keyPrefix: `cogitator:${name}:workflow-checkpoints`,
      });
      expect(await store.list(workflowConfig.name)).toEqual([]);
      client.disconnect();

      const metrics = pool.metrics.format({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        depth: 0,
        workerCount: 0,
      });
      expect(metrics).toMatch(/cogitator_job_tokens_total\{type="workflow"\} [1-9]/);
    }
  );
});

describeRedis('Worker: job ids on a live queue', () => {
  const name = `e2e-job-ids-${Date.now()}`;
  const queue = new JobQueue({ name, redis: { url: redisUrl! } });
  const workflowConfig = { id: 'w', name: 'w', nodes: [], edges: [] };

  afterAll(async () => {
    const client = new Redis(redisUrl!);
    const keys = await client.keys(`*${name}*`);
    if (keys.length > 0) await client.del(...keys);
    client.disconnect();
    await queue.close();
  });

  it('gives both of two racing adds the one job the queue holds', async () => {
    const [first, second] = await Promise.all([
      queue.addWorkflowJob(workflowConfig, { v: 1 }, { jobId: 'race' }),
      queue.addWorkflowJob(workflowConfig, { v: 2 }, { jobId: 'race' }),
    ]);

    expect(first.data.runId).toBe(second.data.runId);
    expect(first.data.input).toEqual(second.data.input);
    expect((await queue.getJob('race'))?.data).toEqual(first.data);
  });

  it('refuses ids that would clash with the keys of the queue', async () => {
    await expect(queue.addWorkflowJob(workflowConfig, {}, { jobId: 'meta' })).rejects.toThrow(
      'a key the queue keeps for itself'
    );
    await expect(
      queue.addAgentJob({ name: 'a', instructions: 'x', model: 'm', tools: [] }, 'hi', {
        jobId: 'race',
      })
    ).rejects.toThrow("holds job 'race' as a workflow job, not as an agent job");
  });
});
