import { describe, it, expect } from 'vitest';

describe('@cogitator-ai/worker', () => {
  it('exports JobQueue', async () => {
    const { JobQueue } = await import('../index');
    expect(JobQueue).toBeDefined();
  }, 15000);

  it('exports WorkerPool', async () => {
    const { WorkerPool } = await import('../index');
    expect(WorkerPool).toBeDefined();
  }, 15000);

  it('exports MetricsCollector', async () => {
    const { MetricsCollector } = await import('../index');
    expect(MetricsCollector).toBeDefined();
  }, 15000);
});
