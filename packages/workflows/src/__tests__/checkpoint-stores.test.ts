import { describe, it, expect } from 'vitest';
import type { CheckpointStore, WorkflowCheckpoint } from '@cogitator-ai/types';
import {
  PostgresCheckpointStore,
  RedisCheckpointStore,
  type CheckpointPgClient,
  type CheckpointRedisClient,
} from '../checkpoint-stores';

/** Enough of Redis for the store: strings and sorted sets. */
function fakeRedis(): CheckpointRedisClient {
  const strings = new Map<string, string>();
  const sets = new Map<string, Map<string, number>>();
  return {
    get: async (key) => strings.get(key) ?? null,
    set: async (key, value) => {
      strings.set(key, value);
      return 'OK';
    },
    del: async (...keys) => keys.filter((key) => strings.delete(key)).length,
    zadd: async (key, score, member) => {
      const set = sets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sets.set(key, set);
      return 1;
    },
    zrange: async (key) =>
      [...(sets.get(key) ?? new Map<string, number>()).entries()]
        .sort(([, a], [, b]) => a - b)
        .map(([member]) => member),
    zrem: async (key, ...members) => {
      for (const member of members) sets.get(key)?.delete(member);
      return members.length;
    },
  };
}

/** A table of checkpoint rows behind the SQL the store sends. */
function fakePostgres(): CheckpointPgClient & { statements: string[] } {
  const rows = new Map<string, { workflow_name: string; data: string; created_at: number }>();
  const statements: string[] = [];
  return {
    statements,
    query: async (text, values = []) => {
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('CREATE')) return { rows: [] };
      if (text.startsWith('INSERT')) {
        const [id, workflowName, data, createdAt] = values as [string, string, string, number];
        rows.set(id, { workflow_name: workflowName, data, created_at: createdAt });
        return { rows: [] };
      }
      if (text.startsWith('DELETE')) {
        rows.delete(values[0] as string);
        return { rows: [] };
      }
      if (text.includes('WHERE id')) {
        const row = rows.get(values[0] as string);
        return { rows: row ? [{ data: JSON.parse(row.data) as unknown }] : [] };
      }
      return {
        rows: [...rows.values()]
          .filter((row) => row.workflow_name === values[0])
          .sort((a, b) => b.created_at - a.created_at)
          .map((row) => ({ data: row.data })),
      };
    },
  };
}

const checkpoint = (id: string, workflowName: string, timestamp: number): WorkflowCheckpoint => ({
  id,
  workflowId: `wf_${id}`,
  workflowName,
  state: { step: id },
  completedNodes: ['a'],
  nodeResults: { a: { ok: true } },
  timestamp,
});

describe.each<[string, () => CheckpointStore]>([
  ['RedisCheckpointStore', () => new RedisCheckpointStore({ client: fakeRedis() })],
  ['PostgresCheckpointStore', () => new PostgresCheckpointStore({ client: fakePostgres() })],
])('%s', (_name, createStore) => {
  it('saves, loads, lists newest first per workflow and deletes', async () => {
    const store = createStore();
    await store.save(checkpoint('c1', 'orders', 100));
    await store.save(checkpoint('c2', 'orders', 300));
    await store.save(checkpoint('c3', 'billing', 200));

    expect(await store.load('c2')).toEqual(checkpoint('c2', 'orders', 300));
    expect((await store.list('orders')).map((c) => c.id)).toEqual(['c2', 'c1']);
    expect((await store.list('billing')).map((c) => c.id)).toEqual(['c3']);

    await store.delete('c2');
    expect(await store.load('c2')).toBeNull();
    expect((await store.list('orders')).map((c) => c.id)).toEqual(['c1']);
    expect(await store.load('missing')).toBeNull();
  });

  it('overwrites a checkpoint saved again under the same id', async () => {
    const store = createStore();
    await store.save(checkpoint('c1', 'orders', 100));
    await store.save({ ...checkpoint('c1', 'refunds', 500), completedNodes: ['a', 'b'] });

    expect((await store.load('c1'))?.completedNodes).toEqual(['a', 'b']);
    expect(await store.list('orders')).toEqual([]);
    expect((await store.list('refunds')).map((c) => c.id)).toEqual(['c1']);
  });
});

describe('PostgresCheckpointStore', () => {
  it('creates its table once, before the first query', async () => {
    const client = fakePostgres();
    const store = new PostgresCheckpointStore({ client, table: 'app.checkpoints' });

    await store.save(checkpoint('c1', 'orders', 1));
    await store.load('c1');

    const creates = client.statements.filter((sql) => sql.startsWith('CREATE'));
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain('CREATE TABLE IF NOT EXISTS app.checkpoints');
  });

  it('refuses table names that are not plain identifiers', () => {
    expect(
      () => new PostgresCheckpointStore({ client: fakePostgres(), table: 'x; DROP TABLE y' })
    ).toThrow('Invalid checkpoint table name');
  });
});

describe('resuming from a checkpoint', () => {
  it('runs only what is left and hands finished outputs to the next node', async () => {
    const { WorkflowBuilder } = await import('../builder');
    const { WorkflowExecutor } = await import('../executor');
    const { InMemoryCheckpointStore } = await import('../checkpoint');
    const runs: string[] = [];
    let emailWorks = false;
    const workflow = new WorkflowBuilder<{ sent?: string }>('orders')
      .initialState({})
      .addNode('charge', async () => {
        runs.push('charge');
        return { output: 'receipt-1' };
      })
      .addNode(
        'ship',
        async (ctx) => {
          runs.push('ship');
          return { output: `parcel for ${String(ctx.input)}` };
        },
        { after: ['charge'] }
      )
      .addNode(
        'email',
        async (ctx) => {
          runs.push('email');
          if (!emailWorks) throw new Error('mail server down');
          return { state: { sent: String(ctx.input) } };
        },
        { after: ['ship'] }
      )
      .build();
    const store = new InMemoryCheckpointStore();
    const executor = new WorkflowExecutor({} as never, store);

    await executor.execute(workflow, undefined, {
      checkpoint: true,
      checkpointStrategy: 'per-node',
    });
    const [latest] = await store.list('orders');
    emailWorks = true;
    const resumed = await executor.resume(workflow, latest.id);

    expect(runs).toEqual(['charge', 'ship', 'email', 'email']);
    expect(resumed.state.sent).toBe('parcel for receipt-1');
  });
});

describe('replaying a run from a node', () => {
  it('runs that node and everything after it again, keeping what came before', async () => {
    const { WorkflowBuilder } = await import('../builder');
    const { InMemoryCheckpointStore } = await import('../checkpoint');
    const { createWorkflowManager } = await import('../manager/index');
    const runs: string[] = [];
    const workflow = new WorkflowBuilder<{ total?: string }>('pipeline')
      .initialState({})
      .addNode('fetch', async () => {
        runs.push('fetch');
        return { output: 'data' };
      })
      .addNode(
        'clean',
        async (ctx) => {
          runs.push('clean');
          return { output: `clean ${String(ctx.input)}` };
        },
        { after: ['fetch'] }
      )
      .addNode(
        'report',
        async (ctx) => {
          runs.push('report');
          return { state: { total: String(ctx.input) } };
        },
        { after: ['clean'] }
      )
      .build();
    const manager = createWorkflowManager({
      cogitator: {} as never,
      checkpointStore: new InMemoryCheckpointStore(),
    });

    await manager.execute(workflow);
    const [run] = await manager.listRuns({ workflowName: 'pipeline' });
    runs.length = 0;
    const replayed = await manager.replay(workflow, run.id, 'clean');

    expect(runs).toEqual(['clean', 'report']);
    expect(replayed.state.total).toBe('clean data');
    manager.dispose();
  });
});
