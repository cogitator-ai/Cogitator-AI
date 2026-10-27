import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  experimental_PostgresInboxStore,
  experimental_PostgresRoutineStore,
  experimental_RedisInboxStore,
  experimental_RedisRoutineStore,
} from '@cogitator-ai/core';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import type { InboxStore, RoutineStore } from '@cogitator-ai/types';

const describeRedis = describe.skipIf(process.env.TEST_REDIS !== 'true');
const postgresUrl = process.env.TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!postgresUrl);
const tag = randomUUID().replace(/-/g, '').slice(0, 8);

/** What every shared store must do: one winner per claim among workers, history, inbox paging */
async function contract(routines: RoutineStore, others: RoutineStore[], inbox: InboxStore) {
  await routines.saveRoutine({
    id: `r-${tag}`,
    prompt: 'p',
    target: { agent: 'a' },
    triggers: [{ kind: 'webhook', secret: { env: 'HOOK' } }],
  });
  expect((await routines.getRoutine(`r-${tag}`))?.triggers).toHaveLength(1);

  const winners = await Promise.all(
    [routines, ...others].flatMap((store) =>
      Array.from({ length: 5 }, () => store.claimKey(`run:${tag}`, 60_000))
    )
  );
  expect(winners.filter(Boolean)).toHaveLength(1);
  expect(await routines.claimKey(`short:${tag}`, 50)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(await others[0].claimKey(`short:${tag}`, 50)).toBe(true);

  for (let at = 1; at <= 3; at++) {
    await routines.recordRun({
      id: `evt-${tag}-${at}`,
      routineId: `r-${tag}`,
      triggerId: `r-${tag}.webhook`,
      source: 'webhook',
      at,
      status: 'completed',
    });
  }
  expect(
    (await others[0].listRuns({ routineId: `r-${tag}`, limit: 2 })).map((run) => run.at)
  ).toEqual([3, 2]);

  for (let at = 1; at <= 3; at++) {
    await inbox.add({
      id: `i-${tag}-${at}`,
      kind: at === 2 ? 'failure' : 'result',
      title: `item ${at}`,
      summary: '',
      status: 'unread',
      createdAt: at,
      userId: `u-${tag}`,
    });
  }
  const page = await inbox.list({ userId: `u-${tag}`, limit: 2 });
  expect(page.map((item) => item.id)).toEqual([`i-${tag}-3`, `i-${tag}-2`]);
  expect(
    (await inbox.list({ userId: `u-${tag}`, kind: 'failure' })).map((item) => item.id)
  ).toEqual([`i-${tag}-2`]);
  expect(await inbox.update(`i-${tag}-1`, { status: 'archived' })).toMatchObject({
    status: 'archived',
  });
  expect((await inbox.list({ userId: `u-${tag}`, status: 'unread' })).length).toBe(2);
  await routines.deleteRoutine(`r-${tag}`);
  expect(await routines.getRoutine(`r-${tag}`)).toBeNull();
}

describeRedis('routine and inbox stores on Redis', () => {
  const clients: RedisClient[] = [];
  afterAll(async () => {
    for (const client of clients) await client.quit();
  });

  it('keeps routines, claims once across workers, pages the inbox', async () => {
    const connect = async () => {
      const client = await createRedisClient({
        mode: 'standalone',
        url: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379',
      });
      clients.push(client);
      return client;
    };
    const prefix = `e2e-routines-${tag}`;
    const [a, b] = [await connect(), await connect()];
    await contract(
      new experimental_RedisRoutineStore({ client: a, keyPrefix: prefix }),
      [new experimental_RedisRoutineStore({ client: b, keyPrefix: prefix })],
      new experimental_RedisInboxStore({ client: a, keyPrefix: `e2e-inbox-${tag}` })
    );
  });
});

describePostgres('routine and inbox stores on Postgres', () => {
  const pools: pg.Pool[] = [];
  afterAll(async () => {
    const [pool] = pools;
    if (pool) {
      for (const table of ['defs', 'triggers', 'claims', 'runs']) {
        await pool.query(`DROP TABLE IF EXISTS e2e_routines_${tag}_${table}`);
      }
      await pool.query(`DROP TABLE IF EXISTS e2e_inbox_${tag}`);
    }
    for (const each of pools) await each.end();
  });

  it('keeps routines, claims once across workers, pages the inbox', async () => {
    const connect = () => {
      const pool = new pg.Pool({ connectionString: postgresUrl });
      pools.push(pool);
      return pool;
    };
    const prefix = `e2e_routines_${tag}`;
    const [a, b] = [connect(), connect()];
    await contract(
      new experimental_PostgresRoutineStore({ client: a, tablePrefix: prefix }),
      [new experimental_PostgresRoutineStore({ client: b, tablePrefix: prefix })],
      new experimental_PostgresInboxStore({ client: a, table: `e2e_inbox_${tag}` })
    );
  });
});
