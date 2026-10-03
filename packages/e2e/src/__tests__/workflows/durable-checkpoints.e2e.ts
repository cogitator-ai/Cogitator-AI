import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Cogitator } from '@cogitator-ai/core';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import {
  PostgresCheckpointStore,
  RedisCheckpointStore,
  WorkflowBuilder,
  WorkflowExecutor,
} from '@cogitator-ai/workflows';
import type { CheckpointStore, Workflow, WorkflowState } from '@cogitator-ai/types';

const describeRedis = process.env.TEST_REDIS === 'true' ? describe : describe.skip;
const describePostgres = process.env.TEST_POSTGRES_URL ? describe : describe.skip;

interface OrderState extends WorkflowState {
  charged?: boolean;
  shipped?: boolean;
  emailed?: boolean;
}

/** charge → ship → email; `email` fails until `emailWorks` is set. */
function orderWorkflow(name: string) {
  const runs = { charge: 0, ship: 0, email: 0 };
  const control = { emailWorks: false };
  const workflow = new WorkflowBuilder<OrderState>(name)
    .initialState({})
    .addNode('charge', async () => {
      runs.charge++;
      return { state: { charged: true } };
    })
    .addNode(
      'ship',
      async () => {
        runs.ship++;
        return { state: { shipped: true } };
      },
      { after: ['charge'] }
    )
    .addNode(
      'email',
      async () => {
        runs.email++;
        if (!control.emailWorks) throw new Error('mail server down');
        return { state: { emailed: true } };
      },
      { after: ['ship'] }
    )
    .build() as unknown as Workflow<WorkflowState>;
  return { workflow, runs, control };
}

/** A failed run leaves a checkpoint another executor, with a fresh store, resumes from. */
async function resumesAcrossExecutors(createStore: () => CheckpointStore, name: string) {
  const cogitator = new Cogitator();
  const { workflow, runs, control } = orderWorkflow(name);

  const failed = await new WorkflowExecutor(cogitator, createStore()).execute(workflow, undefined, {
    checkpoint: true,
    checkpointStrategy: 'per-node',
  });
  expect(failed.error?.message).toContain('mail server down');

  const store = createStore();
  const [latest] = await store.list(name);
  expect(latest.completedNodes.sort()).toEqual(['charge', 'ship']);

  control.emailWorks = true;
  const resumed = await new WorkflowExecutor(cogitator, store).resume(workflow, latest.id);

  expect(resumed.error).toBeUndefined();
  expect(resumed.state).toMatchObject({ charged: true, shipped: true, emailed: true });
  expect(runs).toEqual({ charge: 1, ship: 1, email: 2 });

  for (const checkpoint of await store.list(name)) await store.delete(checkpoint.id);
  expect(await store.list(name)).toEqual([]);
  await cogitator.close();
}

describeRedis('Workflows: checkpoints in Redis', () => {
  let client: RedisClient;

  beforeAll(async () => {
    client = await createRedisClient({ url: 'redis://localhost:6379' });
  });

  afterAll(async () => {
    await client.quit();
  });

  it('resumes a failed workflow in another executor', async () => {
    const prefix = `e2e:wf:${Date.now()}`;
    await resumesAcrossExecutors(
      () => new RedisCheckpointStore({ client, keyPrefix: prefix }),
      `orders-redis-${Date.now()}`
    );
  });
});

describePostgres('Workflows: checkpoints in Postgres', () => {
  let pool: pg.Pool;
  const table = `wf_checkpoints_${Date.now()}`;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_POSTGRES_URL });
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  });

  it('resumes a failed workflow in another executor', async () => {
    await resumesAcrossExecutors(
      () => new PostgresCheckpointStore({ client: pool, table }),
      `orders-pg-${Date.now()}`
    );
  });
});
