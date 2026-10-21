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

    const expired: string[] = [];
    memory.onChange((change) => {
      if (change.type === 'thread-deleted') expired.push(change.threadId);
    });
    await sleep(2100);
    await memory.createThread('agent', {}, 'fresh');

    expect(await raw.zrange(`${keyPrefix}threads:index`, 0, -1)).toEqual(['fresh']);
    expect(expired.sort()).toEqual(Array.from({ length: 50 }, (_, i) => `t${i}`).sort());
  });

  it('pages and sweeps an index too big for one scan', { timeout: 60_000 }, async () => {
    const keyPrefix = prefix();
    const memory = await adapter(keyPrefix, 3);
    const ids = Array.from({ length: 300 }, (_, i) => `t${String(i).padStart(3, '0')}`);
    for (const id of ids) {
      await memory.createThread('agent', {}, id);
      for (const content of ['one', 'two']) {
        await memory.addEntry({ threadId: id, message: { role: 'user', content }, tokenCount: 1 });
      }
    }
    const index = `${keyPrefix}threads:index`;
    expect(await raw.eval("return redis.call('OBJECT', 'ENCODING', KEYS[1])", 1, index)).toBe(
      'skiplist'
    );

    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await memory.listThreads({ agentId: 'agent', limit: 100, cursor });
      if (!page.success) throw new Error(page.error);
      listed.push(...page.data.threads.map((thread) => thread.id));
      cursor = page.data.nextCursor;
    } while (cursor);
    expect([...listed].sort()).toEqual(ids);

    const expired = new Set<string>();
    memory.onChange((change) => {
      if (change.type === 'thread-deleted') expired.add(change.threadId);
    });
    await sleep(3100);
    await memory.createThread('agent', {}, 'fresh');
    for (let i = 0; i < 30; i++) {
      await memory.addEntry({
        threadId: 'fresh',
        message: { role: 'user', content: `m${i}` },
        tokenCount: 1,
      });
    }

    const live = (await raw.zrange(index, 0, -1)).filter((member) => member !== '');
    expect(live).toEqual(['fresh']);
    expect([...expired].sort()).toEqual(ids);
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
