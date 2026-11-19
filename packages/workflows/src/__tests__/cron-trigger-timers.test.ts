import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronTriggerExecutor } from '../triggers/index';
import type { CronTriggerConfig } from '@cogitator-ai/types';

const MAX_TIMEOUT_DELAY = 2_147_483_647;
const DAY = 24 * 60 * 60 * 1000;

describe('Cron trigger timers', () => {
  let executor: CronTriggerExecutor;
  let fired: string[];

  function everyMinute(extra: Partial<CronTriggerConfig> = {}): CronTriggerConfig {
    return { expression: '* * * * *', enabled: true, ...extra };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:30Z') });
    fired = [];
    executor = new CronTriggerExecutor({
      onFire: async (_trigger, context) => {
        fired.push(new Date(context.timestamp).toISOString());
        return 'run-id';
      },
    });
  });

  afterEach(() => {
    executor.dispose();
    vi.useRealTimers();
  });

  it('waits for the due time when the clock moved back', async () => {
    executor.register('wf', everyMinute());

    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fired).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fired).toEqual(['2026-01-01T00:01:00.000Z']);
  });

  it('does not fire a trigger disabled while it waits longer than one timer can', async () => {
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    const id = executor.register('wf', { expression: '0 0 1 1 *', timezone: 'UTC', enabled: true });

    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_DELAY + 1000);
    executor.disable(id);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(365 * DAY);
    expect(fired).toEqual([]);
  });

  it('fires a trigger that waits longer than one timer can at its due time', async () => {
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    executor.register('wf', { expression: '0 0 1 1 *', timezone: 'UTC', enabled: true });

    await vi.advanceTimersByTimeAsync(363 * DAY);
    expect(fired).toEqual([]);

    await vi.advanceTimersByTimeAsync(DAY);
    expect(fired).toEqual(['2027-01-01T00:00:00.000Z']);
  });

  it('fires an expression with a seconds field every second', async () => {
    executor.register('wf', { expression: '* * * * * *', enabled: true });

    await vi.advanceTimersByTimeAsync(5000);

    expect(fired).toEqual([
      '2026-01-01T00:00:31.000Z',
      '2026-01-01T00:00:32.000Z',
      '2026-01-01T00:00:33.000Z',
      '2026-01-01T00:00:34.000Z',
      '2026-01-01T00:00:35.000Z',
    ]);
  });

  it('leaves no timer behind when a trigger is registered again while it fires', async () => {
    let again = true;
    const reentrant: CronTriggerExecutor = new CronTriggerExecutor({
      onFire: async (_trigger, context) => {
        fired.push(new Date(context.timestamp).toISOString());
        if (again) {
          again = false;
          reentrant.register('wf', everyMinute(), 'job');
        }
        return 'run-id';
      },
    });
    reentrant.register('wf', everyMinute(), 'job');

    await vi.advanceTimersByTimeAsync(90_000);
    reentrant.dispose();

    expect(fired).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a trigger scheduled when its condition throws', async () => {
    let checks = 0;
    const id = executor.register(
      'wf',
      everyMinute({
        condition: () => {
          if (checks++ === 0) throw new Error('condition failed');
          return true;
        },
      })
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(executor.getState(id)).toMatchObject({ errorCount: 1, lastError: 'condition failed' });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual(['2026-01-01T00:02:00.000Z']);
  });

  it('reports an input function that throws as a failed fire', async () => {
    const id = executor.register(
      'wf',
      everyMinute({
        input: () => {
          throw new Error('input failed');
        },
      })
    );

    await expect(executor.fire(id)).resolves.toMatchObject({
      triggered: false,
      reason: 'input failed',
    });
    expect(fired).toEqual([]);
  });
});
