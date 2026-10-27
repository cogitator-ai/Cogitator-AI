import { describe, expect, it } from 'vitest';
import { createSchedulerTools } from '../tools/scheduler-tools';
import { InMemoryTimerStore } from '../triggers/timer-stores';

const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };

function tools(
  store = new InMemoryTimerStore(),
  extra: Partial<Parameters<typeof createSchedulerTools>[0]> = {}
) {
  const [schedule, list, cancel] = createSchedulerTools({ store, ...extra });
  return { store, schedule, list, cancel };
}

describe('schedule_task with cron', () => {
  it('takes presets, 6 fields and a time zone, and first fires at the real occurrence', async () => {
    const { store, schedule } = tools();
    const daily = (await schedule.execute(
      { description: 'Digest', cron: '@daily', timezone: 'Europe/Moscow' },
      context
    )) as { id: string; firesAt: string; timezone: string };
    expect(daily.timezone).toBe('Europe/Moscow');
    const fires = new Date(daily.firesAt);
    const moscow = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(fires);
    expect(moscow).toBe('00:00');
    expect((await store.get(daily.id))?.timezone).toBe('Europe/Moscow');

    const before = Date.now();
    const seconds = (await schedule.execute(
      { description: 'Tick', cron: '*/10 * * * * *' },
      context
    )) as { firesAt: string };
    const at = Date.parse(seconds.firesAt);
    expect(at).toBeGreaterThan(before);
    expect(at - before).toBeLessThanOrEqual(10_000);
  });

  it('refuses an unknown time zone, and a time zone without cron', async () => {
    const { schedule } = tools();
    await expect(
      schedule.execute({ description: 'x', cron: '0 9 * * *', timezone: 'Mars/Base' }, context)
    ).rejects.toThrow(/Unknown time zone/);
    await expect(
      schedule.execute({ description: 'x', delay: '1h', timezone: 'UTC' }, context)
    ).rejects.toThrow(/timezone goes with cron/);
  });

  it('uses the default time zone of the tools', async () => {
    const { store, schedule } = tools(undefined, { timezone: 'UTC' });
    const result = (await schedule.execute({ description: 'x', cron: '0 9 * * *' }, context)) as {
      id: string;
      firesAt: string;
    };
    expect(new Date(result.firesAt).getUTCHours()).toBe(9);
    expect((await store.get(result.id))?.metadata?.source).toBe('agent');
  });

  it('limits the tasks waiting when asked to', async () => {
    const { schedule } = tools(undefined, { maxTasks: 1 });
    await schedule.execute({ description: 'one', delay: '1h' }, context);
    await expect(schedule.execute({ description: 'two', delay: '1h' }, context)).rejects.toThrow(
      /1 tasks waiting/
    );
  });

  it('never shows or cancels the schedules of routines in the same store', async () => {
    const store = new InMemoryTimerStore();
    const routine = await store.schedule({
      workflowId: 'routines',
      runId: 'r',
      nodeId: 'cron',
      firesAt: Date.now() + 60_000,
      type: 'cron',
      cron: '@hourly',
      trigger: { routineId: 'r', triggerId: 'cron' },
    });
    const { schedule, list, cancel } = tools(store);
    await schedule.execute({ description: 'mine', delay: '1h' }, context);
    const listed = (await list.execute({}, context)) as { tasks: { id: string }[] };
    expect(listed.tasks).toHaveLength(1);
    await expect(cancel.execute({ id: routine }, context)).rejects.toThrow(
      /not one of the scheduled tasks/
    );
    expect((await store.get(routine))?.cancelled).toBe(false);
  });

  it('asks for approval when told to', () => {
    const { schedule } = tools(undefined, { requiresApproval: true });
    expect(schedule.requiresApproval).toBe(true);
  });
});
