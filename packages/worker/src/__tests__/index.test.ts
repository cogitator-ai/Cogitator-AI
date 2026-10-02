import { describe, it, expect, beforeAll } from 'vitest';

type WorkerModule = typeof import('../index');

describe('@cogitator-ai/worker', () => {
  let mod: WorkerModule;

  beforeAll(async () => {
    mod = await import('../index');
  }, 60_000);

  it('exports JobQueue', () => {
    expect(mod.JobQueue).toBeDefined();
  });

  it('exports WorkerPool', () => {
    expect(mod.WorkerPool).toBeDefined();
  });

  it('exports MetricsCollector', () => {
    expect(mod.MetricsCollector).toBeDefined();
  });
});
