import { z } from 'zod';
import { tool, toolset } from '../tool';
import { parseDuration } from '../cache/cache-key';
import type { CronEngine, TimerEntry, TimerStore } from '@cogitator-ai/types';
import { experimental_loadCronEngine, isKnownTimezone } from '../triggers/cron';

export interface SchedulerToolsConfig {
  store: TimerStore;
  defaultChannel?: string;
  defaultUserId?: string;
  /**
   * Computes the times of cron schedules. Default: the engine over `cron-parser`, an optional
   * peer of the core, imported on the first cron task
   */
  cron?: CronEngine;
  /** The time zone of a cron task that names none. Default: the process's */
  timezone?: string;
  /**
   * The agent the tasks run on when they come due, for the trigger manager: tasks get
   * `trigger.agent`, and the tools see only this agent's tasks
   */
  agent?: string;
  /** Most tasks waiting at once, a task past it is refused. Default: no limit */
  maxTasks?: number;
  /** Whether `schedule_task` asks for approval before it schedules. Default: no */
  requiresApproval?: boolean;
}

const scheduleParams = z.object({
  description: z.string().describe('What the scheduled task should do'),
  delay: z.string().optional().describe('Delay before firing, e.g. "20m", "2h", "1d"'),
  cron: z
    .string()
    .optional()
    .describe(
      'Cron expression for recurring tasks: 5 fields ("0 12 * * *"), 6 fields with seconds first, or a preset such as "@daily", "@hourly", "@weekly"'
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      'IANA time zone of the cron expression, e.g. "Europe/Moscow". Default: the server\'s'
    ),
  at: z.string().optional().describe('ISO datetime string for when to fire'),
  channel: z.string().optional().describe('Channel to deliver the task to'),
  userId: z.string().optional().describe('User ID associated with the task'),
  bestEffort: z.boolean().optional().describe('If true, skip retries on failure (fire-and-forget)'),
});

const listParams = z.object({});

const cancelParams = z.object({
  id: z.string().describe('ID of the task to cancel'),
});

/**
 * Tools an agent schedules itself with: `schedule_task` (after a delay, at a time, or on a cron
 * expression in a time zone), `list_tasks` and `cancel_task`. A cron task's first time is the
 * first occurrence of its expression. Tasks are entries of `store` with `metadata.source` set to
 * `agent`: when one comes due, its description reaches the agent as data, not as instructions.
 * The tools never show or cancel the schedules of routines kept in the same store
 */
export function createSchedulerTools(config: SchedulerToolsConfig) {
  const { store, defaultChannel, defaultUserId } = config;
  let engine: CronEngine | undefined = config.cron;
  const cron = async (): Promise<CronEngine> => {
    engine ??= await experimental_loadCronEngine();
    return engine;
  };

  const ownTask = (entry: TimerEntry): boolean =>
    config.agent !== undefined
      ? entry.trigger?.agent === config.agent
      : entry.trigger?.routineId === undefined && entry.trigger?.agent === undefined;

  const scheduleTask = tool({
    name: 'schedule_task',
    description:
      'Schedule a task to run after a delay, at a specific time, or on a cron schedule. Provide exactly one of: delay, cron, or at.',
    parameters: scheduleParams,
    ...(config.requiresApproval && { requiresApproval: true }),
    execute: async (
      { description, delay, cron: cronExpression, timezone, at, channel, userId, bestEffort },
      context
    ) => {
      const modes = [delay, cronExpression, at].filter(Boolean);
      if (modes.length !== 1) {
        throw new Error('Provide exactly one of: delay, cron, or at');
      }
      if (timezone !== undefined && !cronExpression) {
        throw new Error('timezone goes with cron only');
      }
      if (config.maxTasks !== undefined) {
        const waiting = (await store.getPending()).filter(ownTask).length;
        if (waiting >= config.maxTasks) {
          throw new Error(
            `There are ${waiting} tasks waiting already, the most there may be: cancel one first`
          );
        }
      }

      let firesAt: number;
      let type: 'fixed' | 'cron';
      let cronExpr: string | undefined;
      let zone: string | undefined;

      if (delay) {
        firesAt = Date.now() + parseDuration(delay);
        type = 'fixed';
      } else if (cronExpression) {
        zone = timezone ?? config.timezone;
        if (zone !== undefined && !isKnownTimezone(zone)) {
          throw new Error(`Unknown time zone: ${zone}`);
        }
        const engineNow = await cron();
        const problem = engineNow.problem(cronExpression, zone);
        if (problem) throw new Error(problem);
        cronExpr = engineNow.normalize(cronExpression);
        firesAt = engineNow.next(cronExpr, Date.now(), zone);
        type = 'cron';
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
        ...(zone !== undefined && { timezone: zone }),
        ...(config.agent !== undefined && { trigger: { agent: config.agent } }),
        metadata: {
          description,
          source: 'agent',
          channel: channel ?? context.channelType ?? defaultChannel,
          channelId: context.channelId,
          ...(context.topicId !== undefined && { topicId: context.topicId }),
          ...(context.conversationId !== undefined && { conversationId: context.conversationId }),
          ...(config.agent !== undefined &&
            context.threadId !== undefined && { threadId: context.threadId }),
          userId: userId ?? context.userId ?? defaultUserId,
          ...(bestEffort ? { bestEffort: true } : {}),
        },
      });

      const stored = await store.get(id);
      const scheduledAt = stored?.firesAt ?? firesAt;
      return {
        scheduled: true,
        id,
        firesAt: new Date(scheduledAt).toISOString(),
        ...(zone !== undefined && { timezone: zone }),
      };
    },
  });

  const listTasks = tool({
    name: 'list_tasks',
    description: 'List all pending scheduled tasks.',
    parameters: listParams,
    annotations: { readOnlyHint: true },
    execute: async () => {
      const pending: TimerEntry[] = (await store.getPending()).filter(ownTask);
      return {
        tasks: pending.map((entry) => ({
          id: entry.id,
          description: (entry.metadata as Record<string, unknown> | undefined)?.description ?? '',
          nextFire: new Date(entry.firesAt).toISOString(),
          ...(entry.cron ? { cron: entry.cron } : {}),
          ...(entry.timezone ? { timezone: entry.timezone } : {}),
        })),
      };
    },
  });

  const cancelTask = tool({
    name: 'cancel_task',
    description: 'Cancel a scheduled task by its ID.',
    parameters: cancelParams,
    execute: async ({ id }) => {
      const entry = await store.get(id);
      if (entry && !ownTask(entry)) {
        throw new Error(`Task ${id} is not one of the scheduled tasks this agent can cancel`);
      }
      await store.cancel(id);
      return { cancelled: true, id };
    },
  });

  return toolset(scheduleTask, listTasks, cancelTask);
}
