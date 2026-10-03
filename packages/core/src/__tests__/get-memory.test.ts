import { describe, it, expect } from 'vitest';
import { Cogitator } from '../cogitator';

describe('Cogitator.getMemory', () => {
  it('connects the configured memory before any run, once', async () => {
    const cog = new Cogitator({ memory: { adapter: 'memory' } });

    expect(cog.memory).toBeUndefined();
    const [first, second] = await Promise.all([cog.getMemory(), cog.getMemory()]);

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(cog.memory).toBe(first);
    await cog.close();
  });

  it('is undefined without memory in the config', async () => {
    const cog = new Cogitator();

    expect(await cog.getMemory()).toBeUndefined();
    await cog.close();
  });
});
