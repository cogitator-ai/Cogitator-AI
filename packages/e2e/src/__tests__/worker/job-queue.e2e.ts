import { describe, it, expect, afterAll } from 'vitest';
import {
  MetricsCollector,
  DurationHistogram,
  formatPrometheusMetrics,
  JobQueue,
  type QueueMetrics,
} from '@cogitator-ai/worker';

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
    expect(output).toContain('cogitator_queue_completed_total 500');
    expect(output).toContain('cogitator_queue_failed_total 12');
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
