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
    eval: async (script, count, ...args) => {
      const keys = args.slice(0, count).map(String);
      const argv = args.slice(count).map(String);
      if (script.includes("'NX'")) {
        if (live(keys[0])) return 0;
        strings.set(keys[0], { value: '1', until: Date.now() + Number(argv[0]) });
        return 1;
      }
      if (script.includes('cjson.decode(ARGV[3])')) {
        const raw = live(keys[0])?.value;
        const state = raw
          ? (JSON.parse(raw) as Record<string, unknown>)
          : { id: argv[0], routineId: argv[1], fireCount: 0 };
        Object.assign(state, JSON.parse(argv[2]) as Record<string, unknown>);
        state.id = argv[0];
        state.routineId = argv[1];
        state.fireCount = Number(state.fireCount ?? 0) + Number(argv[3]);
        const encoded = JSON.stringify(state);
        strings.set(keys[0], { value: encoded });
        const set = sets.get(keys[1]) ?? new Map<string, number>();
        set.set(argv[0], Number(argv[4]));
        sets.set(keys[1], set);
        return encoded;
      }
      if (script.includes('ZREVRANGEBYSCORE')) {
        const [max, offset, page, itemPrefix] = argv;
        const exclusive = max.startsWith('(');
        const bound = max === '+inf' ? Infinity : Number(exclusive ? max.slice(1) : max);
        const ids = sorted(keys[0])
          .reverse()
          .filter(([, score]) => (exclusive ? score < bound : score <= bound))
          .slice(Number(offset), Number(offset) + Number(page))
          .map(([member]) => member);
        const items = ids
          .map((id) => live(`${itemPrefix}${id}`)?.value)
          .filter((value): value is string => value !== undefined);
        return [ids.length, items];
      }
      if (script.includes('~= ARGV[1]')) {
        if (live(keys[0])?.value !== argv[0]) return 0;
        strings.set(keys[0], { value: argv[1] });
        for (let at = 1; at + 1 < keys.length; at += 2) {
          if (keys[at] === keys[at + 1]) continue;
          sets.get(keys[at])?.delete(argv[2]);
          const set = sets.get(keys[at + 1]) ?? new Map<string, number>();
          set.set(argv[2], Number(argv[3]));
          sets.set(keys[at + 1], set);
        }
        return 1;
      }
      throw new Error(`unexpected script ${script}`);
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

  it('patches trigger state so a firing and a token rotation at once keep both', async () => {
    await store.saveTriggerState({ id: 'r1.api', routineId: 'r1', fireCount: 0, tokenHash: 'old' });
    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        store.patchTriggerState('r1.api', 'r1', { fireCountDelta: 1, lastFiredAt: 7 })
      ),
      store.patchTriggerState('r1.api', 'r1', { tokenHash: 'new', tokenHint: 'abcd' }),
      store.patchTriggerState('r1.api', 'r1', { enabled: false }),
    ]);
    expect(await store.getTriggerState('r1.api')).toEqual({
      id: 'r1.api',
      routineId: 'r1',
      fireCount: 5,
      lastFiredAt: 7,
      tokenHash: 'new',
      tokenHint: 'abcd',
      enabled: false,
    });
    expect(await store.patchTriggerState('r2.cron', 'r2', { scheduleId: 's1' })).toEqual({
      id: 'r2.cron',
      routineId: 'r2',
      fireCount: 0,
      scheduleId: 's1',
    });
    expect((await store.listTriggerStates('r2')).map((state) => state.id)).toEqual(['r2.cron']);
  });

  it('keeps runs going on apart from the history', async () => {
    const active = {
      runId: 'trg_r1.cron.1',
      kind: 'routine' as const,
      eventId: 'evt_1',
      triggerId: 'r1.cron',
      routineId: 'r1',
      source: 'cron' as const,
      at: 1,
      threadId: 't1',
    };
    await store.saveActiveRun(active);
    for (let at = 0; at < 205; at++) await store.recordRun(run('r1', at + 10));
    expect(await store.getActiveRun('trg_r1.cron.1')).toEqual(active);
    expect((await store.listActiveRuns()).map((kept) => kept.runId)).toEqual(['trg_r1.cron.1']);
    await store.deleteActiveRun('trg_r1.cron.1');
    expect(await store.getActiveRun('trg_r1.cron.1')).toBeNull();
    expect(await store.listActiveRuns()).toEqual([]);
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
  it('sweeps expired claims in bounded batches, at most once a minute', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    try {
      const statements: string[] = [];
      const client: TriggerStorePgClient = {
        query: async (text) => {
          statements.push(text.replace(/\s+/g, ' ').trim());
          return { rows: text.includes('RETURNING key') ? [{ key: 'k' }] : [] };
        },
      };
      const store = new experimental_PostgresRoutineStore({ client });
      const sweeps = () =>
        statements.filter((sql) => sql.startsWith('DELETE FROM cogitator_routines_claims'));
      await store.claimKey('a', 1000);
      await store.claimKey('b', 1000);
      expect(sweeps()).toEqual([
        'DELETE FROM cogitator_routines_claims WHERE key IN ( SELECT key FROM cogitator_routines_claims WHERE expires_at <= now() LIMIT 500)',
      ]);
      vi.setSystemTime(1_000_000 + 61_000);
      await store.claimKey('c', 1000);
      expect(sweeps()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('patches trigger state in one statement, adding to the fire count', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const client: TriggerStorePgClient = {
      query: async (text, values = []) => {
        calls.push({ sql: text.replace(/\s+/g, ' ').trim(), values });
        return {
          rows: text.includes('RETURNING data')
            ? [{ data: { id: 'r.api', routineId: 'r', fireCount: 3, tokenHash: 'h' } }]
            : [],
        };
      },
    };
    const store = new experimental_PostgresRoutineStore({ client });
    const state = await store.patchTriggerState('r.api', 'r', {
      fireCountDelta: 1,
      lastFiredAt: 5,
    });
    expect(state.fireCount).toBe(3);
    const patch = calls.find((call) => call.sql.includes('RETURNING data'))!;
    expect(patch.sql).toContain(
      'ON CONFLICT (id) DO UPDATE SET data = cogitator_routines_triggers.data ||'
    );
    expect(patch.sql).toContain(
      "COALESCE((cogitator_routines_triggers.data->>'fireCount')::bigint, 0) + $4::bigint"
    );
    expect(patch.values).toEqual(['r.api', 'r', JSON.stringify({ lastFiredAt: 5 }), 1]);
  });

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

  it('pages by creation time and id, so items of the same millisecond are not skipped', async () => {
    const store = create();
    for (const id of ['x1', 'x2', 'x3']) await store.add(item(id, 5, { userId: 'u' }));
    await store.add(item('older', 4, { userId: 'u' }));
    const seen: string[] = [];
    let cursor: { before: number; beforeId: string } | undefined;
    for (let page = 0; page < 6; page++) {
      const [next] = await store.list({ userId: 'u', limit: 1, ...cursor });
      if (!next) break;
      seen.push(next.id);
      cursor = { before: next.createdAt, beforeId: next.id };
    }
    expect(seen).toEqual(['x3', 'x2', 'x1', 'older']);
  });

  it('claims an answer once, and a status change never makes it unanswered', async () => {
    const store = create();
    await store.add(item('q', 1, { kind: 'approval', status: 'archived' }));
    const claims = await Promise.all([store.claimAnswer('q', 10), store.claimAnswer('q', 11)]);
    expect(claims.filter((claimed) => claimed !== null)).toHaveLength(1);
    expect(await store.update('q', { status: 'unread' })).toMatchObject({ status: 'unread' });
    expect((await store.get('q'))?.answeredAt).toBeDefined();
    expect(await store.claimAnswer('q', 12)).toBeNull();
    await store.releaseAnswer('q');
    expect((await store.get('q'))?.answeredAt).toBeUndefined();
    expect(await store.claimAnswer('q', 13)).toMatchObject({ answeredAt: 13, status: 'archived' });
    expect(await store.claimAnswer('missing', 1)).toBeNull();
  });
});

describe('experimental_RedisInboxStore', () => {
  it('reads a page of the narrowest index, not the whole inbox', async () => {
    const client = fakeRedis();
    const evals: string[] = [];
    const store = new experimental_RedisInboxStore({
      client: {
        ...client,
        eval: (script, count, ...args) => {
          if (script.includes('ZREVRANGEBYSCORE')) evals.push(String(args[0]));
          return client.eval(script, count, ...args);
        },
        mget: () => Promise.reject(new Error('the whole inbox was read')),
      },
    });
    for (let at = 1; at <= 300; at++) {
      await store.add(item(`a${at}`, at, { userId: at % 2 === 0 ? 'alice' : 'bob' }));
    }
    await store.update('a10', { status: 'read' });
    const page = await store.list({ userId: 'alice', status: 'unread', limit: 3 });
    expect(page.map((entry) => entry.id)).toEqual(['a300', 'a298', 'a296']);
    expect(evals).toEqual(['cogitator:inbox:items:user:alice:status:unread']);
    expect(
      (await store.list({ userId: 'alice', status: 'read' })).map((entry) => entry.id)
    ).toEqual(['a10']);
    expect(
      (await store.list({ userId: 'alice', status: 'unread', limit: 200 })).map((entry) => entry.id)
    ).not.toContain('a10');
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
