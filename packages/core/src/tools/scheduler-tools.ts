import { z } from 'zod';
import { tool } from '../tool';
import { parseDuration } from '../cache/cache-key';
import type { TimerStore, TimerEntry } from '@cogitator-ai/types';

export interface SchedulerToolsConfig {
  store: TimerStore;
  defaultChannel?: string;
  defaultUserId?: string;
}

const CRON_REGEX = /^(\S+\s+){4}\S+$/;

function validateCron(expr: string): boolean {
  return CRON_REGEX.test(expr.trim());
}

const scheduleParams = z.object({
  description: z.string().describe('What the scheduled task should do'),
  delay: z.string().optional().describe('Delay before firing, e.g. "20m", "2h", "1d"'),
  cron: z.string().optional().describe('Cron expression for recurring tasks, e.g. "0 12 * * *"'),
  at: z.string().optional().describe('ISO datetime string for when to fire'),
  channel: z.string().optional().describe('Channel to deliver the task to'),
  userId: z.string().optional().describe('User ID associated with the task'),
});

const listParams = z.object({});

const cancelParams = z.object({
  id: z.string().describe('ID of the task to cancel'),
});

export function createSchedulerTools(config: SchedulerToolsConfig) {
  const { store, defaultChannel, defaultUserId } = config;

  const scheduleTask = tool({
    name: 'schedule_task',
    description:
      'Schedule a task to run after a delay, at a specific time, or on a cron schedule. Provide exactly one of: delay, cron, or at.',
    parameters: scheduleParams,
    execute: async ({ description, delay, cron, at, channel, userId }) => {
      const modes = [delay, cron, at].filter(Boolean);
      if (modes.length !== 1) {
        throw new Error('Provide exactly one of: delay, cron, or at');
      }

      let firesAt: number;
      let type: 'fixed' | 'cron';
      let cronExpr: string | undefined;

      if (delay) {
        firesAt = Date.now() + parseDuration(delay);
        type = 'fixed';
      } else if (cron) {
        if (!validateCron(cron)) {
          throw new Error(`Invalid cron expression: ${cron}`);
        }
        firesAt = Date.now() + 60_000;
        type = 'cron';
        cronExpr = cron;
      } else {
        const parsed = new Date(at!).getTime();
        if (Number.isNaN(parsed)) {
          throw new Error(`Invalid ISO datetime: ${at}`);
        }
        firesAt = parsed;
        type = 'fixed';
      }

      const id = await store.schedule({
        workflowId: 'heartbeat',
        runId: 'scheduler',
        nodeId: 'task',
        firesAt,
        type,
        cron: cronExpr,
        metadata: {
          description,
          channel: channel ?? defaultChannel,
          userId: userId ?? defaultUserId,
        },
      });

      return {
        scheduled: true,
        id,
        firesAt: new Date(firesAt).toISOString(),
      };
    },
  });

  const listTasks = tool({
    name: 'list_tasks',
    description: 'List all pending scheduled tasks.',
    parameters: listParams,
    execute: async () => {
      const pending: TimerEntry[] = await store.getPending();
      return {
        tasks: pending.map((entry) => ({
          id: entry.id,
          description: (entry.metadata as Record<string, unknown> | undefined)?.description ?? '',
          nextFire: new Date(entry.firesAt).toISOString(),
          ...(entry.cron ? { cron: entry.cron } : {}),
        })),
      };
    },
  });

  const cancelTask = tool({
    name: 'cancel_task',
    description: 'Cancel a scheduled task by its ID.',
    parameters: cancelParams,
    execute: async ({ id }) => {
      await store.cancel(id);
      return { cancelled: true, id };
    },
  });

  return [scheduleTask, listTasks, cancelTask];
}
