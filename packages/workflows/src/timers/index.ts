/**
 * @cogitator-ai/workflows - Timer module
 *
 * Provides timer and scheduling capabilities for workflow execution.
 *
 * Features:
 * - Fixed and dynamic delay nodes
 * - Cron-based scheduling with timezone support
 * - Timer persistence across restarts
 * - Background timer processing
 * - Automatic recovery of missed timers
 * - Cleanup of old timers
 */

export {
  type TimerQueryOptions,
  InMemoryTimerStore,
  FileTimerStore,
  createInMemoryTimerStore,
  createFileTimerStore,
} from './timer-store';

export {
  type ParsedCron,
  type CronIteratorOptions,
  CRON_PRESETS,
  CRON_FIELDS,
  validateCronExpression,
  parseCronExpression,
  getNextCronOccurrence,
  getPreviousCronOccurrence,
  getNextCronOccurrences,
  cronMatchesDate,
  msUntilNextCronOccurrence,
  describeCronExpression,
  createCronIterator,
  isValidCronExpression,
  getSupportedTimezones,
  isValidTimezone,
} from './cron-parser';

export {
  type TimerNodeType,
  type TimerNodeConfig,
  type FixedDelayConfig,
  type DynamicDelayConfig,
  type CronWaitConfig,
  type UntilDateConfig,
  type AnyTimerNodeConfig,
  type TimerNodeResult,
  type TimerExecutionContext,
  delayNode,
  dynamicDelayNode,
  cronWaitNode,
  untilNode,
  calculateTimerDelay,
  executeTimerNode,
  createTimerNodeHelpers,
  AbortError,
  Duration,
  parseDuration,
  formatDuration,
} from './timer-node';

export {
  type TimerHandler,
  type TimerManagerConfig,
  type TimerManagerStats,
  TimerManager,
  createTimerManager,
  RecurringTimerScheduler,
  createRecurringScheduler,
} from './timer-manager';
