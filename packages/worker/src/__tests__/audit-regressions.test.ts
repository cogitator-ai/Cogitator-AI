import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { JobPayload, JobResult, SwarmAgentJobPayload } from '../types';

const workerInstances: MockWorker[] = [];
const processSwarmAgentJob = vi.fn();
const clusterInstances: MockCluster[] = [];

class MockWorker {
  handlers = new Map<string, (...args: unknown[]) => void>();
  close = vi.fn<(force?: boolean) => Promise<void>>().mockResolvedValue(undefined);
  cancelAllJobs = vi.fn();

  constructor(
    readonly name: string,
    readonly processor: (job: Job<JobPayload>) => Promise<JobResult>,
    readonly options: Record<string, unknown>
  ) {
    workerInstances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
}

class MockCluster {
  status = 'wait';
  disconnect = vi.fn(() => {
    this.status = 'end';
  });
  quit = vi.fn().mockResolvedValue('OK');

  constructor(
    readonly nodes: { host: string; port: number }[],
    readonly options: Record<string, unknown>
  ) {
    clusterInstances.push(this);
  }
}

class MockRedis {
  quit = vi.fn().mockResolvedValue('OK');
  publish = vi.fn().mockResolvedValue(1);
  constructor(readonly options: Record<string, unknown>) {}
}

vi.mock('bullmq', () => ({ Worker: MockWorker, UnrecoverableError: Error }));
vi.mock('ioredis', () => ({ Cluster: MockCluster, Redis: MockRedis }));
vi.mock('../processors/swarm-agent.js', () => ({ processSwarmAgentJob }));

const swarmAgentPayload: SwarmAgentJobPayload = {
  type: 'swarm-agent',
  jobId: 'job_1',
  swarmId: 's',
  agentName: 'a',
  agentConfig: {
    name: 'a',
    instructions: 'x',
    model: 'ollama/qwen2.5:0.5b',
    provider: 'ollama',
    tools: [],
  },
  input: 'go',
  stateKeys: { blackboard: 'b', messages: 'm', results: 'r' },
};

function fakeJob(overrides: Partial<Job<JobPayload>>): Job<JobPayload> {
  return {
    id: 'job_1',
    data: swarmAgentPayload,
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as Job<JobPayload>;
}

describe('WorkerPool', () => {
  beforeEach(() => {
    workerInstances.length = 0;
    clusterInstances.length = 0;
    processSwarmAgentJob.mockReset();
  });

  it('passes the shared runtime, a publisher and the retry state to swarm-agent jobs', async () => {
    const { WorkerPool } = await import('../worker');
    processSwarmAgentJob.mockResolvedValue({ type: 'swarm-agent' });
    const pool = new WorkerPool({ redis: { host: 'redis.local', port: 6380 } });
    await pool.start();

    await workerInstances[0].processor(fakeJob({ attemptsMade: 0 }));
    await workerInstances[0].processor(fakeJob({ attemptsMade: 2 }));

    const [firstPayload, firstOptions] = processSwarmAgentJob.mock.calls[0];
    expect(firstPayload).toBe(swarmAgentPayload);
    expect(firstOptions.isFinalAttempt).toBe(false);
    expect(firstOptions.cogitator).toBeDefined();
    expect((firstOptions.publisher as MockRedis).options).toMatchObject({
      host: 'redis.local',
      port: 6380,
    });
    expect(processSwarmAgentJob.mock.calls[1][1].isFinalAttempt).toBe(true);

    await pool.stop();
    expect((firstOptions.publisher as MockRedis).quit).toHaveBeenCalled();
  });

  it('uses blocking-safe connections for workers', async () => {
    const { WorkerPool } = await import('../worker');
    const pool = new WorkerPool({ redis: { host: 'h', port: 1 } });
    await pool.start();

    expect(workerInstances[0].options.connection).toMatchObject({
      host: 'h',
      port: 1,
      maxRetriesPerRequest: null,
    });
    await pool.stop();
  });

  it('connects to every cluster node and disposes the cluster on stop', async () => {
    const { WorkerPool } = await import('../worker');
    const nodes = [
      { host: 'n1', port: 7000 },
      { host: 'n2', port: 7001 },
    ];
    const pool = new WorkerPool({ redis: { cluster: { nodes }, password: 'pw' } });
    await pool.start();

    expect(workerInstances[0].options.connection).toBe(clusterInstances[0]);
    expect(workerInstances[0].options.prefix).toBe('{cogitator}');
    expect(clusterInstances[0].nodes).toEqual(nodes);
    expect(clusterInstances[0].options).toMatchObject({
      redisOptions: { password: 'pw', maxRetriesPerRequest: null },
    });

    await pool.stop();
    expect(clusterInstances[0].disconnect).toHaveBeenCalled();
  });

  it('records job durations on completion', async () => {
    const { WorkerPool } = await import('../worker');
    const pool = new WorkerPool({ redis: {} });
    await pool.start();

    workerInstances[0].handlers.get('completed')!(
      { id: 'j', data: { type: 'agent', jobId: 'j' }, processedOn: 1000, finishedOn: 3500 },
      { type: 'agent' }
    );

    const output = pool.metrics.format({
      waiting: 0,
      active: 0,
      completed: 1,
      failed: 0,
      delayed: 0,
      depth: 0,
      workerCount: 1,
    });
    expect(output).toContain('cogitator_job_duration_seconds_sum 2.5');
    expect(output).toContain('cogitator_jobs_by_type_total{type="agent"} 1');
    await pool.stop();
  });

  it('force-closes workers when graceful shutdown times out', async () => {
    const { WorkerPool } = await import('../worker');
    const pool = new WorkerPool({ redis: {} });
    await pool.start();
    workerInstances[0].close.mockImplementation((force?: boolean) =>
      force ? Promise.resolve() : new Promise<void>(() => {})
    );

    await pool.stop(20);

    expect(workerInstances[0].close).toHaveBeenCalledWith(true);
    expect(pool.isPoolRunning()).toBe(false);
  });
});

describe('Prometheus label escaping', () => {
  it('escapes quotes, backslashes and newlines in label values', async () => {
    const { formatPrometheusMetrics } = await import('../metrics');
    const output = formatPrometheusMetrics(
      { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0, depth: 1, workerCount: 0 },
      { queue: 'a"b\\c\nd' }
    );

    expect(output).toContain('cogitator_queue_depth{queue="a\\"b\\\\c\\nd"} 1');
  });

  it('rejects invalid label names', async () => {
    const { formatPrometheusMetrics } = await import('../metrics');
    expect(() =>
      formatPrometheusMetrics(
        { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, depth: 0, workerCount: 0 },
        { 'bad-name': 'x' }
      )
    ).toThrow('Invalid Prometheus label name');
  });
});
