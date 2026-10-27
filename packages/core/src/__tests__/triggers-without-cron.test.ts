import { describe, expect, it, vi } from 'vitest';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { Agent } from '../agent';
import { experimental_TriggerManager, type TriggerRuntime } from '../triggers/manager';
import { experimental_Scheduler } from '../triggers/scheduler';
import { InMemoryTimerStore } from '../triggers/timer-stores';
import { createMockRunResult } from '@cogitator-ai/test-utils';

vi.mock('../triggers/cron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../triggers/cron')>();
  return {
    ...actual,
    experimental_loadCronEngine: () =>
      Promise.reject(
        new CogitatorError({
          message: 'Cron schedules need the cron-parser package',
          code: ErrorCode.CONFIGURATION_ERROR,
        })
      ),
  };
});

function fakeRuntime(): { runtime: TriggerRuntime; started: string[] } {
  const started: string[] = [];
  return {
    started,
    runtime: {
      durable: false,
      start: (_agent, options) => {
        started.push(options.threadId ?? '');
        return {
          result: Promise.resolve(createMockRunResult('done')),
          steer: () => false,
          followUp: () => false,
          inject: () => false,
          queued: [],
          refused: [],
          abort: () => [],
        };
      },
      resume: () => Promise.reject(new Error('no resume here')),
      notify: async () => undefined,
    },
  };
}

const worker = () => new Agent({ name: 'worker', model: 'mock/m', instructions: 'x' });

describe('triggers without cron-parser', () => {
  it('run API routines and one-shot tasks, and refuse only what needs cron', async () => {
    const { runtime, started } = fakeRuntime();
    const manager = new experimental_TriggerManager(
      {
        agents: { worker: worker() },
        pollInterval: 20,
        routines: [
          {
            id: 'digest',
            prompt: 'Summarize.',
            target: { agent: 'worker' },
            triggers: [{ kind: 'api', token: 't' }],
          },
        ],
      },
      runtime
    );
    await manager.start();
    expect((await manager.fire('digest.api')).status).toBe('started');
    const task = await manager.scheduler.add({
      at: Date.now() - 1,
      trigger: { agent: 'worker' },
      metadata: { description: 'Remind', source: 'agent' },
    });
    await vi.waitFor(async () => expect((await manager.scheduler.get(task.id))?.fired).toBe(true));
    expect(started).toEqual(expect.arrayContaining([`task_${task.id}`]));
    await expect(
      manager.create({
        id: 'nightly',
        prompt: 'p',
        target: { agent: 'worker' },
        triggers: [{ kind: 'cron', cron: '0 3 * * *' }],
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await manager.stop();

    const timed = new experimental_TriggerManager(
      {
        agents: { worker: worker() },
        routines: [
          {
            id: 'nightly',
            prompt: 'p',
            target: { agent: 'worker' },
            triggers: [{ kind: 'cron', cron: '0 3 * * *' }],
          },
        ],
      },
      fakeRuntime().runtime
    );
    await expect(timed.start()).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('a scheduler polls one-shot entries without a cron engine', async () => {
    const store = new InMemoryTimerStore();
    const fired: string[] = [];
    const scheduler = new experimental_Scheduler({
      store,
      fire: ({ entry }) => void fired.push(entry.id),
    });
    await scheduler.start();
    const entry = await scheduler.add({ at: Date.now() - 1 });
    await scheduler.processNow();
    expect(fired).toEqual([entry.id]);
    await scheduler.stop();
  });
});
