import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cogitator } from '@cogitator-ai/core';
import type { RoutineDefinition } from '@cogitator-ai/types';
import { WorkflowBuilder } from '../builder';
import { approvalNode } from '../human';
import { humanWorkflowNode } from '../nodes/adapters';
import { experimental_routineWorkflow } from '../routines';
import { InMemoryTriggerStore, cronTrigger, createTriggerManager, eventTrigger } from '../triggers';
import { JobScheduler } from '../manager/scheduler';
import { InMemoryRunStore } from '../manager/run-store';
import { CronTriggerExecutor } from '../triggers/cron-trigger';
import { InMemoryTimerStore, FileTimerStore } from '../timers/timer-store';
import * as core from '@cogitator-ai/core';

type Booking = {
  input?: string;
  booked?: boolean;
  approved?: boolean;
  charged?: boolean;
  output?: string;
};

const runtimes: Cogitator[] = [];
afterEach(async () => {
  for (const cog of runtimes.splice(0)) await cog.close();
});

function routine(workflow: string): RoutineDefinition {
  return {
    id: 'booking',
    prompt: 'Book the trip the event asks for.',
    target: { workflow },
    triggers: [{ kind: 'api', token: 't' }],
  };
}

describe('routines as workflows', () => {
  it('waits for an approval in the inbox, retries a flaky node, then reports the result', async () => {
    let flaky = 1;
    const workflow = new WorkflowBuilder<Booking>('booking')
      .initialState({})
      .addNode(
        'book',
        async () => {
          if (flaky-- > 0) throw new Error('airline timeout');
          return { state: { booked: true } };
        },
        { config: { retries: 2, retryDelay: 1 } }
      )
      .addNode(
        'approve',
        humanWorkflowNode<Booking>(approvalNode('manager', { title: 'Approve the booking' }), {
          stateMapper: (result) => ({ approved: result.approved }),
        }),
        { after: ['book'] }
      )
      .addNode(
        'confirm',
        async ({ state }) => ({ state: { output: `booked: ${String(state.approved)}` } }),
        {
          after: ['approve'],
        }
      )
      .build();
    const cog = new Cogitator({});
    runtimes.push(cog);
    const routines = new Cogitator({
      experimental_triggers: {
        workflows: { booking: experimental_routineWorkflow({ workflow, runtime: cog }) },
        routines: [routine('booking')],
      },
    });
    runtimes.push(routines);
    const manager = routines.experimental_triggers!;
    await manager.start();
    await manager.fire('booking.api', { text: 'Paris, Friday' });

    const approval = await vi.waitFor(async () => {
      const [item] = await manager.inbox.list({ kind: 'approval' });
      if (!item) throw new Error('no approval yet');
      return item;
    });
    expect(approval).toMatchObject({ routineId: 'booking', title: 'Approve the booking' });
    expect(approval.approvalId).toBeDefined();
    await manager.respond(approval.id, { decision: true, respondedBy: 'boss' });
    await manager.idle();

    const result = (await manager.inbox.list({ kind: 'result' }))[0];
    expect(result.summary).toBe('booked: true');
    expect((await manager.inbox.get(approval.id))?.status).toBe('archived');
  });

  it('compensates and puts a node that finally failed in the inbox as a failure', async () => {
    const undone: string[] = [];
    const workflow = new WorkflowBuilder<Booking>('charge')
      .initialState({})
      .addNode('book', async () => ({ state: { booked: true } }), {
        config: { compensation: { compensate: async () => void undone.push('cancel booking') } },
      })
      .addNode(
        'charge',
        async () => {
          throw new Error('card declined');
        },
        { after: ['book'], config: { retries: 1, retryDelay: 1 } }
      )
      .build();
    const cog = new Cogitator({});
    runtimes.push(cog);
    const routines = new Cogitator({
      experimental_triggers: {
        workflows: { charge: experimental_routineWorkflow({ workflow, runtime: cog }) },
        routines: [routine('charge')],
      },
    });
    runtimes.push(routines);
    const manager = routines.experimental_triggers!;
    await manager.start();
    await manager.fire('booking.api');
    await manager.idle();
    expect(undone).toEqual(['cancel booking']);
    const failures = await manager.inbox.list({ kind: 'failure' });
    expect(failures.map((item) => item.title)).toEqual(
      expect.arrayContaining(['charge: node charge failed', 'booking failed'])
    );
  });
});

describe('workflows on the core scheduler', () => {
  it('re-exports the core timer stores', () => {
    expect(InMemoryTimerStore).toBe(core.InMemoryTimerStore);
    expect(FileTimerStore).toBe(core.FileTimerStore);
  });

  it('brings the triggers of its store back when it starts again', async () => {
    const store = new InMemoryTriggerStore();
    const fired = vi.fn(async (_trigger: { id: string }) => 'run_1');
    const first = createTriggerManager({ store, onTriggerFire: fired });
    await first.start();
    const id = await first.register({
      workflowName: 'w',
      type: 'event',
      config: eventTrigger('order.created'),
      enabled: true,
    });
    const paused = await first.register({
      workflowName: 'w',
      type: 'cron',
      config: cronTrigger('0 9 * * *'),
      enabled: true,
    });
    await first.disable(paused);
    first.dispose();

    const second = createTriggerManager({ store, onTriggerFire: fired });
    await second.start();
    second.emitEvent('order.created', { id: 1 });
    await vi.waitFor(() => expect(fired).toHaveBeenCalledOnce());
    expect(fired.mock.calls[0][0]).toMatchObject({ id });
    await second.enable(paused);
    expect((await second.get(paused))?.enabled).toBe(true);
    second.dispose();
  });

  it('refuses a cron job it cannot run and reports runs it could not schedule', () => {
    const onError = vi.fn();
    const scheduler = new JobScheduler({ runStore: new InMemoryRunStore(), onError });
    const workflow = new WorkflowBuilder('w').addNode('a', async () => ({})).build();
    expect(() => scheduler.registerCronJob(workflow, 'every day')).toThrow(/Invalid cron/);
    expect(() =>
      scheduler.registerCronJob(workflow, '@every_5_minutes', { timezone: 'Moon/Base' })
    ).toThrow(/Unknown time zone/);
    expect(scheduler.registerCronJob(workflow, '@weekdays')).toBeTypeOf('string');
    scheduler.dispose();
  });

  it('catches up missed occurrences of a cron trigger', async () => {
    const onFire = vi.fn(async () => 'run');
    const executor = new CronTriggerExecutor({ onFire });
    const id = executor.register('w', { expression: '0 * * * *', enabled: false, catchUp: true });
    const results = await executor.catchUp(id, Date.now() - 3 * 3_600_000);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.length).toBeLessThanOrEqual(3);
    executor.dispose();
  });
});
