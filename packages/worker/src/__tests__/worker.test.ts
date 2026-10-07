import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerPool } from '../worker';

const mockWorkerOn = vi.fn<(event: string, handler: (...args: unknown[]) => void) => void>();
const mockWorkerClose = vi.fn();

vi.mock('bullmq', () => {
  class Worker {
    on = mockWorkerOn;
    close = mockWorkerClose;
    cancelAllJobs = vi.fn();
  }
  class UnrecoverableError extends Error {}
  return { Worker, UnrecoverableError };
});

vi.mock('../processors/agent.js', () => ({
  processAgentJob: vi.fn().mockResolvedValue({ success: true, output: 'Agent result' }),
}));

vi.mock('../processors/workflow.js', () => ({
  processWorkflowJob: vi.fn().mockResolvedValue({ success: true, output: {} }),
}));

vi.mock('../processors/swarm.js', () => ({
  processSwarmJob: vi.fn().mockResolvedValue({ success: true, output: 'Swarm result' }),
}));

vi.mock('../processors/swarm-agent.js', () => ({
  processSwarmAgentJob: vi.fn().mockResolvedValue({ success: true, output: 'Agent result' }),
}));

describe('WorkerPool', () => {
  let pool: WorkerPool;

  const defaultConfig = {
    redis: { host: 'localhost', port: 6379 },
    workerCount: 2,
    concurrency: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkerClose.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (pool?.isPoolRunning()) {
      await pool.stop();
    }
  });

  describe('constructor', () => {
    it('creates pool with config', () => {
      pool = new WorkerPool(defaultConfig);

      expect(pool.isPoolRunning()).toBe(false);
      expect(pool.getWorkerCount()).toBe(0);
    });
  });

  describe('start', () => {
    it('starts the specified number of workers', async () => {
      pool = new WorkerPool(defaultConfig);
      await pool.start();

      expect(pool.isPoolRunning()).toBe(true);
      expect(pool.getWorkerCount()).toBe(2);
    });

    it('does not start twice', async () => {
      pool = new WorkerPool(defaultConfig);
      await pool.start();
      await pool.start();

      expect(pool.getWorkerCount()).toBe(2);
    });

    it('registers event handlers on workers', async () => {
      pool = new WorkerPool(defaultConfig);
      await pool.start();

      expect(mockWorkerOn).toHaveBeenCalledWith('completed', expect.any(Function));
      expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
      expect(mockWorkerOn).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('uses default worker count of 1', async () => {
      pool = new WorkerPool({ redis: { host: 'localhost', port: 6379 } });
      await pool.start();

      expect(pool.getWorkerCount()).toBe(1);
    });
  });

  describe('stop', () => {
    it('stops all workers', async () => {
      pool = new WorkerPool(defaultConfig);
      await pool.start();
      await pool.stop();

      expect(pool.isPoolRunning()).toBe(false);
      expect(pool.getWorkerCount()).toBe(0);
      expect(mockWorkerClose).toHaveBeenCalledTimes(2);
    });

    it('does nothing if not running', async () => {
      pool = new WorkerPool(defaultConfig);
      await pool.stop();

      expect(mockWorkerClose).not.toHaveBeenCalled();
    });
  });

  describe('forceStop', () => {
    it('force stops all workers', async () => {
      pool = new WorkerPool(defaultConfig);
      await pool.start();
      await pool.forceStop();

      expect(pool.isPoolRunning()).toBe(false);
      expect(pool.getWorkerCount()).toBe(0);
      expect(mockWorkerClose).toHaveBeenCalledWith(true);
    });
  });

  describe('getMetrics', () => {
    it('returns metrics with worker count', async () => {
      pool = new WorkerPool(defaultConfig);
      await pool.start();

      const metrics = await pool.getMetrics({
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
        delayed: 1,
        depth: 6,
      });

      expect(metrics.workerCount).toBe(2);
      expect(metrics.waiting).toBe(5);
      expect(metrics.active).toBe(2);
    });
  });

  describe('events', () => {
    it('calls onJobStarted callback', async () => {
      const onJobStarted = vi.fn();
      pool = new WorkerPool(defaultConfig, { onJobStarted });
      await pool.start();

      const startedHandler = mockWorkerOn.mock.calls.find((call) => call[0] === 'completed');
      expect(startedHandler).toBeDefined();
    });

    it('calls onJobCompleted callback', async () => {
      const onJobCompleted = vi.fn();
      pool = new WorkerPool(defaultConfig, { onJobCompleted });
      await pool.start();

      const completedCall = mockWorkerOn.mock.calls.find((call) => call[0] === 'completed');
      expect(completedCall).toBeDefined();

      const handler = completedCall![1];
      handler({ id: 'job_123', data: { jobId: 'job_123' } }, { success: true });

      expect(onJobCompleted).toHaveBeenCalledWith('job_123', { success: true });
    });

    it('calls onJobFailed callback', async () => {
      const onJobFailed = vi.fn();
      pool = new WorkerPool(defaultConfig, { onJobFailed });
      await pool.start();

      const failedCall = mockWorkerOn.mock.calls.find((call) => call[0] === 'failed');
      expect(failedCall).toBeDefined();

      const handler = failedCall![1];
      const error = new Error('Job failed');
      handler({ id: 'job_123', data: { jobId: 'job_123' } }, error);

      expect(onJobFailed).toHaveBeenCalledWith('job_123', error);
    });

    it('counts a failed job once its last attempt failed', async () => {
      pool = new WorkerPool(defaultConfig);
      await pool.start();

      const handler = mockWorkerOn.mock.calls.find((call) => call[0] === 'failed')![1];
      const error = new Error('Job failed');
      handler({ id: 'job_1', data: { jobId: 'job_1', type: 'agent' } }, error);
      handler({ id: 'job_1', data: { jobId: 'job_1', type: 'agent' }, finishedOn: 2000 }, error);

      const output = pool.metrics.format({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 1,
        delayed: 0,
        depth: 0,
        workerCount: 2,
      });
      expect(output).toContain('cogitator_jobs_failed_total{type="agent"} 1');
    });

    it('calls onWorkerError callback', async () => {
      const onWorkerError = vi.fn();
      pool = new WorkerPool(defaultConfig, { onWorkerError });
      await pool.start();

      const errorCall = mockWorkerOn.mock.calls.find((call) => call[0] === 'error');
      expect(errorCall).toBeDefined();

      const handler = errorCall![1];
      const error = new Error('Worker error');
      handler(error);

      expect(onWorkerError).toHaveBeenCalledWith(error);
    });
  });

  describe('cluster mode', () => {
    it('configures for Redis cluster', async () => {
      pool = new WorkerPool({
        redis: {
          cluster: {
            nodes: [
              { host: 'node1.example.com', port: 6379 },
              { host: 'node2.example.com', port: 6379 },
            ],
          },
        },
        workerCount: 1,
      });

      await pool.start();

      expect(pool.isPoolRunning()).toBe(true);
    });
  });
});
