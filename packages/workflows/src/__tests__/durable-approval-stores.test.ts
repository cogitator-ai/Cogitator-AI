import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ApprovalRequest, ApprovalResponse, ApprovalStore } from '@cogitator-ai/types';
import { InMemoryApprovalStore } from '../human/approval-store';
import {
  PostgresApprovalStore,
  RedisApprovalStore,
  type ApprovalStorePgClient,
  type ApprovalStoreRedisClient,
} from '../human/durable-approval-stores';

interface FakeRedis extends ApprovalStoreRedisClient {
  strings: Map<string, string>;
  sortedSets: Map<string, Map<string, number>>;
}

/** Enough of Redis for the store: strings and sorted sets. */
function fakeRedis(): FakeRedis {
  const strings = new Map<string, string>();
  const sortedSets = new Map<string, Map<string, number>>();
  return {
    strings,
    sortedSets,
    get: async (key) => strings.get(key) ?? null,
    set: async (key, value) => {
      strings.set(key, value);
      return 'OK';
    },
    del: async (...keys) => keys.filter((key) => strings.delete(key)).length,
    mget: async (...keys) => keys.map((key) => strings.get(key) ?? null),
    zadd: async (key, score, member) => {
      const set = sortedSets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sortedSets.set(key, set);
      return 1;
    },
    zrange: async (key) =>
      [...(sortedSets.get(key) ?? new Map<string, number>()).entries()]
        .sort(([idA, a], [idB, b]) => a - b || idA.localeCompare(idB))
        .map(([member]) => member),
    zrem: async (key, ...members) => {
      for (const member of members) sortedSets.get(key)?.delete(member);
      return members.length;
    },
  };
}

interface Statement {
  sql: string;
  values: unknown[];
}

/** Records the SQL the store sends and answers it with `respond`. */
function fakePostgres(
  respond: (sql: string, values: unknown[]) => Array<Record<string, unknown>> = () => []
): ApprovalStorePgClient & { statements: Statement[] } {
  const statements: Statement[] = [];
  return {
    statements,
    query: async (text, values = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      statements.push({ sql, values });
      return { rows: respond(sql, values) };
    },
  };
}

const request = (id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id,
  workflowId: 'orders',
  runId: `run_${id}`,
  nodeId: 'approve',
  type: 'approve-reject',
  title: `Approve ${id}`,
  createdAt: 1000,
  ...overrides,
});

const response = (
  requestId: string,
  overrides: Partial<ApprovalResponse> = {}
): ApprovalResponse => ({
  requestId,
  decision: true,
  respondedBy: 'alice',
  respondedAt: 2000,
  ...overrides,
});

const ids = (requests: ApprovalRequest[]) => requests.map((r) => r.id);

type DisposableStore = ApprovalStore & { dispose(): void };

const stores: DisposableStore[] = [];

function track<T extends DisposableStore>(store: T): T {
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

describe.each<[string, () => DisposableStore]>([
  ['InMemoryApprovalStore', () => track(new InMemoryApprovalStore())],
  [
    'RedisApprovalStore',
    () => track(new RedisApprovalStore({ client: fakeRedis(), pollInterval: 20 })),
  ],
])('%s contract', (_name, createStore) => {
  it('stores requests and returns null for unknown ids', async () => {
    const store = createStore();
    const original = request('r1', { metadata: { amount: 5 } });
    await store.createRequest(original);
    original.title = 'changed after create';

    expect(await store.getRequest('r1')).toEqual(request('r1', { metadata: { amount: 5 } }));
    expect(await store.getRequest('missing')).toBeNull();
  });

  it('lists requests without a response as pending, optionally per workflow', async () => {
    const store = createStore();
    await store.createRequest(request('r1', { createdAt: 1 }));
    await store.createRequest(request('r2', { createdAt: 2, workflowId: 'billing' }));
    await store.createRequest(request('r3', { createdAt: 3 }));
    await store.submitResponse(response('r3'));

    expect(ids(await store.getPendingRequests())).toEqual(['r1', 'r2']);
    expect(ids(await store.getPendingRequests('orders'))).toEqual(['r1']);
    expect(ids(await store.getPendingRequests('billing'))).toEqual(['r2']);
    expect(await store.getPendingRequests('unknown')).toEqual([]);
  });

  it('lists pending requests for an assignee directly or through a group', async () => {
    const store = createStore();
    await store.createRequest(request('direct', { createdAt: 1, assignee: 'alice' }));
    await store.createRequest(
      request('group', { createdAt: 2, assignee: 'bob', assigneeGroup: ['alice', 'carol'] })
    );
    await store.createRequest(request('other', { createdAt: 3, assignee: 'bob' }));
    await store.createRequest(request('answered', { createdAt: 4, assignee: 'alice' }));
    await store.submitResponse(response('answered'));

    expect(ids(await store.getPendingForAssignee('alice'))).toEqual(['direct', 'group']);
    expect(ids(await store.getPendingForAssignee('bob'))).toEqual(['group', 'other']);
    expect(ids(await store.getPendingForAssignee('carol'))).toEqual(['group']);
    expect(await store.getPendingForAssignee('dave')).toEqual([]);
  });

  it('moves a request between lists when it is created again with new routing', async () => {
    const store = createStore();
    await store.createRequest(request('r1', { assignee: 'alice' }));
    await store.createRequest(request('r1', { assignee: 'bob', workflowId: 'billing' }));

    expect(await store.getPendingForAssignee('alice')).toEqual([]);
    expect(ids(await store.getPendingForAssignee('bob'))).toEqual(['r1']);
    expect(await store.getPendingRequests('orders')).toEqual([]);
    expect(ids(await store.getPendingRequests('billing'))).toEqual(['r1']);
  });

  it('keeps a request answered when it is created again after its response', async () => {
    const store = createStore();
    await store.createRequest(request('r1', { assignee: 'alice' }));
    await store.submitResponse(response('r1'));
    await store.createRequest(request('r1', { assignee: 'alice', title: 'again' }));

    expect((await store.getRequest('r1'))?.title).toBe('again');
    expect(await store.getPendingRequests()).toEqual([]);
    expect(await store.getPendingForAssignee('alice')).toEqual([]);
  });

  it('stores responses, also for requests it does not know', async () => {
    const store = createStore();
    await store.createRequest(request('r1'));
    await store.submitResponse(response('r1', { comment: 'ok' }));
    await store.submitResponse(response('ghost'));

    expect(await store.getResponse('r1')).toEqual(response('r1', { comment: 'ok' }));
    expect(await store.getResponse('ghost')).toEqual(response('ghost'));
    expect(await store.getResponse('missing')).toBeNull();
  });

  it('deletes a request together with its response', async () => {
    const store = createStore();
    await store.createRequest(request('r1', { assignee: 'alice' }));
    await store.createRequest(request('r2', { assignee: 'alice' }));
    await store.submitResponse(response('r1'));
    await store.deleteRequest('r1');
    await store.deleteRequest('r2');
    await store.deleteRequest('missing');

    expect(await store.getRequest('r1')).toBeNull();
    expect(await store.getResponse('r1')).toBeNull();
    expect(await store.getPendingRequests()).toEqual([]);
    expect(await store.getPendingForAssignee('alice')).toEqual([]);
  });

  it('calls every waiting callback once when a response is submitted', async () => {
    const store = createStore();
    const first = vi.fn();
    const second = vi.fn();
    await store.createRequest(request('r1'));
    store.onResponse('r1', first);
    store.onResponse('r1', second);

    await store.submitResponse(response('r1'));
    await store.submitResponse(response('r1', { decision: false }));

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(response('r1'));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps calling the other callbacks when one throws', async () => {
    const store = createStore();
    const after = vi.fn();
    store.onResponse('r1', () => {
      throw new Error('listener failed');
    });
    store.onResponse('r1', after);

    await store.submitResponse(response('r1'));

    expect(after).toHaveBeenCalledWith(response('r1'));
  });

  it('does not call a callback after it unsubscribes', async () => {
    const store = createStore();
    const kept = vi.fn();
    const dropped = vi.fn();
    store.onResponse('r1', kept);
    const unsubscribe = store.onResponse('r1', dropped);
    unsubscribe();

    await store.submitResponse(response('r1'));

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('calls back asynchronously when the response already exists', async () => {
    const store = createStore();
    await store.submitResponse(response('r1'));
    const callback = vi.fn();

    store.onResponse('r1', callback);
    expect(callback).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(response('r1')));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('forgets waiting callbacks when the request is deleted', async () => {
    const store = createStore();
    const callback = vi.fn();
    await store.createRequest(request('r1'));
    store.onResponse('r1', callback);

    await store.deleteRequest('r1');
    await store.submitResponse(response('r1'));

    expect(callback).not.toHaveBeenCalled();
  });
});

describe('RedisApprovalStore', () => {
  it('keeps requests and pending indexes under its key prefix', async () => {
    const client = fakeRedis();
    const store = track(new RedisApprovalStore({ client, keyPrefix: 'app:approvals' }));
    await store.createRequest(
      request('r1', { assignee: 'alice', assigneeGroup: ['bob'], createdAt: 7 })
    );

    expect(JSON.parse(client.strings.get('app:approvals:request:r1') ?? '')).toEqual(
      request('r1', { assignee: 'alice', assigneeGroup: ['bob'], createdAt: 7 })
    );
    expect([...client.sortedSets.keys()].sort()).toEqual([
      'app:approvals:pending',
      'app:approvals:pending:assignee:alice',
      'app:approvals:pending:assignee:bob',
      'app:approvals:pending:workflow:orders',
    ]);
    expect(client.sortedSets.get('app:approvals:pending')?.get('r1')).toBe(7);

    await store.submitResponse(response('r1'));

    expect(JSON.parse(client.strings.get('app:approvals:response:r1') ?? '')).toEqual(
      response('r1')
    );
    for (const members of client.sortedSets.values()) expect(members.size).toBe(0);
  });

  it('drops index entries whose request was answered or removed elsewhere', async () => {
    const client = fakeRedis();
    const store = track(new RedisApprovalStore({ client }));
    await store.createRequest(request('answered', { assignee: 'alice', createdAt: 1 }));
    await store.createRequest(request('removed', { assignee: 'alice', createdAt: 2 }));
    await store.createRequest(request('open', { assignee: 'alice', createdAt: 3 }));
    client.strings.set(
      'cogitator:workflow-approvals:response:answered',
      JSON.stringify(response('answered'))
    );
    client.strings.delete('cogitator:workflow-approvals:request:removed');

    expect(ids(await store.getPendingForAssignee('alice'))).toEqual(['open']);
    expect([
      ...(client.sortedSets.get('cogitator:workflow-approvals:pending:assignee:alice')?.keys() ??
        []),
    ]).toEqual(['open']);
  });

  it('does not query request bodies when nothing is pending', async () => {
    const client = fakeRedis();
    const mget = vi.spyOn(client, 'mget');
    const store = track(new RedisApprovalStore({ client }));

    expect(await store.getPendingRequests()).toEqual([]);
    expect(mget).not.toHaveBeenCalled();
  });
});

describe('PostgresApprovalStore', () => {
  it('creates both tables and their indexes once, before the first query', async () => {
    const client = fakePostgres();
    const store = track(new PostgresApprovalStore({ client, tablePrefix: 'app.approvals' }));

    await store.getRequest('r1');
    await store.getResponse('r1');

    const creates = client.statements.filter((s) => s.sql.startsWith('CREATE'));
    expect(creates.map((s) => s.sql.split(' (')[0])).toEqual([
      'CREATE TABLE IF NOT EXISTS app.approvals_requests',
      'CREATE TABLE IF NOT EXISTS app.approvals_responses',
      'CREATE INDEX IF NOT EXISTS app_approvals_requests_workflow_idx ON app.approvals_requests',
      'CREATE INDEX IF NOT EXISTS app_approvals_requests_assignee_idx ON app.approvals_requests',
      'CREATE INDEX IF NOT EXISTS app_approvals_requests_assignee_group_idx ON app.approvals_requests USING GIN',
    ]);
    expect(client.statements.slice(0, 5)).toEqual(creates);
  });

  it('retries each schema statement that collides with another process creating it', async () => {
    const collided = new Set<string>();
    const client = fakePostgres((sql) => {
      if (sql.startsWith('CREATE') && !collided.has(sql)) {
        collided.add(sql);
        throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      }
      return [];
    });
    const store = track(new PostgresApprovalStore({ client }));

    await expect(store.getRequest('r1')).resolves.toBeNull();
    expect(client.statements.filter((s) => s.sql.startsWith('CREATE'))).toHaveLength(10);
  });

  it('surfaces other schema errors and tries the schema again on the next call', async () => {
    let down = true;
    const client = fakePostgres((sql) => {
      if (sql.startsWith('CREATE') && down) throw new Error('permission denied');
      return [];
    });
    const store = track(new PostgresApprovalStore({ client }));

    await expect(store.getRequest('r1')).rejects.toThrow('permission denied');
    down = false;
    await expect(store.getRequest('r1')).resolves.toBeNull();
    expect(client.statements.filter((s) => s.sql.startsWith('CREATE'))).toHaveLength(6);
  });

  it('upserts requests with their routing columns', async () => {
    const client = fakePostgres();
    const store = track(new PostgresApprovalStore({ client }));
    const routed = request('r1', { assignee: 'alice', assigneeGroup: ['bob'], createdAt: 7 });

    await store.createRequest(routed);
    await store.createRequest(request('r2'));

    const [first, second] = client.statements.filter((s) => s.sql.startsWith('INSERT'));
    expect(first.sql).toContain('INSERT INTO cogitator_workflow_approvals_requests');
    expect(first.sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(first.values).toEqual(['r1', 'orders', 'alice', ['bob'], 7, JSON.stringify(routed)]);
    expect(second.values.slice(2, 4)).toEqual([null, []]);
  });

  it('selects pending requests as those without a response row', async () => {
    const client = fakePostgres();
    const store = track(new PostgresApprovalStore({ client }));

    await store.getPendingRequests();
    await store.getPendingRequests('orders');
    await store.getPendingForAssignee('alice');

    const [all, byWorkflow, byAssignee] = client.statements.slice(5);
    const unanswered =
      'NOT EXISTS (SELECT 1 FROM cogitator_workflow_approvals_responses s WHERE s.request_id = r.id)';
    expect(all.sql).toContain(unanswered);
    expect(all.sql).toContain('ORDER BY r.created_at, r.id');
    expect(all.values).toEqual([]);
    expect(byWorkflow.sql).toContain(`r.workflow_id = $1 AND ${unanswered}`);
    expect(byWorkflow.values).toEqual(['orders']);
    expect(byAssignee.sql).toContain(
      `(r.assignee = $1 OR r.assignee_group @> ARRAY[$1]::text[]) AND ${unanswered}`
    );
    expect(byAssignee.values).toEqual(['alice']);
  });

  it('upserts responses and deletes a request with its response in one statement', async () => {
    const client = fakePostgres();
    const store = track(new PostgresApprovalStore({ client }));

    await store.submitResponse(response('r1'));
    await store.deleteRequest('r1');

    const [submit, remove] = client.statements.slice(5);
    expect(submit.sql).toContain('INSERT INTO cogitator_workflow_approvals_responses');
    expect(submit.sql).toContain('ON CONFLICT (request_id) DO UPDATE');
    expect(submit.values).toEqual(['r1', JSON.stringify(response('r1'))]);
    expect(remove.sql).toBe(
      'WITH removed AS (DELETE FROM cogitator_workflow_approvals_responses WHERE request_id = $1) DELETE FROM cogitator_workflow_approvals_requests WHERE id = $1'
    );
    expect(remove.values).toEqual(['r1']);
  });

  it('reads JSONB returned parsed or as text', async () => {
    const client = fakePostgres((sql) => {
      if (sql.includes('FROM cogitator_workflow_approvals_requests WHERE id')) {
        return [{ data: request('r1') }];
      }
      if (sql.includes('FROM cogitator_workflow_approvals_responses WHERE request_id')) {
        return [{ data: JSON.stringify(response('r1')) }];
      }
      if (sql.startsWith('SELECT r.data')) {
        return [{ data: JSON.stringify(request('r2')) }, { data: request('r3') }];
      }
      return [];
    });
    const store = track(new PostgresApprovalStore({ client }));

    expect(await store.getRequest('r1')).toEqual(request('r1'));
    expect(await store.getResponse('r1')).toEqual(response('r1'));
    expect(ids(await store.getPendingRequests())).toEqual(['r2', 'r3']);
  });

  it('refuses table prefixes that are not plain identifiers', () => {
    expect(
      () => new PostgresApprovalStore({ client: fakePostgres(), tablePrefix: 'x; DROP TABLE y' })
    ).toThrow('Invalid approval table prefix');
  });
});

describe('responses from other processes', () => {
  const POLL = 500;

  it('reaches a Redis waiter after one poll interval when another store submits it', async () => {
    vi.useFakeTimers();
    const client = fakeRedis();
    const waiter = track(new RedisApprovalStore({ client, pollInterval: POLL }));
    const responder = track(new RedisApprovalStore({ client, pollInterval: POLL }));
    const callback = vi.fn();
    await waiter.createRequest(request('r1'));
    waiter.onResponse('r1', callback);
    await vi.advanceTimersByTimeAsync(0);

    await responder.submitResponse(response('r1'));
    await vi.advanceTimersByTimeAsync(POLL - 1);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledWith(response('r1'));

    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reaches a Postgres waiter when the response row is written directly', async () => {
    vi.useFakeTimers();
    const answered = new Map<string, ApprovalResponse>();
    const client = fakePostgres((sql, values) => {
      const found = sql.includes('_responses WHERE request_id')
        ? answered.get(String(values[0]))
        : undefined;
      return found ? [{ data: found }] : [];
    });
    const store = track(new PostgresApprovalStore({ client, pollInterval: POLL }));
    const first = vi.fn();
    const second = vi.fn();
    store.onResponse('r1', first);
    store.onResponse('r1', second);
    await vi.advanceTimersByTimeAsync(POLL);

    answered.set('r1', response('r1'));
    await vi.advanceTimersByTimeAsync(POLL);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops polling once the last callback unsubscribes', async () => {
    vi.useFakeTimers();
    const client = fakeRedis();
    const get = vi.spyOn(client, 'get');
    const store = track(new RedisApprovalStore({ client, pollInterval: POLL }));
    const callback = vi.fn();
    const unsubscribeFirst = store.onResponse('r1', callback);
    const unsubscribeSecond = store.onResponse('r1', callback);
    await vi.advanceTimersByTimeAsync(POLL * 2);
    const checksWhileWaiting = get.mock.calls.length;
    expect(checksWhileWaiting).toBe(4);

    unsubscribeFirst();
    await vi.advanceTimersByTimeAsync(POLL);
    expect(get.mock.calls.length).toBe(checksWhileWaiting + 1);

    unsubscribeSecond();
    expect(vi.getTimerCount()).toBe(0);
    client.strings.set('cogitator:workflow-approvals:response:r1', JSON.stringify(response('r1')));
    await vi.advanceTimersByTimeAsync(POLL * 5);

    expect(get.mock.calls.length).toBe(checksWhileWaiting + 1);
    expect(callback).not.toHaveBeenCalled();
  });

  it('calls back on the next tick when the response is already stored', async () => {
    vi.useFakeTimers();
    const client = fakeRedis();
    client.strings.set('cogitator:workflow-approvals:response:r1', JSON.stringify(response('r1')));
    const store = track(new RedisApprovalStore({ client, pollInterval: POLL }));
    const callback = vi.fn();

    store.onResponse('r1', callback);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);

    expect(callback).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps polling through backend errors and reports them', async () => {
    vi.useFakeTimers();
    const client = fakeRedis();
    const outage = new Error('connection lost');
    vi.spyOn(client, 'get').mockRejectedValueOnce(outage).mockRejectedValueOnce(outage);
    const onPollError = vi.fn();
    const store = track(new RedisApprovalStore({ client, pollInterval: POLL, onPollError }));
    const callback = vi.fn();

    store.onResponse('r1', callback);
    await vi.advanceTimersByTimeAsync(POLL);
    client.strings.set('cogitator:workflow-approvals:response:r1', JSON.stringify(response('r1')));
    await vi.advanceTimersByTimeAsync(POLL);

    expect(onPollError).toHaveBeenCalledTimes(2);
    expect(onPollError).toHaveBeenCalledWith(outage, 'r1');
    expect(callback).toHaveBeenCalledWith(response('r1'));
  });

  it('stops every poll on dispose', async () => {
    vi.useFakeTimers();
    const store = new RedisApprovalStore({ client: fakeRedis(), pollInterval: POLL });
    store.onResponse('r1', vi.fn());
    store.onResponse('r2', vi.fn());
    expect(vi.getTimerCount()).toBe(2);

    store.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });
});
