import { CronExpressionParser } from 'cron-parser';
import { experimental_createCronEngine } from '@cogitator-ai/core';

/**
 * The cron engine of the channels package: the core's, over the `cron-parser` this package
 * depends on, so the scheduler, `schedule_task` and `getNextCronMs` read an expression alike
 */
export const channelsCron = experimental_createCronEngine(CronExpressionParser);

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
