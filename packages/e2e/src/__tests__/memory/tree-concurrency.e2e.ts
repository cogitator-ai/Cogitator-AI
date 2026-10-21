import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { Collection, MongoClient } from 'mongodb';
import type { Document } from 'mongodb';
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

/**
 * Holds the next call of the driver's `method` that `matches` its first two arguments in the
 * driver's queue for `ms` before it reaches the server, as a slow network or a busy pool would.
 * Resolves `reached` when the call is made and `landed` when the server answered it.
 */
function holdUp(
  method: 'updateOne' | 'bulkWrite',
  matches: (first: unknown, second: unknown) => boolean,
  ms: number
): { reached: Promise<void>; landed: Promise<void> } {
  const prototype = Collection.prototype as unknown as Record<string, unknown>;
  const original = prototype[method] as (this: Collection<Document>, ...args: unknown[]) => unknown;
  let reach!: () => void;
  let land!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const landed = new Promise<void>((resolve) => (land = resolve));
  prototype[method] = async function (this: Collection<Document>, ...args: unknown[]) {
    if (!matches(args[0], args[1])) return original.apply(this, args);
    prototype[method] = original;
    reach();
    await new Promise((resolve) => setTimeout(resolve, ms));
    try {
      return await original.apply(this, args);
    } finally {
      land();
    }
  };
  return { reached, landed };
}

/** Whether a thread update is an append publishing its entry as the leaf */
function isPublish(filter: unknown, update: unknown): boolean {
  if (typeof filter !== 'object' || filter === null || !('lease.token' in filter)) return false;
  return typeof update === 'object' && update !== null && '$set' in update && '$unset' in update;
}

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

  /**
   * The state a delete leaves when it recorded its entry as removed under its lease, then stalled
   * past the lease before its writes to entries landed: the entry and the link of its child to it
   * are still there, the lease ran out.
   */
  async function stallDelete(threadId: string, entryId: string, parentId: string): Promise<void> {
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    await client
      .db(database)
      .collection<{ _id: string }>('memory_threads')
      .updateOne(
        { _id: threadId },
        {
          $set: {
            removed: [{ id: entryId, parentId, at: new Date() }],
            lease: { token: 'stalled', until: new Date(Date.now() - 1000) },
          },
        }
      );
    await client.close();
  }

  /** The delete that stalled lands at last */
  async function landLateDelete(entryId: string): Promise<void> {
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    await client
      .db(database)
      .collection<{ _id: string }>('memory_entries')
      .deleteOne({ _id: entryId });
    await client.close();
  }

  it('publishes an append held up past its lease, inserting it again after a clear', async () => {
    const [appender, clearer] = [await open(), await open()];
    const threadId = 'late-append';
    await appender.createThread('agent', {}, threadId);
    await add(appender, threadId, 'a');
    const publish = holdUp('updateOne', isPublish, 6_500);

    const appending = add(appender, threadId, 'late');
    await publish.reached;
    ok(await clearer.clearThread(threadId));
    const late = await appending;

    const thread = ok(await clearer.getThread(threadId));
    expect(thread?.activeLeafId).toBe(late.id);
    expect(ok(await clearer.getEntry(late.id))?.parentId).toBeNull();
    const path = ok(await clearer.getPath({ threadId }));
    expect(path.map((entry) => entry.message.content)).toEqual(['late']);
  }, 30_000);

  it('finishes a delete whose re-parenting reaches the server after its lease ran out', async () => {
    const [deleter, other] = [await open(), await open()];
    const threadId = 'late-reparent';
    await deleter.createThread('agent', {}, threadId);
    const a = await add(deleter, threadId, 'a');
    const b = await add(deleter, threadId, 'b');
    const c = await add(deleter, threadId, 'c');
    const reparent = holdUp('bulkWrite', () => true, 6_500);

    const deleting = deleter.deleteEntry(b.id);
    await reparent.reached;
    const checkedOut = await other.checkout!(threadId, b.id);
    const d = await add(other, threadId, 'd');
    await reparent.landed;
    ok(await deleting);

    expect(checkedOut.success).toBe(false);
    expect(d.parentId).toBe(c.id);
    expect(ok(await other.getEntry(c.id))?.parentId).toBe(a.id);
    expect(ok(await other.getEntry(b.id))).toBeNull();
    expect(ok(await other.getThread(threadId))?.activeLeafId).toBe(d.id);
    const path = ok(await other.getPath({ threadId }));
    expect(path.map((entry) => entry.message.content)).toEqual(['a', 'c', 'd']);
  }, 30_000);

  it('keeps a delete that lands after its lease ran out from leaving anything on the entry', async () => {
    const adapter = await open();
    const threadId = 'late-delete';
    await adapter.createThread('agent', {}, threadId);
    const [a, b, c] = [
      await add(adapter, threadId, 'a'),
      await add(adapter, threadId, 'b'),
      await add(adapter, threadId, 'c'),
    ];
    await stallDelete(threadId, b.id, a.id);

    const checkedOut = await adapter.checkout!(threadId, b.id);
    const appended = await adapter.addEntry({
      threadId,
      message: { role: 'user', content: 'under b' },
      tokenCount: 1,
      parentId: b.id,
    });
    await landLateDelete(b.id);

    expect(checkedOut.success).toBe(false);
    expect(appended.success).toBe(false);
    const leaf = ok(await adapter.getThread(threadId))?.activeLeafId;
    expect(leaf).toBe(c.id);
    expect(ok(await adapter.getEntry(c.id))?.parentId).toBe(a.id);
    expect(ok(await adapter.getEntry(b.id))).toBeNull();
    const path = ok(await adapter.getPath({ threadId }));
    expect(path.map((entry) => entry.message.content)).toEqual(['a', 'c']);
  });

  it('reads a path past a parent a delete removed before it moved the children', async () => {
    const adapter = await open();
    const threadId = 'late-children';
    await adapter.createThread('agent', {}, threadId);
    const a = await add(adapter, threadId, 'a');
    const b = await add(adapter, threadId, 'b');
    await add(adapter, threadId, 'c');
    await stallDelete(threadId, b.id, a.id);
    await landLateDelete(b.id);

    const path = ok(await adapter.getPath({ threadId }));

    expect(path.map((entry) => entry.message.content)).toEqual(['a', 'c']);
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
