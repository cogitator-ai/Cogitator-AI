import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CronExpressionParser } from 'cron-parser';
import type { TimerEntry, TimerStore } from '@cogitator-ai/types';
import { experimental_createCronEngine } from '../triggers/cron';
import { experimental_Scheduler, type ScheduledFire } from '../triggers/scheduler';
import { experimental_TimerPoller } from '../triggers/poller';
import { FileTimerStore, InMemoryTimerStore } from '../triggers/timer-stores';

const cron = experimental_createCronEngine(CronExpressionParser);

function scheduler(
  store: TimerStore,
  fire: (fire: ScheduledFire) => void | Promise<void>,
  extra: Partial<ConstructorParameters<typeof experimental_Scheduler>[0]> = {}
) {
  return new experimental_Scheduler({ store, cron, fire, pollInterval: 20, ...extra });
}

describe('experimental_Scheduler', () => {
  let store: InMemoryTimerStore;

  beforeEach(() => {
    store = new InMemoryTimerStore();
  });

  it('adds entries at their first time', async () => {
    const s = scheduler(store, vi.fn());
    const now = Date.now();
    const daily = await s.add({ cron: '@daily', timezone: 'UTC' });
    expect(daily.type).toBe('cron');
    expect(daily.cron).toBe('@daily');
    expect(new Date(daily.firesAt).getUTCHours()).toBe(0);
    expect(daily.firesAt).toBeGreaterThan(now);
    const once = await s.add({ delayMs: 5_000 });
    expect(once.firesAt).toBeGreaterThanOrEqual(now + 5_000);
    const every = await s.add({ intervalMs: 60_000 });
    expect(every.type).toBe('recurring');
    await expect(s.add({ cron: '99 * * * *' })).rejects.toThrow(/Invalid cron/);
    await expect(s.add({ cron: '* * * * *', delayMs: 1 })).rejects.toThrow(/exactly one/);
    await expect(s.add({ cron: '* * * * *', timezone: 'Nowhere/City' })).rejects.toThrow(
      /Unknown time zone/
    );
  });

  it('counts the next time of nextFire from the end of a long run (fixed delay)', async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const nextFire = vi.fn((_entry: TimerEntry, at: number) => at + 60_000);
      const s = scheduler(
        store,
        () => {
          clock += 5 * 60_000;
        },
        { reschedule: 'append', nextFire }
      );
      const id = await store.schedule({
        workflowId: 'heartbeat',
        runId: 'scheduler',
        nodeId: 'task',
        firesAt: clock - 1,
        type: 'recurring',
        interval: 60_000,
      });
      expect(await s.processNow()).toBe(1);
      expect(nextFire).toHaveBeenCalledWith(expect.objectContaining({ id }), 1_000_000 + 300_000);
      const [following] = await store.getPending();
      expect(following.firesAt).toBe(1_000_000 + 300_000 + 60_000);
    } finally {
      now.mockRestore();
    }
  });

  it('fires a due cron entry once and moves the same entry to its next occurrence', async () => {
    const fired: ScheduledFire[] = [];
    const s = scheduler(store, (fire) => {
      fired.push(fire);
    });
    const entry = await s.add({ cron: '0 * * * *', timezone: 'UTC' });
    await store.update(entry.id, { firesAt: Date.now() - 1_000 });
    expect(await s.processNow()).toBe(1);
    expect(fired).toHaveLength(1);
    const after = await store.get(entry.id);
    expect(after?.fired).toBe(false);
    expect(after?.firesAt).toBeGreaterThan(Date.now());
    expect(after?.lastRunStatus).toBe('ok');
    expect(after?.lastOccurrence).toBe(fired[0].occurrence);
    expect(await s.processNow()).toBe(0);
  });

  it('catches up as the entry says after the process was down', async () => {
    const fired: number[] = [];
    const s = scheduler(store, ({ occurrence }) => {
      fired.push(occurrence);
    });
    const threeHoursAgo = Math.floor((Date.now() - 3 * 3_600_000) / 3_600_000) * 3_600_000;
    const all = await s.add({ cron: '0 * * * *', timezone: 'UTC', catchUp: 'all' });
    await store.update(all.id, { firesAt: threeHoursAgo });
    await s.processNow();
    expect(fired.length).toBe(4);
    expect(fired).toEqual([...fired].sort((a, b) => a - b));

    fired.length = 0;
    const none = await s.add({ cron: '0 * * * *', timezone: 'UTC', catchUp: 'none' });
    await store.update(none.id, { firesAt: threeHoursAgo });
    const onMissed = vi.fn();
    const quiet = scheduler(store, ({ occurrence }) => void fired.push(occurrence), {
      onMissed,
      graceMs: 1_000,
    });
    await quiet.processNow();
    expect(fired).toEqual([]);
    expect(onMissed).toHaveBeenCalledOnce();
    expect((await store.get(none.id))?.firesAt).toBeGreaterThan(Date.now());
  });

  it('retries a failed one-shot entry, skips it after maxRetries, best effort fires once', async () => {
    const s = scheduler(
      store,
      () => {
        throw new Error('boom');
      },
      { maxRetries: 2 }
    );
    const once = await s.add({ at: Date.now() - 10 });
    const effort = await s.add({ at: Date.now() - 10, metadata: { bestEffort: true } });
    await s.processNow();
    expect((await store.get(once.id))?.fired).toBe(false);
    expect((await store.get(once.id))?.consecutiveErrors).toBe(1);
    expect((await store.get(effort.id))?.fired).toBe(true);
    await s.processNow();
    await s.processNow();
    const exhausted = await store.get(once.id);
    expect(exhausted?.consecutiveErrors).toBe(2);
    expect(exhausted?.lastRunStatus).toBe('skipped');
  });

  it('appends a copy for the next time in append mode, as timers.json keeps them', async () => {
    const s = scheduler(store, vi.fn(), { reschedule: 'append' });
    const entry = await s.add({ intervalMs: 60_000 });
    await store.update(entry.id, { firesAt: Date.now() - 1 });
    await s.processNow();
    expect((await store.get(entry.id))?.fired).toBe(true);
    const pending = await store.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(entry.id);
    expect(pending[0].interval).toBe(60_000);
  });

  it('pauses, resumes from the next occurrence and runs an entry now', async () => {
    const fire = vi.fn();
    const s = scheduler(store, fire);
    const entry = await s.add({ cron: '0 0 1 1 *', timezone: 'UTC' });
    await s.pause(entry.id);
    await store.update(entry.id, { firesAt: Date.now() - 1 });
    await s.processNow();
    expect(fire).not.toHaveBeenCalled();
    await s.resume(entry.id);
    expect((await store.get(entry.id))?.firesAt).toBeGreaterThan(Date.now());
    await s.runNow(entry.id);
    await s.processNow();
    expect(fire).toHaveBeenCalledOnce();
  });

  it('leaves entries it does not accept to others', async () => {
    const fire = vi.fn();
    const s = scheduler(store, fire, { accepts: (entry) => entry.trigger !== undefined });
    await s.add({ at: Date.now() - 1 });
    await s.add({ at: Date.now() - 1, trigger: { routineId: 'r', triggerId: 'cron' } });
    await s.processNow();
    expect(fire).toHaveBeenCalledOnce();
    expect(fire.mock.calls[0][0].entry.trigger).toEqual({ routineId: 'r', triggerId: 'cron' });
  });

  it('polls on its own once started', async () => {
    const fire = vi.fn();
    const s = scheduler(store, fire);
    await s.add({ at: Date.now() + 30 });
    await s.start();
    await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce(), { timeout: 1_000 });
    await s.stop();
  });
});

describe('batchSize', () => {
  it('counts only entries that will run, so paused ones never hold up the rest', async () => {
    const store = new InMemoryTimerStore();
    const fired: string[] = [];
    const s = scheduler(store, ({ entry }) => void fired.push(entry.id), {
      batchSize: 1,
      maxRetries: 2,
    });
    const base = { workflowId: 'w', runId: 'r', nodeId: 'n', type: 'fixed' as const };
    await store.schedule({ ...base, firesAt: Date.now() - 3_000, enabled: false });
    await store.schedule({ ...base, firesAt: Date.now() - 2_000, consecutiveErrors: 2 });
    const due = await store.schedule({ ...base, firesAt: Date.now() - 1_000 });
    await s.processNow();
    expect(fired).toEqual([due]);
  });
});

describe('experimental_TimerPoller with a claiming store', () => {
  it('confirms the claim, renews it while the work runs and gives back what it skips', async () => {
    const entries: TimerEntry[] = ['a', 'b'].map((id) => ({
      id,
      workflowId: 'w',
      runId: 'r',
      nodeId: 'n',
      firesAt: 0,
      type: 'fixed',
      cancelled: false,
      fired: false,
      createdAt: 0,
    }));
    const inner = new InMemoryTimerStore();
    const renew = vi.fn().mockResolvedValue(true);
    const release = vi.fn().mockResolvedValue(undefined);
    const store: TimerStore = Object.assign(Object.create(inner) as TimerStore, {
      getOverdue: async () => entries,
      claimTtl: 30,
      renew,
      release,
    });
    const processed: string[] = [];
    const poller = new experimental_TimerPoller({
      store,
      batchSize: 1,
      process: async (entry, claims) => {
        if (!(await claims.confirm(entry))) return;
        const stop = claims.keep(entry);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await stop();
        processed.push(entry.id);
      },
    });
    expect(await poller.poll()).toBe(1);
    expect(processed).toEqual(['a']);
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(release).toHaveBeenCalledWith('b');
  });
});

describe('FileTimerStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cogitator-timers-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps timers in timers.json and sees what another process wrote', async () => {
    const one = new FileTimerStore(dir);
    const two = new FileTimerStore(dir);
    const id = await one.schedule({
      workflowId: 'w',
      runId: 'r',
      nodeId: 'n',
      firesAt: Date.now() - 1,
      type: 'fixed',
    });
    expect((await two.getOverdue()).map((timer) => timer.id)).toEqual([id]);
    await two.update(id, { enabled: false });
    expect((await one.get(id))?.enabled).toBe(false);
    await two.markFired(id);
    expect(await one.getPending()).toEqual([]);
    expect(await one.cleanup(-1)).toBe(1);
    expect(await two.list()).toEqual([]);
  });

  it('does not lose changes two stores make at once', async () => {
    const stores = [new FileTimerStore(dir), new FileTimerStore(dir), new FileTimerStore(dir)];
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        stores[index % 3].schedule({
          workflowId: 'w',
          runId: String(index),
          nodeId: 'n',
          firesAt: index,
          type: 'fixed',
        })
      )
    );
    expect(await new FileTimerStore(dir).count()).toBe(30);
  });
});
