import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { MongoDBAdapter, RedisAdapter } from '@cogitator-ai/memory';
import type { MemoryAdapter, MemoryEntry } from '@cogitator-ai/types';

const redisUrl =
  process.env.TEST_REDIS === 'true'
    ? (process.env.TEST_REDIS_URL ?? 'redis://localhost:6379')
    : undefined;
const mongoUrl = process.env.TEST_MONGODB_URL;
const tag = randomUUID().replace(/-/g, '').slice(0, 8);

async function connected<T extends MemoryAdapter>(adapter: T): Promise<T> {
  const result = await adapter.connect();
  if (!result.success) throw new Error(result.error);
  return adapter;
}

function ok<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

async function add(
  adapter: MemoryAdapter,
  threadId: string,
  content: string,
  placement: Pick<MemoryEntry, 'parentId'> & { activate?: boolean } = {}
): Promise<MemoryEntry> {
  return ok(
    await adapter.addEntry({
      threadId,
      message: { role: 'user', content },
      tokenCount: 1,
      ...placement,
    })
  );
}

/**
 * Checks out entries while another adapter deletes them, round after round: the leaf may land on
 * an entry or stay where it was, never on one that is gone.
 */
async function expectCheckoutNeverLandsOnDeleted(
  [checkingOut, deleting]: MemoryAdapter[],
  threadId: string
): Promise<void> {
  const root = await add(checkingOut!, threadId, 'root');
  for (let round = 0; round < 30; round++) {
    const target = await add(checkingOut!, threadId, `side ${round}`, {
      parentId: root.id,
      activate: false,
    });
    await Promise.all([
      checkingOut!.checkout!(threadId, target.id),
      deleting!.deleteEntry(target.id),
    ]);
    const leaf = ok(await checkingOut!.getThread(threadId))?.activeLeafId;
    expect(leaf, `round ${round}`).toBeDefined();
    expect(ok(await checkingOut!.getEntry(leaf!)), `leaf of round ${round}`).not.toBeNull();
  }
}

(redisUrl ? describe : describe.skip)('Memory: Redis trees under concurrent writes', () => {
  const keyPrefix = `tree-race:${tag}:`;
  const adapters: RedisAdapter[] = [];

  async function open(): Promise<RedisAdapter> {
    const adapter = await connected(
      new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix })
    );
    adapters.push(adapter);
    return adapter;
  }

  afterAll(async () => {
    await Promise.all(adapters.map((adapter) => adapter.disconnect()));
    const redis = new Redis(redisUrl!);
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  it('starts a new root for parentId null on a thread that has entries', async () => {
    const adapter = await open();
    await adapter.createThread('agent', {}, 'roots');
    await add(adapter, 'roots', 'a');
    const b = await add(adapter, 'roots', 'b');

    const aside = await add(adapter, 'roots', 'aside', { parentId: null, activate: false });
    const root = await add(adapter, 'roots', 'root', { parentId: null });

    expect(aside.parentId).toBeNull();
    expect(ok(await adapter.getEntry(aside.id))?.parentId).toBeNull();
    expect(root.parentId).toBeNull();
    const path = ok(await adapter.getPath({ threadId: 'roots' }));
    expect(path.map((entry) => entry.message.content)).toEqual(['root']);
    const old = ok(await adapter.getPath({ threadId: 'roots', leafId: b.id }));
    expect(old.map((entry) => entry.message.content)).toEqual(['a', 'b']);
  });

  it('never leaves the leaf on an entry a concurrent delete removed', async () => {
    const adapters = [await open(), await open()];
    await adapters[0]!.createThread('agent', {}, 'checkout-race');
    await expectCheckoutNeverLandsOnDeleted(adapters, 'checkout-race');
  });
});

(mongoUrl ? describe : describe.skip)('Memory: MongoDB trees under concurrent writes', () => {
  const database = `tree_race_${tag}`;
  const adapters: MongoDBAdapter[] = [];

  async function open(): Promise<MongoDBAdapter> {
    const adapter = await connected(
      new MongoDBAdapter({ provider: 'mongodb', uri: mongoUrl!, database })
    );
    adapters.push(adapter);
    return adapter;
  }

  afterAll(async () => {
    await Promise.all(adapters.map((adapter) => adapter.disconnect()));
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    await client.db(database).dropDatabase();
    await client.close();
  });

  it('keeps one unbroken chain while adapters append and delete side by side', async () => {
    const writers = [await open(), await open(), await open()];
    const threadId = 'append-delete-race';
    await writers[0]!.createThread('agent', {}, threadId);
    const added: string[] = [];
    const deleted = new Set<string>();

    await Promise.all(
      writers.flatMap((writer, w) =>
        [0, 1].map(async (lane) => {
          for (let i = 0; i < 12; i++) {
            const entry = await add(writer, threadId, `w${w}-l${lane}-${i}`);
            added.push(entry.id);
            if (i % 3 === 2) {
              const victim = added[Math.floor(added.length / 2)]!;
              deleted.add(victim);
              ok(await writers[(w + 1) % writers.length]!.deleteEntry(victim));
            }
          }
        })
      )
    );

    const entries = ok(await writers[0]!.getEntries({ threadId, types: 'all' }));
    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.size).toBe(added.length - deleted.size);
    for (const entry of entries) {
      if (entry.parentId !== null) {
        expect(ids.has(entry.parentId!), `parent of ${entry.id}`).toBe(true);
      }
    }
    const leaf = ok(await writers[0]!.getThread(threadId))?.activeLeafId;
    expect(leaf && ids.has(leaf)).toBe(true);
    const path = ok(await writers[0]!.getPath({ threadId, types: 'all' }));
    expect(path[0]?.parentId).toBeNull();
    expect(path.length, 'every entry is on the one branch appends make').toBe(ids.size);
  });

  it('never leaves the leaf on an entry a concurrent delete removed', async () => {
    const pair = [await open(), await open()];
    await pair[0]!.createThread('agent', {}, 'checkout-race');
    await expectCheckoutNeverLandsOnDeleted(pair, 'checkout-race');
  });

  it('waits out the lease of a writer that crashed holding it', async () => {
    const adapter = await open();
    await adapter.createThread('agent', {}, 'crashed-writer');
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    await client
      .db(database)
      .collection<{ _id: string }>('memory_threads')
      .updateOne(
        { _id: 'crashed-writer' },
        { $set: { lease: { token: 'crashed', until: new Date(Date.now() + 1000) } } }
      );
    await client.close();

    const started = performance.now();
    const entry = await add(adapter, 'crashed-writer', 'after the crash');

    expect(performance.now() - started).toBeGreaterThan(500);
    expect(ok(await adapter.getThread('crashed-writer'))?.activeLeafId).toBe(entry.id);
  });

  it('reads a page of a path whose entries together pass the BSON document limit', async () => {
    const adapter = await open();
    await adapter.createThread('agent', {}, 'big-path');
    const big = 'x'.repeat(700 * 1024);
    for (let i = 0; i < 26; i++) await add(adapter, 'big-path', `${i}:${big}`);

    const page = ok(await adapter.getPath({ threadId: 'big-path', limit: 2 }));
    expect(page.map((entry) => entry.message.content.toString().split(':')[0])).toEqual([
      '24',
      '25',
    ]);
    const whole = ok(await adapter.getPath({ threadId: 'big-path' }));
    expect(whole).toHaveLength(26);
  });
});
