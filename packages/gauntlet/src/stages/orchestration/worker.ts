import { Agent, tool } from '@cogitator-ai/core';
import { SwarmBuilder } from '@cogitator-ai/swarms';
import type { SwarmEvent } from '@cogitator-ai/types';
import {
  DistributedSwarmWorker,
  JobQueue,
  WorkerPool,
  processAgentJob,
  type AgentJobResult,
  type QueueMetrics,
  type SerializedAgent,
} from '@cogitator-ai/worker';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import {
  CORE,
  SWARMS,
  WORKER,
  excerpt,
  redisEndpoint,
  uniqueName,
  waitFor,
  workerCogitator,
} from './shared.js';

const WIRE_CODE = 'NR-7731';

/** A tool only the worker implements; its code proves the worker resolved and ran it. */
const wireService = tool({
  name: 'wire_service',
  description: 'The latest wire-service item on a topic, with its embargo code.',
  parameters: z.object({ topic: z.string().describe('The topic to look up') }),
  execute: async ({ topic }) => ({
    topic,
    item: 'Officials confirmed the timetable on Friday.',
    embargoCode: WIRE_CODE,
  }),
});

/** Referenced by jobs but registered on no worker. */
const factCheck = tool({
  name: 'fact_check',
  description: 'Checks a claim against the fact-checking desk.',
  parameters: z.object({ claim: z.string() }),
  execute: async ({ claim }) => ({ claim, verdict: 'unverified' }),
});

/**
 * A job queue on the gauntlet Redis with a name no other run uses, emptied and closed when
 * the run ends. Jobs are kept after they finish so the checks can read them back.
 */
function newsroomQueue(ctx: StageContext, attempts: number): { queue: JobQueue; name: string } {
  const name = uniqueName('queue');
  const queue = new JobQueue({
    name,
    redis: redisEndpoint(ctx.services.redis),
    defaultJobOptions: {
      attempts,
      backoff: { type: 'fixed', delay: 200 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  ctx.onCleanup(async () => {
    await queue.getQueue().obliterate({ force: true });
    await queue.close();
  });
  return { queue, name };
}

function isAgentJobResult(value: unknown): value is AgentJobResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'agent' &&
    'output' in value &&
    typeof value.output === 'string'
  );
}

function wireReporter(model: string): SerializedAgent {
  return {
    name: 'wire-reporter',
    instructions:
      'You turn wire-service items into one-sentence news flashes. Always call wire_service first, and end the flash with its embargo code in square brackets.',
    model,
    provider: 'openai',
    maxIterations: 3,
    tools: [wireService.toJSON()],
  };
}

/** An agent job goes through BullMQ on Redis to a worker pool and its result comes back. */
const workerQueue: StageDefinition = {
  id: 'worker-queue',
  title: 'Worker: agent job through the queue',
  description:
    'An agent job is enqueued in BullMQ on Redis, a worker pool picks it up, runs the agent with a worker-side tool and stores the result.',
  packages: [WORKER, CORE],
  needs: ['handshake'],
  requires: [{ kind: 'service', name: 'redis' }],
  timeoutMs: 180_000,
  async run(ctx) {
    const { queue, name } = newsroomQueue(ctx, 2);
    const reporter = wireReporter(ctx.models[2] ?? ctx.model);
    const input = 'Write a news flash about the new night-train timetable.';

    const job = await ctx.check(
      'the job waits in the queue until a worker starts',
      async (evidence) => {
        const added = await queue.addAgentJob(reporter, input, { metadata: { desk: 'wire' } });
        const state = await queue.getJobState(added.id ?? '');
        const metrics = await queue.getMetrics();
        evidence('queue', name);
        evidence('jobId', added.id);
        evidence('state', state);
        evidence('metrics', metrics);
        if (state !== 'waiting') throw new Error(`Expected the job to wait, it is ${state}`);
        if (metrics.waiting !== 1 || metrics.workerCount !== 0) {
          throw new Error('Queue metrics do not show one waiting job and no workers');
        }
        return added;
      }
    );
    const jobId = job.id ?? '';

    const started: string[] = [];
    const completed: string[] = [];
    const failures: string[] = [];
    const pool = new WorkerPool(
      {
        name,
        redis: redisEndpoint(ctx.services.redis),
        concurrency: 1,
        cogitator: workerCogitator(ctx),
        tools: [wireService],
      },
      {
        onJobStarted: (id, type) => started.push(`${id}:${type}`),
        onJobCompleted: (id) => completed.push(id),
        onJobFailed: (id, error) => failures.push(`${id}: ${error.message}`),
        onWorkerError: (error) => ctx.log(`worker error: ${error.message}`),
      }
    );
    ctx.onCleanup(() => pool.stop(5_000));

    await ctx.check('the job moves from waiting to active to completed', async (evidence) => {
      await pool.start();
      const states = ['waiting'];
      const final = await waitFor(
        'the job to finish',
        async () => {
          const state = await queue.getJobState(jobId);
          if (state !== states[states.length - 1]) states.push(state);
          return state === 'completed' || state === 'failed' ? state : undefined;
        },
        { timeoutMs: 150_000, intervalMs: 100, signal: ctx.signal }
      );
      if (final === 'completed') {
        await waitFor('the pool completion event', () => completed.includes(jobId) || undefined, {
          timeoutMs: 5_000,
          intervalMs: 50,
          signal: ctx.signal,
        }).catch(() => undefined);
      }
      evidence('states', states);
      evidence('poolEvents', {
        started: [...started],
        completed: [...completed],
        failures: [...failures],
      });
      if (final !== 'completed') throw new Error(`Job ${final}: ${failures.join(' | ')}`);
      if (!states.includes('active')) throw new Error('The job was never seen active');
      if (!started.includes(`${jobId}:agent`) || !completed.includes(jobId)) {
        throw new Error('The pool did not report the job start and completion');
      }
    });

    await ctx.check('the worker ran the tool and stored the result', async (evidence) => {
      const stored = await queue.getJob(jobId);
      const result: unknown = stored?.returnvalue;
      if (!isAgentJobResult(result)) throw new Error('The job has no agent result');
      const wire = result.toolCalls.find((call) => call.name === 'wire_service');
      const output = wire?.output;
      evidence(
        'toolCalls',
        result.toolCalls.map((call) => call.name)
      );
      evidence('tokens', result.tokenUsage?.total);
      evidence('flash', excerpt(result.output, 240));
      evidence('flashHasCode', result.output.includes(WIRE_CODE));
      if (!wire) throw new Error('The agent did not call wire_service on the worker');
      if (
        typeof output !== 'object' ||
        output === null ||
        !('embargoCode' in output) ||
        output.embargoCode !== WIRE_CODE
      ) {
        throw new Error(`The tool output did not come back: ${JSON.stringify(output)}`);
      }
      if (!result.output.trim()) throw new Error('The flash is empty');
      if (!result.tokenUsage || result.tokenUsage.total <= 0)
        throw new Error('No token usage reported');
    });

    await ctx.check('the pool exports job metrics', async (evidence) => {
      const metrics: QueueMetrics = await queue.getMetrics();
      const text = pool.metrics.format(metrics);
      const byType = /cogitator_jobs_by_type_total\{[^}]*type="agent"[^}]*\} (\d+)/.exec(text)?.[1];
      evidence('completed', metrics.completed);
      evidence('jobsByType', byType);
      if (metrics.completed !== 1)
        throw new Error(`Queue reports ${metrics.completed} completed jobs`);
      if (byType !== '1')
        throw new Error('cogitator_jobs_by_type_total does not count the agent job');
      if (!text.includes('cogitator_job_duration_seconds'))
        throw new Error('No job duration histogram');
    });

    await ctx.check('a serialized agent keeps its custom backend', async (evidence) => {
      evidence('model', reporter.model);
      evidence('provider', reporter.provider);
      try {
        const result = await processAgentJob(
          {
            type: 'agent',
            jobId: uniqueName('direct'),
            threadId: uniqueName('thread'),
            agentConfig: { ...reporter, tools: [] },
            input: 'Reply with the single word READY.',
          },
          { cogitator: ctx.cogitator }
        );
        evidence('output', excerpt(result.output));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `A worker whose Cogitator has the "openrouter" backend cannot run model "${reporter.model}": ${message}`,
          { cause: error }
        );
      }
    });
  },
};

/** Failing jobs, retries and the queue metrics an autoscaler reads, without a model. */
const workerFailures: StageDefinition = {
  id: 'worker-failures',
  title: 'Worker: retries, failures and queue depth',
  description:
    'Jobs that need a tool no worker has fail after their retries, the pool exports the failures, and queued jobs show up in the queue depth.',
  packages: [WORKER],
  requires: [{ kind: 'service', name: 'redis' }],
  timeoutMs: 60_000,
  async run(ctx) {
    const { queue, name } = newsroomQueue(ctx, 2);
    const checker: SerializedAgent = {
      name: 'fact-checker',
      instructions: 'You check claims.',
      model: ctx.model,
      provider: 'openai',
      tools: [factCheck.toJSON()],
    };

    const urgent = await queue.addAgentJob(checker, 'Check: trains run at night.', { priority: 1 });
    const routine = await queue.addAgentJob(checker, 'Check: bees live on roofs.');
    const ids = [urgent.id ?? '', routine.id ?? ''];
    const queued = await queue.getMetrics();
    const queuedStates = await Promise.all(ids.map((id) => queue.getJobState(id)));

    const failures: string[] = [];
    const pool = new WorkerPool(
      { name, redis: redisEndpoint(ctx.services.redis), concurrency: 2, cogitator: ctx.cogitator },
      { onJobFailed: (id, error) => failures.push(`${id}: ${error.message}`) }
    );
    ctx.onCleanup(() => pool.stop(5_000));
    await pool.start();

    await ctx.check('jobs needing a missing tool fail after their retries', async (evidence) => {
      await waitFor(
        'both jobs to fail',
        async () => {
          const states = await Promise.all(ids.map((id) => queue.getJobState(id)));
          return states.every((state) => state === 'failed') ? states : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 100, signal: ctx.signal }
      );
      const jobs = await Promise.all(ids.map((id) => queue.getJob(id)));
      evidence(
        'attempts',
        jobs.map((job) => job?.attemptsMade)
      );
      evidence('reason', excerpt(jobs[0]?.failedReason ?? '', 120));
      evidence('failedEvents', failures.length);
      if (jobs.some((job) => job?.attemptsMade !== 2))
        throw new Error('Jobs were not retried once');
      if (
        !jobs.every((job) =>
          job?.failedReason?.includes('Tools not registered on this worker: fact_check')
        )
      ) {
        throw new Error('The failure does not name the missing tool');
      }
      if (failures.length !== 4)
        throw new Error(`Expected 4 failed attempts, the pool saw ${failures.length}`);
    });

    await ctx.check('final failures reach the Prometheus metrics', async (evidence) => {
      const metrics = await queue.getMetrics();
      const text = pool.metrics.format(metrics);
      const failed = /cogitator_jobs_failed_total\{[^}]*type="agent"[^}]*\} (\d+)/.exec(text)?.[1];
      evidence('queueFailed', metrics.failed);
      evidence('jobsFailedTotal', failed);
      if (metrics.failed !== 2) throw new Error(`Queue reports ${metrics.failed} failed jobs`);
      if (failed !== '2')
        throw new Error('cogitator_jobs_failed_total does not count the two final failures');
    });

    await ctx.check('queued jobs count toward the queue depth', (evidence) => {
      evidence('states', queuedStates);
      evidence('metrics', queued);
      if (queued.depth !== 2) {
        throw new Error(
          `Two jobs were queued (one with a priority) but getMetrics() reports depth ${queued.depth} and waiting ${queued.waiting}: prioritized jobs are not counted`
        );
      }
    });
  },
};

/** A pipeline swarm whose agent turns run on a distributed swarm worker over Redis. */
const workerSwarm: StageDefinition = {
  id: 'worker-swarm',
  title: 'Worker: distributed swarm desk',
  description:
    'A pipeline swarm in distributed mode dispatches each agent turn through Redis to a distributed swarm worker, which runs it and publishes the result back.',
  packages: [SWARMS, WORKER, CORE],
  needs: ['handshake'],
  requires: [{ kind: 'service', name: 'redis' }],
  timeoutMs: 180_000,
  async run(ctx) {
    const redis = redisEndpoint(ctx.services.redis);
    const keyPrefix = uniqueName('swarm');
    const queueName = 'newsroom-turns';

    const writer = new Agent({
      name: 'brief-writer',
      model: ctx.models[2] ?? ctx.model,
      instructions: 'Write a three-sentence news brief on the given subject. Plain text only.',
      maxIterations: 2,
    });
    const copyEditor = new Agent({
      name: 'copy-editor',
      model: ctx.models[1] ?? ctx.model,
      instructions:
        'You copy-edit news briefs: fix grammar and style, keep every fact, and return only the edited brief.',
      maxIterations: 2,
    });
    const swarm = new SwarmBuilder('newsroom-desk')
      .strategy('pipeline')
      .pipeline({
        stages: [
          { name: 'draft', agent: writer },
          { name: 'copyedit', agent: copyEditor },
        ],
      })
      .distributed({
        enabled: true,
        queue: queueName,
        timeout: 90_000,
        redis: { ...redis, keyPrefix },
        cleanupAfter: 0,
      })
      .build(ctx.cogitator);
    let closed = false;
    ctx.onCleanup(async () => {
      if (!closed) await swarm.close();
    });

    const started: string[] = [];
    const turns: string[] = [];
    const failures: string[] = [];
    const worker = new DistributedSwarmWorker(
      { redis, keyPrefix, queue: queueName, concurrency: 2, cogitator: workerCogitator(ctx) },
      {
        onJobStarted: (job) => started.push(job.agentName),
        onJobCompleted: (job) => turns.push(job.agentName),
        onJobFailed: (job, error) => failures.push(`${job.agentName}: ${error.message}`),
        onError: (error) => ctx.log(`swarm worker error: ${error.message}`),
      }
    );
    await worker.start();
    ctx.onCleanup(() => worker.stop());

    const inspector = new Redis({ ...redis, lazyConnect: true });
    ctx.onCleanup(() => inspector.quit().then(() => undefined));
    const stateKeys = () => inspector.keys(`${keyPrefix}:*`);

    const events: SwarmEvent[] = [];
    const unsubscribe = swarm.on('*', (event) => {
      events.push(event);
    });
    const abort = () => swarm.abort();
    ctx.signal.addEventListener('abort', abort, { once: true });

    const result = await ctx.check('every turn runs on the swarm worker', async (evidence) => {
      try {
        const run = await swarm.run({
          input:
            'Subject: the city council approved a night-bus pilot on three routes, starting in November.',
          timeout: 160_000,
          saveHistory: false,
        });
        const agents = [writer.name, copyEditor.name];
        const reported = await waitFor(
          'the worker to report both turns',
          () => (agents.every((agent) => turns.includes(agent)) ? [...turns] : undefined),
          { timeoutMs: 5_000, intervalMs: 50, signal: ctx.signal }
        ).catch(() => [...turns]);
        evidence('distributed', swarm.isDistributed);
        evidence('workerStarted', [...started]);
        evidence('workerCompleted', reported);
        evidence('failures', [...failures]);
        if (!swarm.isDistributed) throw new Error('The swarm is not distributed');
        const missing = agents.filter((agent) => !reported.includes(agent));
        if (missing.length) throw new Error(`No completed worker turn for ${missing.join(', ')}`);
        return run;
      } finally {
        ctx.signal.removeEventListener('abort', abort);
        unsubscribe();
      }
    });

    await ctx.check('both pipeline stages hand their output on', (evidence) => {
      const draft = result.pipelineOutputs?.get('draft');
      const edited = result.pipelineOutputs?.get('copyedit');
      evidence('draft', typeof draft === 'string' ? excerpt(draft) : draft);
      evidence('copyedit', typeof edited === 'string' ? excerpt(edited) : edited);
      evidence(
        'stageEvents',
        events.filter((event) => event.type === 'pipeline:stage:complete').length
      );
      if (typeof draft !== 'string' || !draft.trim())
        throw new Error('The draft stage produced nothing');
      if (typeof edited !== 'string' || !edited.trim())
        throw new Error('The copy-edit stage produced nothing');
      if (result.output !== edited)
        throw new Error('The swarm output is not the last stage output');
    });

    await ctx.check('swarm state lives in Redis and is removed on close', async (evidence) => {
      const before = await stateKeys();
      await swarm.close();
      closed = true;
      const after = await stateKeys();
      evidence('keysBefore', before.length);
      evidence('keysAfter', after);
      if (before.length === 0) throw new Error(`No swarm keys under ${keyPrefix}`);
      if (after.length > 0) throw new Error('Swarm keys remain after close with cleanupAfter 0');
    });
  },
};

export const workerStages: StageDefinition[] = [workerQueue, workerFailures, workerSwarm];
