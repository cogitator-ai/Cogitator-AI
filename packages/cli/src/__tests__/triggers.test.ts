import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_fileTriggerStores, hashTriggerToken } from '@cogitator-ai/core';
import {
  runInboxList,
  runInboxMark,
  runInboxShow,
  runScheduleAdd,
  runScheduleList,
  runSchedulePause,
  runScheduleRemove,
  runScheduleRun,
  runTriggerFire,
  runTriggerToken,
  type TriggersContext,
} from '../commands/triggers.js';

let dir: string;
let lines: string[];
let context: TriggersContext;
const fetcher = vi.fn<typeof fetch>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cogitator-cli-triggers-'));
  lines = [];
  fetcher.mockReset();
  context = {
    io: { print: (line) => lines.push(line) },
    stores: () => experimental_fileTriggerStores(dir),
    fetch: fetcher,
    env: {},
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const output = () => lines.join('\n');

describe('cogitator schedule', () => {
  it('adds a routine on a cron schedule, lists, runs, pauses, resumes and removes it', async () => {
    expect(
      await runScheduleAdd(
        'digest',
        { cron: '0 9 * * 1-5', timezone: 'Europe/Moscow', agent: 'assistant', prompt: 'Summarize' },
        context
      )
    ).toBe(0);
    expect(output()).toContain('Routine digest added, next run');

    const stores = experimental_fileTriggerStores(dir);
    const [entry] = await stores.schedules.getPending();
    expect(entry).toMatchObject({
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Moscow',
      trigger: { routineId: 'digest', triggerId: 'cron' },
    });

    lines = [];
    expect(await runScheduleList({}, context)).toBe(0);
    expect(output()).toContain('digest');
    expect(output()).toContain('digest.cron');

    expect(await runScheduleRun('digest', {}, context)).toBe(0);
    expect((await stores.schedules.get(entry.id))!.firesAt).toBeLessThanOrEqual(Date.now());

    expect(await runSchedulePause('digest.cron', false, {}, context)).toBe(0);
    expect((await stores.schedules.get(entry.id))!.enabled).toBe(false);
    expect((await stores.store.getTriggerState('digest.cron'))!.enabled).toBe(false);
    expect(await runSchedulePause('digest', true, {}, context)).toBe(0);
    expect((await stores.schedules.get(entry.id))!.enabled).toBe(true);

    expect(await runScheduleRemove('digest', {}, context)).toBe(0);
    expect(await stores.schedules.getPending()).toEqual([]);
    expect(await stores.store.listRoutines()).toEqual([]);
  });

  it('pauses a trigger without overwriting what a runtime changed meanwhile', async () => {
    const stores = experimental_fileTriggerStores(dir);
    await stores.store.saveTriggerState({
      id: 'digest.api',
      routineId: 'digest',
      fireCount: 3,
      tokenHash: 'old',
    });
    const late = new Proxy(stores.store, {
      get(target, property, receiver) {
        if (property === 'getTriggerState') {
          return async (id: string) => {
            const state = await target.getTriggerState(id);
            await new Promise((resolve) => setTimeout(resolve, 30));
            return state;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const paused = runSchedulePause(
      'digest.api',
      false,
      {},
      {
        ...context,
        stores: () => ({ ...stores, store: late }),
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await experimental_fileTriggerStores(dir).store.patchTriggerState('digest.api', 'digest', {
      tokenHash: 'new',
      fireCountDelta: 1,
    });
    expect(await paused).toBe(0);
    expect(await stores.store.getTriggerState('digest.api')).toMatchObject({
      enabled: false,
      tokenHash: 'new',
      fireCount: 4,
    });
  });

  it('refuses a cron expression it cannot run and a missing target', async () => {
    expect(
      await runScheduleAdd('bad', { cron: 'every day', agent: 'a', prompt: 'p' }, context)
    ).toBe(1);
    expect(await runScheduleAdd('none', { cron: '@daily', prompt: 'p' }, context)).toBe(2);
    expect(await runScheduleRun('missing', {}, context)).toBe(1);
  });
});

describe('cogitator inbox', () => {
  it('lists unread items and marks, shows and archives them', async () => {
    const stores = experimental_fileTriggerStores(dir);
    await stores.inbox.add({
      id: 'i1',
      kind: 'result',
      title: 'Digest',
      summary: 'quiet day',
      status: 'unread',
      createdAt: 1,
      body: 'All quiet today.',
    });
    await stores.inbox.add({
      id: 'i2',
      kind: 'failure',
      title: 'Report failed',
      summary: 'boom',
      status: 'read',
      createdAt: 2,
    });

    expect(await runInboxList({ unread: true }, context)).toBe(0);
    expect(output()).toContain('Digest');
    expect(output()).not.toContain('Report failed');

    expect(await runInboxShow('i1', {}, context)).toBe(0);
    expect(output()).toContain('All quiet today.');

    expect(await runInboxMark('i1', 'archived', {}, context)).toBe(0);
    expect((await stores.inbox.get('i1'))!.status).toBe('archived');
    lines = [];
    expect(await runInboxList({}, context)).toBe(0);
    expect(output()).toContain('Report failed');
    expect(output()).not.toContain('Digest');
    expect(await runInboxMark('nope', 'read', {}, context)).toBe(1);
  });
});

describe('cogitator trigger', () => {
  it('issues a token for an API trigger of the store, kept only as its hash', async () => {
    const stores = experimental_fileTriggerStores(dir);
    await stores.store.saveRoutine({
      id: 'news',
      prompt: 'p',
      target: { agent: 'a' },
      triggers: [{ kind: 'api' }],
    });
    expect(await runTriggerToken('news.api', {}, context)).toBe(0);
    const token = lines[0];
    expect(token).toMatch(/^cgt_/);
    expect((await stores.store.getTriggerState('news.api'))!.tokenHash).toBe(
      hashTriggerToken(token)
    );
  });

  it('fires an API trigger of a server with its token', async () => {
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'routine_fire', status: 'started', runId: 'trg_news.api_1' }),
        { status: 202 }
      )
    );
    const code = await runTriggerFire(
      'news.api',
      {
        text: 'Breaking',
        url: 'http://localhost:3000/cogitator/',
        token: 'cgt_x',
        idempotencyKey: 'k',
      },
      context
    );
    expect(code).toBe(0);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://localhost:3000/cogitator/triggers/news.api/fire');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer cgt_x', 'idempotency-key': 'k' });
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Breaking' });
    expect(output()).toContain('started (run trg_news.api_1)');
  });

  it('says what is missing and what the server refused', async () => {
    expect(await runTriggerFire('news.api', { token: 't' }, context)).toBe(2);
    expect(await runTriggerFire('news.api', { url: 'http://x' }, context)).toBe(2);
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Bad token' } }), {
        status: 401,
      })
    );
    expect(
      await runTriggerFire('news.api', { url: 'http://x', token: 't' }, { ...context, env: {} })
    ).toBe(1);
  });
});
