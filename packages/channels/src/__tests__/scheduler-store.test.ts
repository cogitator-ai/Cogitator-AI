import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getNextCronMs } from '../cron';
import { SimpleTimerStore } from '../simple-timer-store';
import { HeartbeatScheduler } from '../heartbeat';
import type { TimerEntry, TimerStore } from '@cogitator-ai/types';

describe('getNextCronMs', () => {
  it('computes the next occurrence', () => {
    const from = new Date('2026-01-01T10:07:00Z').getTime();
    const next = getNextCronMs('*/15 * * * *', from, 'UTC');
    expect(new Date(next).toISOString()).toBe('2026-01-01T10:15:00.000Z');
  });

  it('honors timezones', () => {
    const from = new Date('2026-01-01T00:00:00Z').getTime();
    const next = getNextCronMs('0 9 * * *', from, 'America/New_York');
    expect(new Date(next).toISOString()).toBe('2026-01-01T14:00:00.000Z');
  });

  it('keeps the wall-clock time across a DST transition', () => {
    const from = new Date('2026-03-07T15:00:00Z').getTime();
    const next = getNextCronMs('0 9 * * *', from, 'America/New_York');
    expect(new Date(next).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('supports six-field expressions with seconds', () => {
    const from = new Date('2026-01-01T10:00:05Z').getTime();
    const next = getNextCronMs('*/20 * * * * *', from, 'UTC');
    expect(new Date(next).toISOString()).toBe('2026-01-01T10:00:20.000Z');
  });

  it('falls back to local time without a timezone', () => {
    const from = new Date(2026, 0, 1, 10, 0, 0).getTime();
    expect(getNextCronMs('  0 9 * * *  ', from)).toBe(new Date(2026, 0, 2, 9, 0, 0).getTime());
  });

  it('throws for invalid expressions', () => {
    expect(() => getNextCronMs('not a cron')).toThrow();
  });
});

describe('SimpleTimerStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const base = {
    workflowId: 'w',
    runId: 'r',
    nodeId: 'n',
  } as const;

  it('derives cron firesAt from the expression when a resolver is configured', async () => {
    const resolver = vi.fn().mockReturnValue(123_456);
    const store = new SimpleTimerStore({ resolveCronFiresAt: resolver });
    const id = await store.schedule({
      ...base,
      firesAt: 1,
      type: 'cron',
      cron: '0 9 * * *',
      timezone: 'UTC',
    });

    expect(resolver).toHaveBeenCalledWith('0 9 * * *', 'UTC');
    expect((await store.get(id))?.firesAt).toBe(123_456);
  });

  it('keeps explicit firesAt for non-cron entries', async () => {
    const store = new SimpleTimerStore({ resolveCronFiresAt: () => 999 });
    const id = await store.schedule({ ...base, firesAt: 42, type: 'fixed' });
    expect((await store.get(id))?.firesAt).toBe(42);
  });

  it('persists to disk and reloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timers-'));
    dirs.push(dir);
    const path = join(dir, 'timers.json');

    const store = new SimpleTimerStore({ persistPath: path });
    const id = await store.schedule({ ...base, firesAt: Date.now() - 1, type: 'fixed' });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toHaveLength(1);

    const reloaded = new SimpleTimerStore({ persistPath: path });
    expect((await reloaded.getOverdue()).map((e) => e.id)).toEqual([id]);
  });

  it('cleanup removes old fired entries', async () => {
    const store = new SimpleTimerStore();
    const id = await store.schedule({ ...base, firesAt: 0, type: 'fixed' });
    await store.markFired(id);
    expect(await store.cleanup(Date.now() + 1)).toBe(1);
    expect(await store.get(id)).toBeNull();
  });
});

function mockStore(overdue: TimerEntry[][]): TimerStore & Record<string, ReturnType<typeof vi.fn>> {
  const getOverdue = vi.fn();
  for (const batch of overdue) getOverdue.mockResolvedValueOnce(batch);
  getOverdue.mockResolvedValue([]);
  return {
    getOverdue,
    markFired: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue('next'),
    cancel: vi.fn(),
    get: vi.fn(),
    getByWorkflow: vi.fn(),
    getByRun: vi.fn(),
    getPending: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(0),
    onFire: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    list: vi.fn(),
  } as unknown as TimerStore & Record<string, ReturnType<typeof vi.fn>>;
}

function entry(overrides: Partial<TimerEntry> = {}): TimerEntry {
  return {
    id: 't1',
    workflowId: 'heartbeat',
    runId: 'scheduler',
    nodeId: 'task',
    firesAt: Date.now() - 1000,
    type: 'fixed',
    cancelled: false,
    fired: false,
    createdAt: Date.now() - 5000,
    metadata: { description: 'do it', channel: 'telegram', userId: 'u1' },
    ...overrides,
  };
}

describe('HeartbeatScheduler regressions', () => {
  it('reschedules cron entries at the real next occurrence by default', async () => {
    const store = mockStore([[entry({ type: 'cron', cron: '0 9 * * *', timezone: 'UTC' })]]);
    const scheduler = new HeartbeatScheduler(store, { onFire: vi.fn(), pollInterval: 20 });
    scheduler.start();

    await vi.waitFor(() => expect(store.schedule).toHaveBeenCalled());
    scheduler.stop();

    const scheduled = store.schedule.mock.calls[0][0] as TimerEntry;
    const nextFire = new Date(scheduled.firesAt);
    expect(nextFire.getUTCHours()).toBe(9);
    expect(nextFire.getUTCMinutes()).toBe(0);
    expect(scheduled.firesAt - Date.now()).toBeGreaterThan(60_000 - 1);
    expect(scheduled.timezone).toBe('UTC');
  });

  it('carries consecutiveErrors to the rescheduled entry', async () => {
    const store = mockStore([
      [entry({ type: 'recurring', interval: 60_000, consecutiveErrors: 2 })],
    ]);
    const scheduler = new HeartbeatScheduler(store, {
      onFire: vi.fn().mockRejectedValue(new Error('boom')),
      pollInterval: 20,
    });
    scheduler.start();

    await vi.waitFor(() => expect(store.schedule).toHaveBeenCalled());
    scheduler.stop();

    expect((store.schedule.mock.calls[0][0] as TimerEntry).consecutiveErrors).toBe(3);
  });

  it('keeps polling after a store failure', async () => {
    const store = mockStore([]);
    store.getOverdue.mockReset();
    store.getOverdue
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValueOnce([entry()])
      .mockResolvedValue([]);
    const onFire = vi.fn();
    const onError = vi.fn();
    const scheduler = new HeartbeatScheduler(store, { onFire, onError, pollInterval: 20 });
    scheduler.start();

    await vi.waitFor(() => expect(onFire).toHaveBeenCalled());
    scheduler.stop();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk' }));
  });

  it('isolates failures of a single entry', async () => {
    const store = mockStore([[entry({ id: 'bad' }), entry({ id: 'good' })]]);
    store.update.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('write failed');
    });
    const onFire = vi.fn();
    const scheduler = new HeartbeatScheduler(store, { onFire, pollInterval: 20 });
    scheduler.start();

    await vi.waitFor(() => expect(store.markFired).toHaveBeenCalledWith('good'));
    scheduler.stop();
    expect(onFire).toHaveBeenCalledTimes(2);
  });

  it('stop() during stagger prevents the scheduler from starting', async () => {
    const store = mockStore([[entry()]]);
    const onFire = vi.fn();
    const scheduler = new HeartbeatScheduler(store, {
      onFire,
      pollInterval: 10,
      staggerMs: 50,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    scheduler.start();
    scheduler.stop();
    vi.restoreAllMocks();

    await new Promise((r) => setTimeout(r, 120));
    expect(store.getOverdue).not.toHaveBeenCalled();
    expect(onFire).not.toHaveBeenCalled();
  });

  it('start() is idempotent', async () => {
    const store = mockStore([]);
    const scheduler = new HeartbeatScheduler(store, { onFire: vi.fn(), pollInterval: 30 });
    scheduler.start();
    scheduler.start();
    await new Promise((r) => setTimeout(r, 75));
    scheduler.stop();
    expect(store.getOverdue.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('cleans up old fired entries', async () => {
    const store = mockStore([]);
    const scheduler = new HeartbeatScheduler(store, {
      onFire: vi.fn(),
      pollInterval: 20,
      retentionMs: 1000,
    });
    scheduler.start();
    await vi.waitFor(() => expect(store.cleanup).toHaveBeenCalled());
    scheduler.stop();
    const cutoff = store.cleanup.mock.calls[0][0] as number;
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(1000);
  });

  it('does not rewrite skipped entries every poll', async () => {
    const store = mockStore([[entry({ consecutiveErrors: 9, lastRunStatus: 'skipped' })]]);
    const scheduler = new HeartbeatScheduler(store, { onFire: vi.fn(), pollInterval: 20 });
    scheduler.start();
    await vi.waitFor(() => expect(store.getOverdue.mock.calls.length).toBeGreaterThan(1));
    scheduler.stop();
    expect(store.update).not.toHaveBeenCalled();
  });
});
