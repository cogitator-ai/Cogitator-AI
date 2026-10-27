import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, InboxStore, RoutineRunRecord, RoutineStore } from '@cogitator-ai/types';
import {
  experimental_FileRoutineStore,
  experimental_InMemoryRoutineStore,
  experimental_PostgresRoutineStore,
  experimental_RedisRoutineStore,
  type TriggerStoreRedisClient,
} from '../triggers/routine-stores';
import {
  experimental_FileInboxStore,
  experimental_Inbox,
  experimental_InMemoryInboxStore,
  experimental_PostgresInboxStore,
  experimental_RedisInboxStore,
  experimental_webhookSink,
} from '../triggers/inbox';
import type { TriggerStorePgClient } from '../triggers/pg';

/** Enough of Redis for the stores: strings with expiry, sorted sets, the claim script */
function fakeRedis(): TriggerStoreRedisClient {
  const strings = new Map<string, { value: string; until?: number }>();
  const sets = new Map<string, Map<string, number>>();
  const live = (key: string) => {
    const entry = strings.get(key);
    if (entry?.until !== undefined && entry.until <= Date.now()) strings.delete(key);
    return strings.get(key);
  };
  const sorted = (key: string) =>
    [...(sets.get(key) ?? new Map<string, number>()).entries()].sort(([ma, a], [mb, b]) =>
      a === b ? ma.localeCompare(mb) : a - b
    );
  const slice = (key: string, start: number, stop: number | string) => {
    const all = sorted(key).map(([member]) => member);
    const from = start < 0 ? Math.max(0, all.length + start) : start;
    const end = Number(stop) < 0 ? all.length + Number(stop) + 1 : Number(stop) + 1;
    return all.slice(from, end);
  };
  return {
    get: async (key) => live(key)?.value ?? null,
    set: async (key, value) => {
      strings.set(key, { value });
      return 'OK';
    },
    del: async (...keys) => keys.filter((key) => strings.delete(key) || sets.delete(key)).length,
    mget: async (...keys) => keys.map((key) => live(key)?.value ?? null),
    zadd: async (key, score, member) => {
      const set = sets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sets.set(key, set);
      return 1;
    },
    zrange: async (key, start, stop) => slice(key, start, stop),
    zrem: async (key, ...members) =>
      members.filter((member) => sets.get(key)?.delete(member)).length,
    eval: async (script, _keys, key, ttl) => {
      if (!script.includes("'NX'")) throw new Error(`unexpected script ${script}`);
      if (live(String(key))) return 0;
      strings.set(String(key), { value: '1', until: Date.now() + Number(ttl) });
      return 1;
    },
  };
}

function run(
  routineId: string,
  at: number,
  extra: Partial<RoutineRunRecord> = {}
): RoutineRunRecord {
  return {
    id: `evt_${routineId}_${at}`,
    routineId,
    triggerId: `${routineId}.cron`,
    source: 'cron',
    at,
    status: 'completed',
    ...extra,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cogitator-routines-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.each<[string, () => RoutineStore]>([
  ['InMemory', () => new experimental_InMemoryRoutineStore()],
  ['File', () => new experimental_FileRoutineStore(join(dir, 'routines.json'))],
  ['Redis', () => new experimental_RedisRoutineStore({ client: fakeRedis() })],
])('%s routine store', (_name, create) => {
  let store: RoutineStore;
  beforeEach(() => {
    store = create();
  });

  it('keeps routines and refuses secrets as text and targets as objects', async () => {
    await store.saveRoutine({
      id: 'r1',
      prompt: 'p',
      target: { agent: 'a' },
      triggers: [{ kind: 'github', secret: { env: 'GH' } }],
    });
    expect((await store.getRoutine('r1'))?.triggers).toEqual([
      { kind: 'github', secret: { env: 'GH' } },
    ]);
    expect((await store.listRoutines()).map((routine) => routine.id)).toEqual(['r1']);
    await expect(
      store.saveRoutine({
        id: 'r2',
        prompt: 'p',
        target: { agent: 'a' },
        triggers: [{ kind: 'api', token: 'plain' }],
      })
    ).rejects.toThrow(/env/);
    await store.deleteRoutine('r1');
    expect(await store.getRoutine('r1')).toBeNull();
  });

  it('keeps trigger state', async () => {
    await store.saveTriggerState({ id: 'r1.api', routineId: 'r1', fireCount: 2, tokenHash: 'h' });
    await store.saveTriggerState({ id: 'r2.cron', routineId: 'r2', fireCount: 0 });
    expect(await store.getTriggerState('r1.api')).toMatchObject({ fireCount: 2, tokenHash: 'h' });
    expect((await store.listTriggerStates('r1')).map((state) => state.id)).toEqual(['r1.api']);
    await store.deleteTriggerState('r1.api');
    expect(await store.getTriggerState('r1.api')).toBeNull();
  });

  it('claims a key once until it runs out or is given back', async () => {
    expect(await store.claimKey('k', 10_000)).toBe(true);
    expect(await store.claimKey('k', 10_000)).toBe(false);
    await store.releaseKey('k');
    expect(await store.claimKey('k', 5)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.claimKey('k', 5)).toBe(true);
  });

  it('keeps the history newest first, replaces by id and keeps the latest 200 per routine', async () => {
    for (let at = 0; at < 205; at++) await store.recordRun(run('a', at));
    await store.recordRun(run('b', 1_000));
    await store.recordRun(run('a', 204, { status: 'failed', id: 'evt_a_204' }));
    const runs = await store.listRuns({ routineId: 'a', limit: 500 });
    expect(runs).toHaveLength(200);
    expect(runs[0]).toMatchObject({ at: 204, status: 'failed' });
    expect((await store.listRuns({ limit: 1 }))[0].routineId).toBe('b');
  });
});

describe('experimental_FileRoutineStore', () => {
  it('claims a key once across processes and keeps the file private', async () => {
    const path = join(dir, 'routines.json');
    const stores = Array.from({ length: 4 }, () => new experimental_FileRoutineStore(path));
    const won = await Promise.all(stores.map((store) => store.claimKey('run:x', 60_000)));
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('experimental_PostgresRoutineStore', () => {
  it('claims with one insert that takes an expired row, and checks its table prefix', async () => {
    const statements: string[] = [];
    const client: TriggerStorePgClient = {
      query: async (text) => {
        statements.push(text.replace(/\s+/g, ' ').trim());
        return { rows: text.includes('RETURNING key') ? [{ key: 'k' }] : [] };
      },
    };
    const store = new experimental_PostgresRoutineStore({ client, tablePrefix: 'app.routines' });
    expect(await store.claimKey('k', 1000)).toBe(true);
    const claim = statements.find((sql) => sql.includes('RETURNING key'))!;
    expect(claim).toContain('INSERT INTO app.routines_claims');
    expect(claim).toContain('WHERE app.routines_claims.expires_at <= now()');
    expect(
      () => new experimental_PostgresRoutineStore({ client, tablePrefix: 'x; DROP TABLE y' })
    ).toThrow(/Invalid routine table prefix/);
  });
});

function item(id: string, createdAt: number, extra: Partial<InboxItem> = {}): InboxItem {
  return { id, kind: 'result', title: id, summary: '', status: 'unread', createdAt, ...extra };
}

describe.each<[string, () => InboxStore]>([
  ['InMemory', () => new experimental_InMemoryInboxStore()],
  ['File', () => new experimental_FileInboxStore(join(dir, 'inbox.json'))],
  ['Redis', () => new experimental_RedisInboxStore({ client: fakeRedis() })],
])('%s inbox store', (_name, create) => {
  it('lists newest first by status, kind, routine and user, pages and updates', async () => {
    const store = create();
    await store.add(item('a', 1, { userId: 'u1', routineId: 'r1' }));
    await store.add(item('b', 2, { kind: 'failure', routineId: 'r1' }));
    await store.add(item('c', 3, { status: 'archived', userId: 'u1' }));
    expect((await store.list()).map((entry) => entry.id)).toEqual(['c', 'b', 'a']);
    expect((await store.list({ status: 'unread' })).map((entry) => entry.id)).toEqual(['b', 'a']);
    expect((await store.list({ kind: ['failure'] })).map((entry) => entry.id)).toEqual(['b']);
    expect((await store.list({ userId: 'u1' })).map((entry) => entry.id)).toEqual(['c', 'a']);
    expect((await store.list({ userId: null })).map((entry) => entry.id)).toEqual(['b']);
    expect((await store.list({ routineId: 'r1', before: 2 })).map((entry) => entry.id)).toEqual([
      'a',
    ]);
    expect((await store.list({ limit: 1 })).map((entry) => entry.id)).toEqual(['c']);
    expect(await store.update('a', { status: 'read' })).toMatchObject({ status: 'read' });
    await expect(store.update('a', { status: 'gone' as 'read' })).rejects.toThrow(/status/);
    expect(await store.update('zzz', { status: 'read' })).toBeNull();
    await store.delete('a');
    expect(await store.get('a')).toBeNull();
  });
});

describe('experimental_PostgresInboxStore', () => {
  it('filters in SQL', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const client: TriggerStorePgClient = {
      query: async (text, values = []) => {
        calls.push({ sql: text.replace(/\s+/g, ' ').trim(), values });
        return { rows: [] };
      },
    };
    const store = new experimental_PostgresInboxStore({ client });
    await store.list({ status: ['unread', 'read'], userId: 'u1', limit: 5 });
    const select = calls[calls.length - 1];
    expect(select.sql).toContain('WHERE status = ANY($1::text[]) AND user_id = $2');
    expect(select.values).toEqual([['unread', 'read'], 'u1', 5]);
  });
});

describe('experimental_Inbox', () => {
  it('adds, tells sinks and subscribers, and goes on when a sink fails', async () => {
    const heard: string[] = [];
    const inbox = new experimental_Inbox({
      sinks: [
        { name: 'broken', notify: () => Promise.reject(new Error('down')) },
        { name: 'ok', notify: (added) => void heard.push(added.id) },
      ],
    });
    const changes: string[] = [];
    inbox.subscribe((change) => changes.push(change.type));
    const added = await inbox.add({
      kind: 'result',
      title: '  Done  ',
      summary: 'x'.repeat(2_000),
    });
    expect(added).toMatchObject({ status: 'unread', title: 'Done' });
    expect(added.summary.length).toBe(1_000);
    expect(heard).toEqual([added.id]);
    await inbox.markRead(added.id);
    await inbox.archive(added.id);
    await inbox.delete(added.id);
    expect(changes).toEqual(['added', 'updated', 'updated', 'deleted']);
    await expect(inbox.add({ kind: 'result', title: ' ', summary: '' })).rejects.toThrow(/title/);
  });

  it('posts items to a webhook, signed', async () => {
    const fetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const sink = experimental_webhookSink({
      url: 'https://hooks.example.com/in',
      secret: 's',
      fetch,
    });
    await sink.notify(item('a', 1));
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-cogitator-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ type: 'inbox.item', item: { id: 'a' } });
    fetch.mockResolvedValueOnce(new Response('no', { status: 500 }));
    await expect(sink.notify(item('b', 2))).rejects.toThrow(/500/);
  });
});
