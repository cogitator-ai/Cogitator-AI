import { CronExpressionParser } from 'cron-parser';
import { experimental_createCronEngine } from '@cogitator-ai/core';
import type { CronEngine } from '@cogitator-ai/types';

let engine: CronEngine | undefined;
const built = (): CronEngine => (engine ??= experimental_createCronEngine(CronExpressionParser));

/**
 * The cron engine of the channels package: the core's, over the `cron-parser` this package
 * depends on, so the scheduler, `schedule_task` and `getNextCronMs` read an expression alike.
 * Built on first use
 */
export const channelsCron: CronEngine = {
  next: (expression, after, timezone) => built().next(expression, after, timezone),
  previous: (expression, atOrBefore, timezone, count) =>
    built().previous(expression, atOrBefore, timezone, count),
  between: (expression, from, to, timezone, limit) =>
    built().between(expression, from, to, timezone, limit),
  problem: (expression, timezone) => built().problem(expression, timezone),
  normalize: (expression) => built().normalize(expression),
};

/**
 * The first occurrence of a cron expression after `from`, in `timezone` (the process's when
 * unset): 5 fields, 6 with seconds first, or a preset such as `@daily`
 */
export function getNextCronMs(
  expression: string,
  from: number = Date.now(),
  timezone?: string
): number {
  return channelsCron.next(expression, from, timezone);
}
