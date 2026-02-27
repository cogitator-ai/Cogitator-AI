import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeartbeatScheduler } from '../heartbeat';
import type { TimerStore } from '@cogitator-ai/types';

function createMockStore(): Record<keyof TimerStore, ReturnType<typeof vi.fn>> {
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
  };
}

describe('HeartbeatScheduler', () => {
  let onFire: ReturnType<typeof vi.fn>;
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
    expect(msg.text).toBe('Send news');
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
});
