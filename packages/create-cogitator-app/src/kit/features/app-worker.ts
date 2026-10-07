import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import type { ProjectBuilder } from '../project.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import { addRedisService, DEFAULT_REDIS_URL } from './memory.js';
import { LIFECYCLE_TS, startupImports, startupStatements } from './shared.js';
import type { FeatureModule } from './types.js';

export const METRICS_PORT = 9464;

const QUEUE_TS = code`
  import { loadConfig } from '@cogitator-ai/config';
  import type { Agent } from '@cogitator-ai/core';
  import { type SerializedAgent, serializeAgent } from '@cogitator-ai/worker';

  /** The Redis the job queue lives in, shared by the worker and the producers. */
  export const redis = { url: process.env.REDIS_URL ?? '${DEFAULT_REDIS_URL}' };

  /**
   * An agent as a job carries it to a worker. Agents of this project take the
   * default model of cogitator.yml, which the job has to name explicitly.
   */
  export function forQueue(agent: Agent): SerializedAgent {
    if (agent.model) return serializeAgent(agent);
    const model = loadConfig().llm?.defaultModel;
    if (!model) throw new Error('Set llm.defaultModel in cogitator.yml or a model on the agent');
    return serializeAgent(agent.clone({ model }));
  }
`;

function workerEntry(project: ProjectBuilder): string {
  return code`
    import { createServer } from 'node:http';
    import { JobQueue, WorkerPool } from '@cogitator-ai/worker';
    import { cogitator } from './cogitator.js';
    import { loadEnv } from './env.js';
    import { onShutdown } from './lifecycle.js';
    import { redis } from './queue.js';
    import { tools } from './tools/index.js';
    ${startupImports(project)}

    const env = loadEnv();
    ${startupStatements(project)}

    /**
     * Runs the agent jobs producers queue in Redis. Serialized agents name their
     * tools, and this worker provides the implementations of the assistant's.
     */
    const pool = new WorkerPool(
      { redis, cogitator, tools, concurrency: Number(env.WORKER_CONCURRENCY ?? 4) },
      {
        onJobStarted: (jobId, type) => console.log(\`\${type} job \${jobId} started\`),
        onJobCompleted: (jobId) => console.log(\`job \${jobId} completed\`),
        onJobFailed: (jobId, error) => console.error(\`job \${jobId} failed: \${error.message}\`),
        onWorkerError: (error) => console.error(\`worker error: \${error.message}\`),
      }
    );
    await pool.start();
    const queue = new JobQueue({ redis });

    /** Prometheus metrics of the pool on /metrics, and /health for probes. */
    const metrics = createServer(async (req, res) => {
      if (req.url === '/health') {
        res.writeHead(pool.isPoolRunning() ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: pool.isPoolRunning() ? 'ok' : 'stopped' }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(pool.metrics.format(await pool.getMetrics(await queue.getMetrics())));
        return;
      }
      res.writeHead(404).end();
    });
    const metricsPort = Number(env.METRICS_PORT ?? ${METRICS_PORT});
    metrics.listen(metricsPort, () => console.log(\`Worker running, metrics on http://localhost:\${metricsPort}/metrics\`));

    onShutdown(async () => {
      await pool.stop(30_000);
      await queue.close();
      await new Promise<void>((resolve) => metrics.close(() => resolve()));
      await cogitator.close();
    }, 40_000);
  `;
}

const ENQUEUE_TS = code`
  import { JobQueue, type JobResult } from '@cogitator-ai/worker';
  import { agents } from './cogitator.js';
  import { forQueue, redis } from './queue.js';

  const FINISHED = new Set(['completed', 'failed']);

  /** Queues a question for the assistant, waits for a worker to answer it and prints the answer. */
  async function main(): Promise<void> {
    const input = process.argv.slice(2).join(' ').trim() || 'What can you do?';
    const queue = new JobQueue({ redis });
    try {
      const job = await queue.addAgentJob(forQueue(agents.assistant), input);
      console.error(\`Queued job \${job.id}, waiting for a worker...\`);

      const deadline = Date.now() + 5 * 60_000;
      while (!FINISHED.has(await queue.getJobState(String(job.id)))) {
        if (Date.now() > deadline) throw new Error('No worker answered within 5 minutes: is one running?');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const done = await queue.getJob(String(job.id));
      if (!done || (await queue.getJobState(String(job.id))) === 'failed') {
        throw new Error(\`The job failed: \${done?.failedReason ?? 'unknown reason'}\`);
      }
      const result: JobResult = done.returnvalue;
      console.log(result.type === 'agent' ? result.output : JSON.stringify(result, null, 2));
    } finally {
      await queue.close();
    }
  }

  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
`;

const WORKER_TEST_TS = code`
  import { processAgentJob } from '@cogitator-ai/worker';
  import { describe, expect, it } from 'vitest';
  import { agents } from '../src/cogitator.js';
  import { forQueue } from '../src/queue.js';
  import { tools } from '../src/tools/index.js';
  import { mockCogitator } from './helpers.js';

  describe('agent jobs', () => {
    it('run the serialized assistant with the worker tools', async () => {
      const { cogitator } = mockCogitator(
        {
          toolCalls: [{ id: 'call-1', name: 'calculator', arguments: { expression: '2 + 2' } }],
          finishReason: 'tool_calls',
        },
        { content: 'It is 4.' }
      );
      try {
        const result = await processAgentJob(
          { type: 'agent', jobId: 'job-1', agentConfig: forQueue(agents.assistant), input: '2 + 2?', threadId: 'thread-1' },
          { cogitator, tools }
        );
        expect(result.output).toBe('It is 4.');
        expect(result.toolCalls.map((call) => call.name)).toEqual(['calculator']);
      } finally {
        await cogitator.close();
      }
    });
  });
`;

/** A queue worker: agent jobs in Redis, run by a BullMQ worker pool with metrics. */
export const appWorkerFeature: FeatureModule = {
  id: 'app:worker',
  applies: (spec) => spec.app === 'worker',
  apply(project) {
    addRedisService(project);
    project
      .dependency('@cogitator-ai/worker', cogitatorVersion('@cogitator-ai/worker'))
      .dependency('ioredis', VERSIONS.ioredis)
      .devDependency('tsx', VERSIONS.tsx)
      .file('src/queue.ts', QUEUE_TS)
      .file('src/lifecycle.ts', LIFECYCLE_TS)
      .file('src/enqueue.ts', ENQUEUE_TS)
      .file('tests/worker.test.ts', WORKER_TEST_TS)
      .script('dev', 'tsx watch --env-file-if-exists=.env src/index.ts')
      .script('build', 'tsc -p tsconfig.build.json')
      .script('start', 'node --env-file-if-exists=.env dist/index.js')
      .script('enqueue', 'tsx --env-file-if-exists=.env src/enqueue.ts')
      .envVar({
        name: 'WORKER_CONCURRENCY',
        description: 'How many jobs the worker runs at once',
        example: '4',
        required: false,
        secret: false,
      })
      .envVar({
        name: 'METRICS_PORT',
        description: 'Port of the Prometheus metrics and health endpoint',
        example: String(METRICS_PORT),
        required: false,
        secret: false,
      });
    project.deploy.kind = 'worker';
  },
  finalize(project) {
    project.file('src/index.ts', workerEntry(project));
    const pm = project.spec.packageManager;
    project.section(
      'Worker',
      code`
        \`src/index.ts\` is a \`WorkerPool\` of \`@cogitator-ai/worker\`: it takes agent, workflow and swarm jobs from the BullMQ queue in Redis (\`REDIS_URL\`) and runs them with the assistant's tools, with Prometheus metrics on \`:${METRICS_PORT}/metrics\`. \`src/enqueue.ts\` is a producer: \`${runScript(pm, 'enqueue', '"your question"')}\` queues a job for the assistant and prints the answer once a worker finished it. Start Redis with \`docker compose up -d redis\` and the worker with \`${runScript(pm, 'dev')}\`.
      `
    );
  },
};
