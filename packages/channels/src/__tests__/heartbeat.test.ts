import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { HeartbeatScheduler } from '../heartbeat';
import type { ChannelMessage, TimerStore } from '@cogitator-ai/types';

/** The members every TimerStore has; claims (claimTtl, renew, release) are optional. */
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];

function createMockStore(): Record<RequiredKeys<TimerStore>, ReturnType<typeof vi.fn>> {
  return {
    getOverdue: vi.fn().mockResolvedValue([]),
    markFired: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue('new_id'),
    cancel: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    getByWorkflow: vi.fn().mockResolvedValue([]),
    getByRun: vi.fn().mockResolvedValue([]),
    getPending: vi.fn().mockResolvedValue([]),
    cleanup: vi.fn().mockResolvedValue(0),
    onFire: vi.fn().mockReturnValue(() => {}),
    update: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
}

describe('HeartbeatScheduler', () => {
  let onFire: Mock<(msg: ChannelMessage) => Promise<void> | void>;
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    onFire = vi.fn();
    store = createMockStore();
  });

  it('fires overdue task as virtual message', async () => {
    store.getOverdue.mockResolvedValueOnce([
      {
        id: 't1',
        firesAt: Date.now() - 1000,
        metadata: { description: 'Send news', channel: 'telegram', userId: 'user_1' },
      },
    ]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(onFire).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const msg = onFire.mock.calls[0][0];
    expect(msg.text).toContain('Send news');
    expect(msg.channelType).toBe('telegram');
    expect(msg.userId).toBe('user_1');
    expect(msg.id).toContain('heartbeat_');

    scheduler.stop();
  });

  it('marks task as fired after processing', async () => {
    store.getOverdue.mockResolvedValueOnce([
      {
        id: 't1',
        firesAt: Date.now() - 1000,
        metadata: { description: 'Test', userId: 'u1' },
      },
    ]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.markFired).toHaveBeenCalledWith('t1');
      },
      { timeout: 200 }
    );

    scheduler.stop();
  });

  it('reschedules recurring cron tasks after fire', async () => {
    const getNextCronMs = vi.fn().mockReturnValue(Date.now() + 86_400_000);
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't1',
          firesAt: Date.now() - 1000,
          cron: '0 12 * * *',
          metadata: { description: 'Daily task', channel: 'telegram', userId: 'u1' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
      getNextCronMs,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.schedule).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const entry = store.schedule.mock.calls[0][0];
    expect(entry.cron).toBe('0 12 * * *');
    expect(entry.type).toBe('cron');

    scheduler.stop();
  });

  it('uses fallback interval when getNextCronMs is not provided', async () => {
    const now = Date.now();
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't1',
          firesAt: now - 1000,
          cron: '*/5 * * * *',
          metadata: { description: 'Recurring' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.schedule).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const entry = store.schedule.mock.calls[0][0];
    expect(entry.firesAt).toBeGreaterThan(now);

    scheduler.stop();
  });

  it('does nothing when no overdue tasks', async () => {
    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await new Promise((r) => setTimeout(r, 100));
    expect(onFire).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('stops polling on stop()', async () => {
    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();
    scheduler.stop();

    store.getOverdue.mockResolvedValueOnce([
      {
        id: 't1',
        firesAt: Date.now() - 1000,
        metadata: { description: 'Late' },
      },
    ]);

    await new Promise((r) => setTimeout(r, 100));
    expect(onFire).not.toHaveBeenCalled();
  });

  it('defaults channelType and userId to system', async () => {
    store.getOverdue.mockResolvedValueOnce([
      {
        id: 't2',
        firesAt: Date.now() - 500,
        metadata: { description: 'System task' },
      },
    ]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(onFire).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const msg = onFire.mock.calls[0][0];
    expect(msg.channelType).toBe('system');
    expect(msg.userId).toBe('system');
    expect(msg.channelId).toBe('system');

    scheduler.stop();
  });

  it('uses channelId from metadata when present', async () => {
    store.getOverdue.mockResolvedValueOnce([
      {
        id: 't3',
        firesAt: Date.now() - 500,
        metadata: { description: 'Group task', channelId: 'group_42', userId: 'u5' },
      },
    ]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(onFire).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const msg = onFire.mock.calls[0][0];
    expect(msg.channelId).toBe('group_42');

    scheduler.stop();
  });

  it('reschedules interval tasks at now + interval', async () => {
    const now = Date.now();
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't4',
          firesAt: now - 100,
          type: 'recurring',
          interval: 60_000,
          metadata: { description: 'Every minute' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.schedule).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const entry = store.schedule.mock.calls[0][0];
    expect(entry.type).toBe('recurring');
    expect(entry.interval).toBe(60_000);
    expect(entry.firesAt).toBeGreaterThanOrEqual(now + 59_000);

    scheduler.stop();
  });

  it('at-job fires once and is not rescheduled', async () => {
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't5',
          firesAt: Date.now() - 100,
          type: 'fixed',
          metadata: { description: 'One-shot' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.markFired).toHaveBeenCalledWith('t5');
      },
      { timeout: 200 }
    );

    expect(store.schedule).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('tracks error and increments consecutiveErrors', async () => {
    onFire.mockRejectedValueOnce(new Error('boom'));
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't6',
          firesAt: Date.now() - 100,
          consecutiveErrors: 1,
          metadata: { description: 'Flaky task' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.update).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const patch = store.update.mock.calls[0][1];
    expect(patch.lastRunStatus).toBe('error');
    expect(patch.consecutiveErrors).toBe(2);
    expect(patch.lastError).toBe('boom');

    scheduler.stop();
  });

  it('skips entries that exceeded maxRetries', async () => {
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't7',
          firesAt: Date.now() - 100,
          consecutiveErrors: 5,
          metadata: { description: 'Dead task' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
      maxRetries: 5,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.update).toHaveBeenCalledWith('t7', { lastRunStatus: 'skipped' });
      },
      { timeout: 200 }
    );

    expect(onFire).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('skips disabled entries', async () => {
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't8',
          firesAt: Date.now() - 100,
          enabled: false,
          metadata: { description: 'Disabled' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await new Promise((r) => setTimeout(r, 100));
    expect(onFire).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('calls onRunComplete callback with status and duration', async () => {
    const onRunComplete = vi.fn();
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't9',
          firesAt: Date.now() - 100,
          metadata: { description: 'Tracked task' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
      onRunComplete,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(onRunComplete).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const [entry, status, _error, duration] = onRunComplete.mock.calls[0];
    expect(entry.id).toBe('t9');
    expect(status).toBe('ok');
    expect(typeof duration).toBe('number');

    scheduler.stop();
  });

  it('resets consecutiveErrors on successful run', async () => {
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't10',
          firesAt: Date.now() - 100,
          consecutiveErrors: 3,
          metadata: { description: 'Recovered task' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.update).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const patch = store.update.mock.calls[0][1];
    expect(patch.lastRunStatus).toBe('ok');
    expect(patch.consecutiveErrors).toBe(0);

    scheduler.stop();
  });

  it('bestEffort task does not increment consecutiveErrors on failure', async () => {
    onFire.mockRejectedValueOnce(new Error('network down'));
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't_be',
          firesAt: Date.now() - 100,
          consecutiveErrors: 0,
          metadata: { description: 'Best effort ping', bestEffort: true },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.update).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const patch = store.update.mock.calls[0][1];
    expect(patch.lastRunStatus).toBe('error');
    expect(patch.consecutiveErrors).toBe(0);
    expect(patch.lastError).toBe('network down');

    scheduler.stop();
  });

  it('non-bestEffort task increments consecutiveErrors on failure', async () => {
    onFire.mockRejectedValueOnce(new Error('fail'));
    store.getOverdue
      .mockResolvedValueOnce([
        {
          id: 't_nbe',
          firesAt: Date.now() - 100,
          consecutiveErrors: 2,
          metadata: { description: 'Normal task' },
        },
      ])
      .mockResolvedValue([]);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(store.update).toHaveBeenCalled();
      },
      { timeout: 200 }
    );

    const patch = store.update.mock.calls[0][1];
    expect(patch.consecutiveErrors).toBe(3);

    scheduler.stop();
  });

  it('listJobs delegates to store.list()', async () => {
    const fakeEntries = [{ id: 'j1' }, { id: 'j2' }];
    store.list.mockResolvedValueOnce(fakeEntries);

    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    const jobs = await scheduler.listJobs();
    expect(jobs).toEqual(fakeEntries);
  });

  it('enableJob resets consecutiveErrors', async () => {
    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    await scheduler.enableJob('j1');
    expect(store.update).toHaveBeenCalledWith('j1', { enabled: true, consecutiveErrors: 0 });
  });

  it('disableJob sets enabled=false', async () => {
    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 50,
    });
    await scheduler.disableJob('j1');
    expect(store.update).toHaveBeenCalledWith('j1', { enabled: false });
  });
});

describe('HeartbeatScheduler with a claiming TimerStore', () => {
  type ClaimingStore = ReturnType<typeof createMockStore> & {
    claimTtl: number;
    renew: Mock<(id: string) => Promise<boolean>>;
    release: Mock<(id: string) => Promise<void>>;
  };

  let onFire: Mock<(msg: ChannelMessage) => Promise<void> | void>;
  let store: ClaimingStore;

  function overdue(id: string, extra: Record<string, unknown> = {}) {
    return { id, firesAt: Date.now() - 100, metadata: { description: id }, ...extra };
  }

  function startScheduler(
    config: Partial<ConstructorParameters<typeof HeartbeatScheduler>[1]> = {}
  ) {
    const scheduler = new HeartbeatScheduler(store as unknown as TimerStore, {
      onFire,
      pollInterval: 1000,
      ...config,
    });
    scheduler.start();
    return scheduler;
  }

  beforeEach(() => {
    onFire = vi.fn();
    store = {
      ...createMockStore(),
      claimTtl: 30,
      renew: vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true),
      release: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    };
  });

  it('renews the claim before firing and keeps it while the task runs', async () => {
    store.getOverdue.mockResolvedValueOnce([overdue('t1')]).mockResolvedValue([]);
    onFire.mockImplementation(() => new Promise((r) => setTimeout(r, 120)));

    const scheduler = startScheduler();
    await vi.waitFor(() => expect(store.markFired).toHaveBeenCalledWith('t1'), { timeout: 500 });
    scheduler.stop();

    expect(store.renew.mock.invocationCallOrder[0]).toBeLessThan(
      onFire.mock.invocationCallOrder[0]
    );
    expect(store.renew.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(store.renew).toHaveBeenCalledWith('t1');
    expect(store.release).not.toHaveBeenCalled();

    const renewsAfterFinish = store.renew.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(store.renew).toHaveBeenCalledTimes(renewsAfterFinish);
  });

  it('skips a task whose claim was taken over and reports it', async () => {
    const onClaimLost = vi.fn();
    store.getOverdue.mockResolvedValueOnce([overdue('t2')]).mockResolvedValue([]);
    store.renew.mockResolvedValue(false);

    const scheduler = startScheduler({ onClaimLost });
    await vi.waitFor(() => expect(onClaimLost).toHaveBeenCalledTimes(1), { timeout: 200 });
    scheduler.stop();

    expect(onClaimLost.mock.calls[0][0]).toMatchObject({ id: 't2' });
    expect(onFire).not.toHaveBeenCalled();
    expect(store.markFired).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('reports a claim lost while the task runs and stops renewing it', async () => {
    const onClaimLost = vi.fn();
    store.getOverdue.mockResolvedValueOnce([overdue('t3')]).mockResolvedValue([]);
    store.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
    onFire.mockImplementation(() => new Promise((r) => setTimeout(r, 120)));

    const scheduler = startScheduler({ onClaimLost });
    await vi.waitFor(() => expect(store.markFired).toHaveBeenCalledWith('t3'), { timeout: 500 });
    scheduler.stop();

    expect(onClaimLost).toHaveBeenCalledTimes(1);
    expect(store.renew).toHaveBeenCalledTimes(2);
  });

  it('releases disabled and exhausted tasks instead of holding their lease', async () => {
    store.getOverdue
      .mockResolvedValueOnce([
        overdue('disabled', { enabled: false }),
        overdue('exhausted', { consecutiveErrors: 5 }),
      ])
      .mockResolvedValue([]);

    const scheduler = startScheduler({ maxRetries: 5 });
    await vi.waitFor(() => expect(store.release).toHaveBeenCalledTimes(2), { timeout: 200 });
    scheduler.stop();

    expect(store.release).toHaveBeenCalledWith('disabled');
    expect(store.release).toHaveBeenCalledWith('exhausted');
    expect(store.renew).not.toHaveBeenCalled();
    expect(onFire).not.toHaveBeenCalled();
  });

  it('releases the claimed tasks it did not get to before stop()', async () => {
    store.getOverdue.mockResolvedValueOnce([overdue('a'), overdue('b'), overdue('c')]);
    let scheduler: HeartbeatScheduler | null = null;
    onFire.mockImplementation(() => {
      scheduler?.stop();
    });

    scheduler = startScheduler();
    await vi.waitFor(() => expect(store.release).toHaveBeenCalledTimes(2), { timeout: 200 });

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(store.markFired).toHaveBeenCalledWith('a');
    expect(store.release.mock.calls).toEqual([['b'], ['c']]);
  });

  it('keeps the claim of a task whose bookkeeping failed so the lease spaces out retries', async () => {
    const onError = vi.fn();
    store.getOverdue.mockResolvedValueOnce([overdue('t4')]).mockResolvedValue([]);
    store.update.mockRejectedValueOnce(new Error('db down'));

    const scheduler = startScheduler({ onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 200 });
    scheduler.stop();

    expect(store.release).not.toHaveBeenCalled();
  });
});
