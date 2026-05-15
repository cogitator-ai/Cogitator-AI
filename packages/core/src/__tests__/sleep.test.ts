import { describe, it, expect } from 'vitest';
import { sleep } from '../tools/sleep';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('sleep tool', () => {
  it('sleeps for specified duration', async () => {
    const start = Date.now();
    const result = await sleep.execute({ ms: 100 }, mockContext);
    const elapsed = Date.now() - start;

    expect(result).toHaveProperty('requested', 100);
    expect(result).toHaveProperty('slept');
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(200);
  });

  it('sleeps for 0ms', async () => {
    const result = await sleep.execute({ ms: 0 }, mockContext);
    expect(result).toHaveProperty('requested', 0);
  });

  it('aborts when the tool context is cancelled', async () => {
    const controller = new AbortController();
    const resultPromise = sleep.execute(
      { ms: 60000 },
      { ...mockContext, signal: controller.signal }
    );

    controller.abort();

    const result = await resultPromise;
    expect(result).toHaveProperty('error', 'Sleep aborted');
    expect(result).toHaveProperty('requested', 60000);
  });

  it('has correct metadata', () => {
    expect(sleep.name).toBe('sleep');
    expect(sleep.description.toLowerCase()).toContain('pause');
    const schema = sleep.toJSON();
    expect(schema.parameters.properties).toHaveProperty('ms');
  });
});
