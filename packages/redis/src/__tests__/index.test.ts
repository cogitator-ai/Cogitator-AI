import { describe, it, expect } from 'vitest';

describe('@cogitator-ai/redis', () => {
  it('exports createRedisClient', async () => {
    const { createRedisClient } = await import('../index');
    expect(createRedisClient).toBeDefined();
    expect(typeof createRedisClient).toBe('function');
  });

  it('exports createConfigFromEnv', async () => {
    const { createConfigFromEnv } = await import('../index');
    expect(createConfigFromEnv).toBeDefined();
    expect(typeof createConfigFromEnv).toBe('function');
  });
});
