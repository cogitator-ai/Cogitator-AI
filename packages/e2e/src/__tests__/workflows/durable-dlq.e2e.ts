import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  InMemoryCheckpointStore,
  PostgresDLQ,
  WorkflowBuilder,
  createWorkflowManager,
} from '@cogitator-ai/workflows';
import type { DeadLetterEntry } from '@cogitator-ai/types';

const describePostgres = process.env.TEST_POSTGRES_URL ? describe : describe.skip;

function entry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    id: '',
    workflowId: 'run-1',
    workflowName: 'orders',
    nodeId: 'charge',
    error: { message: 'card declined', name: 'Error' },
    state: { amount: 42.5, nested: { ok: false } },
    input: { attempt: 1 },
    attempts: 2,
    maxAttempts: 3,
    lastAttempt: 0,
    createdAt: 0,
    tags: ['payments'],
    ...overrides,
  };
}

describePostgres('PostgresDLQ', () => {
  let pool: pg.Pool;
  const tables: string[] = [];
  const newQueue = (ttl?: number) => {
    const table = `wf_dlq_${Date.now()}_${tables.length}`;
    tables.push(table);
    return new PostgresDLQ({ client: pool, table, ...(ttl !== undefined && { defaultTTL: ttl }) });
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_POSTGRES_URL });
  });

  afterAll(async () => {
    for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  });

  it('stores entries whole and filters them like the in-memory queue', async () => {
    const dlq = newQueue();
    const first = await dlq.add(entry());
    await dlq.add(entry({ workflowId: 'run-2', nodeId: 'ship', tags: ['shipping'] }));

    const stored = await dlq.get(first);
    expect(stored).toMatchObject({ id: first, nodeId: 'charge', state: { nested: { ok: false } } });
    expect((await dlq.list({ nodeId: 'ship' })).map((e) => e.workflowId)).toEqual(['run-2']);
    expect(await dlq.count({ tags: ['payments'] })).toBe(1);
    expect(await dlq.count({ minAttempts: 3 })).toBe(0);
    expect(await dlq.list({ limit: 1 })).toHaveLength(1);
  });

  it('records retry attempts and removes entries', async () => {
    const dlq = newQueue();
    const id = await dlq.add(entry());

    expect(await dlq.retry(id)).toBe(true);
    const retried = await dlq.get(id);
    expect(retried?.attempts).toBe(3);
    expect(retried?.lastAttempt).toBeGreaterThan(0);
    expect(await dlq.count({ minAttempts: 3 })).toBe(1);

    expect(await dlq.remove(id)).toBe(true);
    expect(await dlq.remove(id)).toBe(false);
    expect(await dlq.retry(id)).toBe(false);
  });

  it('hides expired entries and cleans them up', async () => {
    const dlq = newQueue(1);
    await dlq.add(entry());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await dlq.count()).toBe(0);
    expect(await dlq.cleanupExpired()).toBe(1);
  });

  it('feeds WorkflowManager.retryDeadLetter across processes', async () => {
    const dlq = newQueue();
    let failuresLeft = 1;
    const workflow = new WorkflowBuilder<{ shipped?: boolean }>(`dlq-pg-${Date.now()}`)
      .initialState({})
      .addNode('ship', async () => {
        if (failuresLeft-- > 0) throw new Error('carrier down');
        return { state: { shipped: true } };
      })
      .build();
    const manager = createWorkflowManager({
      cogitator: {} as never,
      checkpointStore: new InMemoryCheckpointStore(),
    });

    await manager.execute(workflow, undefined, { deadLetterQueue: dlq });
    const [failed] = await new PostgresDLQ({ client: pool, table: tables.at(-1) }).list();
    const result = await manager.retryDeadLetter<{ shipped?: boolean }>(dlq, failed!.id);

    expect(result.state.shipped).toBe(true);
    expect(await dlq.count()).toBe(0);
  });
});
