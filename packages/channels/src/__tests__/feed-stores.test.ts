import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeJob,
  encodeJob,
  FilePublishStore,
  MemoryPublishStore,
  nextDueAt,
  type PublishJob,
  type PublishStore,
} from '../feeds/publish-store';
import type { PgClient } from '../feeds/storage';
import { FileTokenStore, MemoryTokenStore, PostgresTokenStore } from '../feeds/token-store';
import { PostgresPublishStore } from '../feeds/publish-store';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'feed-stores-'));
  dirs.push(dir);
  return dir;
}

function job(id: string, dueAt: number, overrides: Partial<PublishJob> = {}): PublishJob {
  return {
    id,
    post: { text: `post ${id}` },
    createdAt: dueAt,
    deliveries: [{ feed: 'bluesky', status: 'pending', attempts: 0, nextAttemptAt: dueAt }],
    ...overrides,
  };
}

const fakePg = (): PgClient & { statements: string[] } => {
  const statements: string[] = [];
  return {
    statements,
    query: async (text: string) => {
      statements.push(text);
      return { rows: [] };
    },
  };
};

describe.each([
  ['memory', () => new MemoryTokenStore()],
  ['file', () => new FileTokenStore({ path: join(temp(), 'tokens.json') })],
])('the %s token store', (_name, create) => {
  it('keeps, replaces and deletes tokens by key', async () => {
    const store = create();
    expect(await store.get('threads')).toBeUndefined();
    await store.set('threads', { value: 'a', issuedAt: 1, expiresAt: 2 });
    await store.set('bluesky', { value: '{"did":"x"}', issuedAt: 3 });
    expect(await store.get('threads')).toEqual({ value: 'a', issuedAt: 1, expiresAt: 2 });
    await store.set('threads', { value: 'b', issuedAt: 4, expiresAt: 5 });
    expect(await store.get('threads')).toEqual({ value: 'b', issuedAt: 4, expiresAt: 5 });
    await store.delete('threads');
    expect(await store.get('threads')).toBeUndefined();
    expect(await store.get('bluesky')).toEqual({ value: '{"did":"x"}', issuedAt: 3 });
  });
});

describe('FileTokenStore', () => {
  it('writes a file only its owner can read, and keeps what concurrent writes set', async () => {
    const path = join(temp(), 'nested', 'tokens.json');
    const store = new FileTokenStore({ path });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, { value: `v${i}`, issuedAt: i }))
    );
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')))).toHaveLength(20);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await new FileTokenStore({ path }).get('k7')).toEqual({ value: 'v7', issuedAt: 7 });
  });

  it('keeps the writes of two stores on the same file', async () => {
    const path = join(temp(), 'tokens.json');
    const bluesky = new FileTokenStore({ path });
    const threads = new FileTokenStore({ path });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? bluesky : threads).set(`k${i}`, { value: `v${i}`, issuedAt: i })
      )
    );
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')))).toHaveLength(10);
  });

  it('refuses a file that is not a token file and skips entries that are not tokens', async () => {
    const path = join(temp(), 'tokens.json');
    writeFileSync(path, '[]');
    await expect(new FileTokenStore({ path }).get('x')).rejects.toThrow('not a token file');
    writeFileSync(path, JSON.stringify({ good: { value: 'v', issuedAt: 1 }, bad: { value: 1 } }));
    const store = new FileTokenStore({ path });
    expect(await store.get('good')).toEqual({ value: 'v', issuedAt: 1 });
    expect(await store.get('bad')).toBeUndefined();
  });
});

describe('PostgresTokenStore', () => {
  it('creates its table once and refuses table names that are not identifiers', async () => {
    const client = fakePg();
    const store = new PostgresTokenStore({ client, table: 'app.tokens' });
    await store.get('a');
    await store.set('a', { value: 'v', issuedAt: 1 });
    expect(client.statements.filter((sql) => sql.includes('CREATE TABLE'))).toHaveLength(1);
    expect(client.statements[0]).toContain('CREATE TABLE IF NOT EXISTS app.tokens');
    expect(() => new PostgresTokenStore({ client, table: 'x; DROP TABLE y' })).toThrow(
      'Invalid token table name'
    );
  });
});

describe('encoding jobs', () => {
  it('keeps attachment bytes through JSON', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const original = job('j', 1, {
      post: {
        text: 'with image',
        images: [{ image: { type: 'image', mimeType: 'image/png', buffer: bytes }, alt: 'a' }],
      },
    });
    const decoded = decodeJob(encodeJob(original));
    const buffer = decoded.post.images?.[0]?.image.buffer;
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect([...(buffer ?? [])]).toEqual([...bytes]);
    expect(decoded).toEqual(original);
  });
});

describe.each([
  ['memory', (now: () => number) => new MemoryPublishStore(now)],
  ['file', (now: () => number) => new FilePublishStore({ directory: temp() }, now)],
])('the %s publish store', (_name, create) => {
  let clock = 1_000;
  const now = () => clock;
  let store: PublishStore;

  const fresh = () => {
    clock = 1_000;
    store = create(now);
  };

  it('adds a job once per key', async () => {
    fresh();
    const first = await store.add(job('a', 500, { key: 'post-1' }));
    const again = await store.add(job('b', 500, { key: 'post-1' }));
    expect(first.id).toBe('a');
    expect(again.id).toBe('a');
    expect((await store.list()).map((j) => j.id)).toEqual(['a']);
  });

  const A = { owner: 'worker-a', ttl: 100 };
  const B = { owner: 'worker-b', ttl: 100 };

  it('claims the next due job, oldest due first, and not the ones held or not yet due', async () => {
    fresh();
    await store.add(job('late', 900));
    await store.add(job('early', 100));
    await store.add(job('future', 5_000));
    expect((await store.claimNext(1_000, A))?.id).toBe('early');
    expect((await store.claimNext(1_000, B))?.id).toBe('late');
    expect(await store.claimNext(1_000, A)).toBeUndefined();
    expect(await store.claim('early', B)).toBe(false);
    clock = 1_200;
    expect((await store.claimNext(1_200, B))?.id).toBe('early');
  });

  it("saves and extends only while the claim is the owner's", async () => {
    fresh();
    await store.add(job('a', 100));
    expect(await store.claim('a', A)).toBe(true);
    const held = await store.get('a');
    if (!held) throw new Error('missing job');
    held.deliveries[0].status = 'published';

    expect(await store.save(held, 'worker-b')).toBe(false);
    expect(await store.extend('a', B)).toBe(false);
    clock = 1_050;
    expect(await store.extend('a', A)).toBe(true);
    clock = 1_120;
    expect(await store.claim('a', B)).toBe(false);
    clock = 1_200;
    expect(await store.save(held, 'worker-a')).toBe(false);
    expect(await store.extend('a', A)).toBe(false);
    expect(await store.claim('a', B)).toBe(true);
    await store.release('a', 'worker-a');
    expect(await store.claim('a', A)).toBe(false);
    expect((await store.get('a'))?.deliveries[0].status).toBe('pending');
  });

  it('releases claims, saves changes and lists by status', async () => {
    fresh();
    await store.add(job('a', 100));
    expect(await store.claim('a', { owner: 'worker-a', ttl: 1_000 })).toBe(true);
    expect(await store.remove('a')).toBe(false);
    const held = await store.get('a');
    if (!held) throw new Error('missing job');
    held.deliveries[0].status = 'published';
    expect(await store.save(held, 'worker-a')).toBe(true);
    await store.release('a', 'worker-a');
    expect(nextDueAt((await store.get('a')) ?? held)).toBeUndefined();
    expect(await store.list({ pending: true })).toEqual([]);
    expect((await store.list({ pending: false })).map((j) => j.id)).toEqual(['a']);
    expect(await store.claimNext(10_000, A)).toBeUndefined();
    expect(await store.remove('a')).toBe(true);
    expect(await store.get('a')).toBeUndefined();
  });
});

describe('PostgresPublishStore', () => {
  it('creates its table and index once and refuses table names that are not identifiers', async () => {
    const client = fakePg();
    const store = new PostgresPublishStore({ client, table: 'app.feed_jobs' });
    await store.list();
    await store.get('x');
    const ddl = client.statements.filter((sql) => /CREATE (TABLE|INDEX)/.test(sql));
    expect(ddl).toHaveLength(2);
    expect(ddl[1]).toContain('app_feed_jobs_due_idx ON app.feed_jobs');
    expect(() => new PostgresPublishStore({ client, table: 'jobs"--' })).toThrow(
      'Invalid feed job table name'
    );
  });
});
