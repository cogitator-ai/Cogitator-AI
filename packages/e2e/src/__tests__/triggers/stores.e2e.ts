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
async function contract(
  routines: RoutineStore,
  others: RoutineStore[],
  inbox: InboxStore,
  otherInbox: InboxStore
) {
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

  const state = `r-${tag}.api`;
  await routines.saveTriggerState({ id: state, routineId: `r-${tag}`, fireCount: 0 });
  await Promise.all([
    ...[routines, ...others].flatMap((store) =>
      Array.from({ length: 4 }, () =>
        store.patchTriggerState(state, `r-${tag}`, {
          fireCountDelta: 1,
          lastFiredAt: 1_761_571_200_123,
        })
      )
    ),
    others[0].patchTriggerState(state, `r-${tag}`, { tokenHash: 'h2', tokenHint: 'abcd' }),
    routines.patchTriggerState(state, `r-${tag}`, { enabled: false }),
  ]);
  expect(await others[0].getTriggerState(state)).toEqual({
    id: state,
    routineId: `r-${tag}`,
    fireCount: 4 * (others.length + 1),
    lastFiredAt: 1_761_571_200_123,
    tokenHash: 'h2',
    tokenHint: 'abcd',
    enabled: false,
  });

  const active = {
    runId: `trg_r-${tag}.api.k`,
    kind: 'routine' as const,
    eventId: `evt-${tag}`,
    triggerId: `r-${tag}.api`,
    routineId: `r-${tag}`,
    source: 'api' as const,
    at: 1,
    threadId: `t-${tag}`,
  };
  await routines.saveActiveRun(active);
  expect(await others[0].getActiveRun(active.runId)).toEqual(active);
  expect((await others[0].listActiveRuns()).map((run) => run.runId)).toContain(active.runId);
  await others[0].deleteActiveRun(active.runId);
  expect(await routines.getActiveRun(active.runId)).toBeNull();

  for (const id of ['a', 'b', 'c']) {
    await inbox.add({
      id: `same-${tag}-${id}`,
      kind: 'approval',
      title: id,
      summary: '',
      status: 'unread',
      createdAt: 10,
      userId: `v-${tag}`,
    });
  }
  const seen: string[] = [];
  let cursor: { before: number; beforeId: string } | undefined;
  for (let at = 0; at < 5; at++) {
    const [next] = await otherInbox.list({ userId: `v-${tag}`, limit: 1, ...cursor });
    if (!next) break;
    seen.push(next.id);
    cursor = { before: next.createdAt, beforeId: next.id };
  }
  expect(seen).toEqual([`same-${tag}-c`, `same-${tag}-b`, `same-${tag}-a`]);
  const claims = await Promise.all([
    inbox.claimAnswer(`same-${tag}-a`, 20),
    otherInbox.claimAnswer(`same-${tag}-a`, 21),
    inbox.claimAnswer(`same-${tag}-a`, 22),
  ]);
  expect(claims.filter((claimed) => claimed !== null)).toHaveLength(1);
  expect(await otherInbox.update(`same-${tag}-a`, { status: 'unread' })).toMatchObject({
    status: 'unread',
  });
  expect((await inbox.get(`same-${tag}-a`))?.answeredAt).toBeDefined();
  expect(
    (await inbox.list({ userId: `v-${tag}`, status: 'unread' })).map((item) => item.id).sort()
  ).toEqual([`same-${tag}-a`, `same-${tag}-b`, `same-${tag}-c`]);
  await inbox.releaseAnswer(`same-${tag}-a`);
  expect((await otherInbox.get(`same-${tag}-a`))?.answeredAt).toBeUndefined();

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
      new experimental_RedisInboxStore({ client: a, keyPrefix: `e2e-inbox-${tag}` }),
      new experimental_RedisInboxStore({ client: b, keyPrefix: `e2e-inbox-${tag}` })
    );
  });
});

describePostgres('routine and inbox stores on Postgres', () => {
  const pools: pg.Pool[] = [];
  afterAll(async () => {
    const [pool] = pools;
    if (pool) {
      for (const table of ['defs', 'triggers', 'claims', 'runs', 'active']) {
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
      new experimental_PostgresInboxStore({ client: a, table: `e2e_inbox_${tag}` }),
      new experimental_PostgresInboxStore({ client: b, table: `e2e_inbox_${tag}` })
    );
  });
});
