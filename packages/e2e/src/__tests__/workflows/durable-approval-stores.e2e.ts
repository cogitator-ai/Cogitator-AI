import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import pg from 'pg';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import {
  ApprovalAlreadyAnsweredError,
  PostgresApprovalStore,
  RedisApprovalStore,
  WITHDRAWN,
  executeHumanNode,
} from '@cogitator-ai/workflows';
import type { ApprovalRequest, ApprovalResponse, ApprovalStore } from '@cogitator-ai/types';

const describeRedis = process.env.TEST_REDIS === 'true' ? describe : describe.skip;
const describePostgres = process.env.TEST_POSTGRES_URL ? describe : describe.skip;

type DurableStore = ApprovalStore & { dispose(): void };

const POLL_INTERVAL = 50;

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

/**
 * The ApprovalStore contract against a real backend. `createStore` returns a
 * new store instance on the same backend each call, like a second process.
 */
function approvalStoreContract(createStore: (pollInterval: number) => DurableStore) {
  const opened: DurableStore[] = [];
  const open = (pollInterval = POLL_INTERVAL) => {
    const store = createStore(pollInterval);
    opened.push(store);
    return store;
  };

  afterEach(() => {
    for (const store of opened.splice(0)) store.dispose();
  });

  it('stores requests and responses and lists pending ones by workflow and assignee', async () => {
    const store = open();
    await store.createRequest(request('r1', { createdAt: 1, assignee: 'alice' }));
    await store.createRequest(
      request('r2', { createdAt: 2, workflowId: 'billing', assigneeGroup: ['alice', 'bob'] })
    );
    await store.createRequest(request('r3', { createdAt: 3, assignee: 'bob' }));
    await store.submitResponse(response('r3', { comment: 'done' }));

    expect(await store.getRequest('r1')).toEqual(
      request('r1', { createdAt: 1, assignee: 'alice' })
    );
    expect(await store.getRequest('missing')).toBeNull();
    expect(await store.getResponse('r3')).toEqual(response('r3', { comment: 'done' }));
    expect(await store.getResponse('r1')).toBeNull();

    expect(ids(await store.getPendingRequests())).toEqual(['r1', 'r2']);
    expect(ids(await store.getPendingRequests('orders'))).toEqual(['r1']);
    expect(ids(await store.getPendingRequests('billing'))).toEqual(['r2']);
    expect(ids(await store.getPendingForAssignee('alice'))).toEqual(['r1', 'r2']);
    expect(ids(await store.getPendingForAssignee('bob'))).toEqual(['r2']);
    expect(await store.getPendingForAssignee('carol')).toEqual([]);
  });

  it('moves a request between lists when it is created again with new routing', async () => {
    const store = open();
    await store.createRequest(request('r1', { assignee: 'alice' }));
    await store.createRequest(request('r1', { assignee: 'bob', workflowId: 'billing' }));

    expect(await store.getPendingForAssignee('alice')).toEqual([]);
    expect(ids(await store.getPendingForAssignee('bob'))).toEqual(['r1']);
    expect(await store.getPendingRequests('orders')).toEqual([]);
    expect(ids(await store.getPendingRequests('billing'))).toEqual(['r1']);
  });

  it('deletes a request together with its response', async () => {
    const store = open();
    await store.createRequest(request('r1', { assignee: 'alice' }));
    await store.createRequest(request('r2', { assignee: 'alice' }));
    await store.submitResponse(response('r1'));
    await store.deleteRequest('r1');
    await store.deleteRequest('r2');

    expect(await store.getRequest('r1')).toBeNull();
    expect(await store.getResponse('r1')).toBeNull();
    expect(await store.getPendingRequests()).toEqual([]);
    expect(await store.getPendingForAssignee('alice')).toEqual([]);
  });

  it('calls every local waiter once when the response is submitted through the store', async () => {
    const store = open();
    const first = vi.fn();
    const second = vi.fn();
    const dropped = vi.fn();
    await store.createRequest(request('r1'));
    store.onResponse('r1', first);
    store.onResponse('r1', second);
    store.onResponse('r1', dropped)();

    await store.submitResponse(response('r1'));
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL * 3));

    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith(response('r1'));
    expect(second).toHaveBeenCalledOnce();
    expect(dropped).not.toHaveBeenCalled();
  });

  it('calls back without waiting for a poll when the response is already stored', async () => {
    const store = open(60_000);
    await store.submitResponse(response('r1'));
    const callback = vi.fn();

    store.onResponse('r1', callback);

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(response('r1')), {
      timeout: 1000,
      interval: 5,
    });
  });

  it('delivers a response submitted by another store instance to the waiting one', async () => {
    const worker = open();
    const server = open();
    await worker.createRequest(request('r1', { assignee: 'alice' }));
    const received = new Promise<ApprovalResponse>((resolve) => worker.onResponse('r1', resolve));

    const [pending] = await server.getPendingForAssignee('alice');
    await server.submitResponse(response(pending.id, { decision: false, comment: 'not yet' }));

    expect(await received).toEqual(response('r1', { decision: false, comment: 'not yet' }));
    expect(await worker.getPendingRequests()).toEqual([]);
  });

  it('lets exactly one of two concurrent answers win', async () => {
    const alice = open();
    const bob = open();
    await alice.createRequest(request('r1', { assignee: 'alice', assigneeGroup: ['bob'] }));

    const outcomes = await Promise.allSettled([
      alice.submitResponse(response('r1', { respondedBy: 'alice', decision: true })),
      bob.submitResponse(response('r1', { respondedBy: 'bob', decision: false })),
    ]);

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalAlreadyAnsweredError);
    const standing = await alice.getResponse('r1');
    expect(standing?.respondedBy).toBe(outcomes[0].status === 'fulfilled' ? 'alice' : 'bob');
  });

  it('tells a waiter in another process that its request was withdrawn', async () => {
    const worker = open();
    const server = open();
    await worker.createRequest(request('r1'));
    const received = new Promise<ApprovalResponse>((resolve) => worker.onResponse('r1', resolve));

    await server.deleteRequest('r1');

    expect((await received).respondedBy).toBe(WITHDRAWN);
    expect(await worker.getRequest('r1')).toBeNull();
  });

  it('resumes a human node in one process when another answers the approval', async () => {
    const worker = open();
    const server = open();

    const decision = executeHumanNode(
      { order: 42 },
      {
        name: 'approve-shipping',
        approval: { type: 'approve-reject', title: 'Ship order 42?', assignee: 'alice' },
      },
      { workflowId: 'orders', runId: 'run_42', nodeId: 'approve-shipping', approvalStore: worker }
    );

    const pending = await vi.waitFor(
      async () => {
        const [found] = await server.getPendingForAssignee('alice');
        expect(found?.title).toBe('Ship order 42?');
        return found;
      },
      { timeout: 2000, interval: 20 }
    );
    await server.submitResponse({
      requestId: pending.id,
      decision: true,
      respondedBy: 'alice',
      respondedAt: Date.now(),
    });

    const result = await decision;
    expect(result.approved).toBe(true);
    expect(result.response.requestId).toBe(pending.id);
    expect(result.state).toEqual({ order: 42 });
  });
}

describeRedis('Workflows: approvals in Redis', () => {
  let client: RedisClient;
  const base = `e2e:approvals:${Date.now()}`;
  let prefix = `${base}:0`;
  let run = 0;

  beforeAll(async () => {
    client = await createRedisClient({ url: 'redis://localhost:6379' });
  });

  afterEach(async () => {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) await client.del(...keys);
    run++;
    prefix = `${base}:${run}`;
  });

  afterAll(async () => {
    await client.quit();
  });

  approvalStoreContract(
    (pollInterval) => new RedisApprovalStore({ client, keyPrefix: prefix, pollInterval })
  );
});

describePostgres('Workflows: approvals in Postgres', () => {
  let pool: pg.Pool;
  const base = `wf_approvals_${Date.now()}`;
  let tablePrefix = `${base}_0`;
  let run = 0;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_POSTGRES_URL });
  });

  afterEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${tablePrefix}_requests, ${tablePrefix}_responses`);
    run++;
    tablePrefix = `${base}_${run}`;
  });

  afterAll(async () => {
    await pool.end();
  });

  approvalStoreContract(
    (pollInterval) => new PostgresApprovalStore({ client: pool, tablePrefix, pollInterval })
  );
});
