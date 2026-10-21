import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisAdapter } from '@cogitator-ai/memory';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';

const redisUrl =
  process.env.TEST_REDIS === 'true'
    ? (process.env.TEST_REDIS_URL ?? 'redis://localhost:6379')
    : undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(redisUrl ? describe : describe.skip)('Memory: RedisAdapter thread index', () => {
  let raw: RedisClient;
  const adapters: RedisAdapter[] = [];

  async function adapter(keyPrefix: string, ttl?: number): Promise<RedisAdapter> {
    const created = new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix, ttl });
    const connected = await created.connect();
    if (!connected.success) throw new Error(connected.error);
    adapters.push(created);
    return created;
  }

  const prefix = () => `index-e2e:${randomUUID()}:`;

  beforeAll(async () => {
    raw = await createRedisClient({ mode: 'standalone', url: redisUrl! });
  });

  afterAll(async () => {
    for (const created of adapters) await created.disconnect();
    await raw.quit();
  });

  it('shrinks the index as threads expire, without anyone listing', async () => {
    const keyPrefix = prefix();
    const memory = await adapter(keyPrefix, 1);
    for (let i = 0; i < 50; i++) await memory.createThread('agent', {}, `t${i}`);
    expect(await raw.zrange(`${keyPrefix}threads:index`, 0, -1)).toHaveLength(50);

    await sleep(2100);
    await memory.createThread('agent', {}, 'fresh');

    expect(await raw.zrange(`${keyPrefix}threads:index`, 0, -1)).toEqual(['fresh']);
  });

  it('lists a legacy thread written before the first listing', async () => {
    const keyPrefix = prefix();
    const legacy = {
      id: 'legacy',
      agentId: 'agent',
      metadata: { old: true },
      createdAt: new Date(1000).toISOString(),
      updatedAt: new Date(2000).toISOString(),
    };
    await raw.setex(`${keyPrefix}thread:legacy`, 600, JSON.stringify(legacy));
    const memory = await adapter(keyPrefix);
    await memory.createThread('agent', {}, 'current');

    const page = await memory.listThreads({ agentId: 'agent' });

    expect(page.success && page.data.threads.map((thread) => thread.id)).toEqual([
      'current',
      'legacy',
    ]);
  });

  it('rebuilds the index after it was evicted', async () => {
    const keyPrefix = prefix();
    const memory = await adapter(keyPrefix);
    await memory.createThread('agent', {}, 'first');
    await memory.createThread('agent', {}, 'second');
    expect((await memory.listThreads({ agentId: 'agent' })).success).toBe(true);

    await raw.del(`${keyPrefix}threads:index`);
    await memory.createThread('agent', {}, 'third');
    const page = await memory.listThreads({ agentId: 'agent', order: 'asc' });

    expect(page.success && page.data.threads.map((thread) => thread.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
