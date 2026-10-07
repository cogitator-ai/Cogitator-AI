import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import {
  MetricsCollector,
  DurationHistogram,
  formatPrometheusMetrics,
  JobQueue,
  WorkerPool,
  DistributedSwarmWorker,
  type JobResult,
  type QueueMetrics,
} from '@cogitator-ai/worker';
import { Swarm } from '@cogitator-ai/swarms';
import {
  createTestAgent,
  createTestCogitator,
  createTestTools,
  getTestModel,
  isOllamaRunning,
} from '../../helpers/setup';

const describeRedis = process.env.TEST_REDIS === 'true' ? describe : describe.skip;

describe('Worker: Metrics', () => {
  it('MetricsCollector records job durations', () => {
    const collector = new MetricsCollector();

    collector.recordJob('agent', 1500);
    collector.recordJob('agent', 3000);
    collector.recordJob('workflow', 500);

    const queueMetrics: QueueMetrics = {
      waiting: 5,
      active: 2,
      completed: 100,
      failed: 3,
      delayed: 1,
      depth: 6,
      workerCount: 4,
    };

    const output = collector.format(queueMetrics);
    expect(output).toContain('cogitator_queue_depth');
    expect(output).toContain('cogitator_queue_waiting');
    expect(output).toContain('cogitator_job_duration_seconds');
    expect(output).toContain('cogitator_jobs_by_type_total');
    expect(output).toContain('type="agent"');
    expect(output).toContain('type="workflow"');
  });

  it('DurationHistogram tracks buckets correctly', () => {
    const histogram = new DurationHistogram('test_duration', 'Test duration');

    histogram.observe(0.05);
    histogram.observe(0.3);
    histogram.observe(1.5);
    histogram.observe(15);
    histogram.observe(200);

    const output = histogram.format();
    expect(output).toContain('# TYPE test_duration histogram');
    expect(output).toContain('test_duration_bucket');
    expect(output).toContain('le="0.1"');
    expect(output).toContain('le="+Inf"');
    expect(output).toContain('test_duration_sum');
    expect(output).toContain('test_duration_count');

    const countMatch = /test_duration_count\s+(\d+)/.exec(output);
    expect(countMatch).not.toBeNull();
    expect(parseInt(countMatch![1])).toBe(5);
  });

  it('DurationHistogram reset clears state', () => {
    const histogram = new DurationHistogram('reset_test', 'Reset test');

    histogram.observe(1.0);
    histogram.observe(2.0);
    histogram.reset();

    const output = histogram.format();
    expect(output).toContain('reset_test_count 0');
    expect(output).toContain('reset_test_sum 0');
  });

  it('formatPrometheusMetrics generates valid output', () => {
    const metrics: QueueMetrics = {
      waiting: 10,
      active: 3,
      completed: 500,
      failed: 12,
      delayed: 5,
      depth: 15,
      workerCount: 8,
    };

    const output = formatPrometheusMetrics(metrics);
    expect(output).toContain('cogitator_queue_depth 15');
    expect(output).toContain('cogitator_queue_waiting 10');
    expect(output).toContain('cogitator_queue_active 3');
    expect(output).toContain('cogitator_queue_completed 500');
    expect(output).toContain('cogitator_queue_failed 12');
    expect(output).toContain('cogitator_queue_delayed 5');
    expect(output).toContain('cogitator_workers_total 8');
  });

  it('formatPrometheusMetrics includes labels', () => {
    const metrics: QueueMetrics = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      depth: 0,
      workerCount: 1,
    };

    const output = formatPrometheusMetrics(metrics, { env: 'production', cluster: 'us-east' });
    expect(output).toContain('env="production"');
    expect(output).toContain('cluster="us-east"');
  });
});

describeRedis('Worker: JobQueue', () => {
  let queue: JobQueue;
  const queueName = `e2e-test-${Date.now()}`;

  afterAll(async () => {
    if (queue) {
      try {
        await queue.clean(0, 1000, 'completed');
        await queue.clean(0, 1000, 'failed');
        await queue.clean(0, 1000, 'wait');
      } catch {}
      await queue.close();
    }
  });

  it('JobQueue connects to Redis', async () => {
    queue = new JobQueue({
      name: queueName,
      redis: { host: 'localhost', port: 6379 },
    });

    const metrics = await queue.getMetrics();
    expect(metrics).toBeDefined();
    expect(typeof metrics.waiting).toBe('number');
  });

  it('JobQueue adds and retrieves agent job', async () => {
    const job = await queue.addAgentJob(
      {
        name: 'test-agent',
        instructions: 'test instructions',
        model: 'gpt-4',
        provider: 'openai',
        tools: [],
      },
      'test input'
    );

    expect(job.id).toBeTruthy();

    const retrieved = await queue.getJob(job.id!);
    expect(retrieved).toBeDefined();
    expect(retrieved!.data.type).toBe('agent');
  });

  it('JobQueue tracks job state', async () => {
    const job = await queue.addAgentJob(
      {
        name: 'state-agent',
        instructions: 'test',
        model: 'gpt-4',
        provider: 'openai',
        tools: [],
      },
      'state test'
    );

    const state = await queue.getJobState(job.id!);
    expect(typeof state).toBe('string');
    expect(['waiting', 'active', 'completed', 'failed', 'delayed', 'unknown']).toContain(state);
  });

  it('JobQueue pause/resume cycle', async () => {
    await queue.pause();
    await queue.resume();

    const metrics = await queue.getMetrics();
    expect(metrics).toBeDefined();
  });

  it('JobQueue adds workflow and swarm jobs', async () => {
    const workflowJob = await queue.addWorkflowJob(
      {
        id: 'wf-1',
        name: 'test-workflow',
        nodes: [],
        edges: [],
      },
      { input: 'workflow test' }
    );
    expect(workflowJob.id).toBeTruthy();

    const swarmJob = await queue.addSwarmJob(
      {
        topology: 'sequential',
        agents: [
          { name: 'a1', instructions: 'test', model: 'gpt-4', provider: 'openai', tools: [] },
        ],
      },
      'swarm test'
    );
    expect(swarmJob.id).toBeTruthy();
  });

  it('Queue metrics returns counts', async () => {
    const metrics = await queue.getMetrics();

    expect(typeof metrics.waiting).toBe('number');
    expect(typeof metrics.active).toBe('number');
    expect(typeof metrics.completed).toBe('number');
    expect(typeof metrics.failed).toBe('number');
    expect(typeof metrics.delayed).toBe('number');
    expect(typeof metrics.depth).toBe('number');
  });
});

const describeRedisOllama =
  process.env.TEST_REDIS === 'true' && process.env.TEST_OLLAMA === 'true'
    ? describe
    : describe.skip;

describeRedisOllama('Worker: job processing with Ollama', () => {
  const model = `ollama/${getTestModel()}`;
  const queueName = `e2e-processing-${Date.now()}`;
  const redis = { host: 'localhost', port: 6379 };
  let queue: JobQueue;
  let pool: WorkerPool;
  const completed = new Map<string, JobResult>();
  const failed = new Map<string, Error>();

  const waitForJob = async (jobId: string, timeoutMs = 90_000): Promise<JobResult> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = completed.get(jobId);
      if (result) return result;
      const error = failed.get(jobId);
      if (error) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Job ${jobId} did not finish within ${timeoutMs}ms`);
  };

  beforeAll(async () => {
    if (!(await isOllamaRunning())) throw new Error('Ollama not running');
    queue = new JobQueue({ name: queueName, redis, defaultJobOptions: { attempts: 1 } });
    pool = new WorkerPool(
      {
        name: queueName,
        redis,
        concurrency: 2,
        cogitator: createTestCogitator(),
        tools: [createTestTools().multiply],
      },
      {
        onJobCompleted: (jobId, result) => completed.set(jobId, result),
        onJobFailed: (jobId, error) => failed.set(jobId, error),
      }
    );
    await pool.start();
  });

  afterAll(async () => {
    await pool?.stop(5_000);
    if (queue) {
      try {
        await queue.getQueue().obliterate({ force: true });
      } catch {}
      await queue.close();
    }
  });

  it('runs an agent job with tools registered on the worker', { timeout: 120_000 }, async () => {
    const job = await queue.addAgentJob(
      {
        name: 'calculator',
        instructions: 'Use the multiply tool to compute products. Report only the number.',
        model,
        provider: 'ollama',
        maxIterations: 3,
        tools: [createTestTools().multiply.toJSON()],
      },
      'What is 6 times 7?'
    );

    const result = await waitForJob(job.id!);
    expect(result.type).toBe('agent');
    if (result.type !== 'agent') return;
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.tokenUsage?.total ?? 0).toBeGreaterThan(0);
  });

  it('fails jobs that need tools the worker does not provide', { timeout: 60_000 }, async () => {
    const job = await queue.addAgentJob(
      {
        name: 'deployer',
        instructions: 'Deploy things.',
        model,
        provider: 'ollama',
        tools: [
          {
            name: 'deploy',
            description: 'Deploy the app',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
      'Deploy now'
    );

    await expect(waitForJob(job.id!)).rejects.toThrow(
      'Agent "deployer" needs tools that are not registered here: deploy'
    );
  });

  it('runs a workflow job through agent and transform nodes', { timeout: 120_000 }, async () => {
    const job = await queue.addWorkflowJob(
      {
        id: 'wf-e2e',
        name: 'shout',
        nodes: [
          {
            id: 'reply',
            type: 'agent',
            config: {
              agentConfig: {
                name: 'echo',
                instructions: 'Reply with one short sentence.',
                model,
                provider: 'ollama',
                tools: [],
              },
              prompt: 'Say hello to {{name}}',
              outputKey: 'greeting',
            },
          },
          {
            id: 'loud',
            type: 'transform',
            config: { transform: 'uppercase', inputKey: 'greeting' },
          },
        ],
        edges: [{ from: 'reply', to: 'loud' }],
      },
      { name: 'Ada' }
    );

    const result = await waitForJob(job.id!);
    expect(result.type).toBe('workflow');
    if (result.type !== 'workflow') return;
    const greeting = String(result.output.greeting);
    expect(greeting.length).toBeGreaterThan(0);
    expect(result.output.loud).toBe(greeting.toUpperCase());
  });

  it('runs a sequential swarm job', { timeout: 120_000 }, async () => {
    const job = await queue.addSwarmJob(
      {
        topology: 'sequential',
        agents: [
          { name: 'first', instructions: 'Reply briefly.', model, provider: 'ollama', tools: [] },
          { name: 'second', instructions: 'Reply briefly.', model, provider: 'ollama', tools: [] },
        ],
      },
      'Hello'
    );

    const result = await waitForJob(job.id!);
    expect(result.type).toBe('swarm');
    if (result.type !== 'swarm') return;
    expect(result.agentOutputs.map((o) => o.agent)).toEqual(['first', 'second']);
  });
});

describeRedisOllama('Worker: distributed swarm execution', () => {
  it('executes swarm agent turns on a DistributedSwarmWorker', { timeout: 180_000 }, async () => {
    const keyPrefix = `e2e-swarm-${Date.now()}`;
    const worker = new DistributedSwarmWorker({
      redis: { host: 'localhost', port: 6379 },
      keyPrefix,
      concurrency: 2,
      cogitator: createTestCogitator(),
    });
    await worker.start();

    const swarm = new Swarm(createTestCogitator(), {
      name: 'distributed-e2e',
      strategy: 'pipeline',
      pipeline: {
        stages: [
          {
            name: 'draft',
            agent: createTestAgent({ name: 'drafter', instructions: 'Reply briefly.' }),
          },
          {
            name: 'review',
            agent: createTestAgent({ name: 'reviewer', instructions: 'Reply briefly.' }),
          },
        ],
      },
      distributed: {
        enabled: true,
        timeout: 120_000,
        redis: { host: 'localhost', port: 6379, keyPrefix },
      },
    });

    const events: string[] = [];
    swarm.on('agent:complete', (event) => {
      events.push(event.agentName ?? '');
    });

    try {
      const result = await swarm.run({ input: 'Write one sentence about Redis.' });

      expect(result.agentResults.size).toBe(2);
      expect(String(result.output).length).toBeGreaterThan(0);
      expect(events).toEqual(['drafter', 'reviewer']);
      await vi.waitFor(() => expect(worker.getActiveJobCount()).toBe(0), { timeout: 5_000 });
    } finally {
      await swarm.close();
      await worker.stop();
    }
  });
});
