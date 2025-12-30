/**
 * Trigger System
 *
 * Workflow triggers for cron scheduling, webhooks, and events.
 */

// Rate limiter
export {
  TokenBucket,
  RateLimiter,
  SlidingWindowRateLimiter,
  createRateLimiter,
  createSlidingWindowLimiter,
} from './rate-limiter.js';

export type {
  TokenBucketConfig,
  RateLimitResult,
} from './rate-limiter.js';

// Cron trigger
export {
  CronTriggerExecutor,
  createCronTrigger,
  validateCronTriggerConfig,
} from './cron-trigger.js';

export type {
  CronTriggerState,
  CronTriggerResult,
} from './cron-trigger.js';

// Webhook trigger
export {
  WebhookTriggerExecutor,
  WebhookAuthError,
  WebhookRateLimitError,
  createWebhookTrigger,
  validateWebhookTriggerConfig,
} from './webhook-trigger.js';

export type {
  WebhookRequest,
  WebhookResponse,
  WebhookTriggerState,
  WebhookHandlerResult,
} from './webhook-trigger.js';

// Trigger manager
export {
  InMemoryTriggerStore,
  SimpleTriggerEventEmitter,
  DefaultTriggerManager,
  createTriggerManager,
  cronTrigger,
  webhookTrigger,
  eventTrigger,
} from './trigger-manager.js';

export type {
  TriggerStore,
  TriggerEventEmitter,
  TriggerManagerConfig,
} from './trigger-manager.js';
