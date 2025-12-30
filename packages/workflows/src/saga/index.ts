/**
 * @cogitator/workflows - Saga module
 *
 * Implements the Saga pattern for workflow resilience:
 * - Retry with exponential backoff and jitter
 * - Circuit breaker for fault isolation
 * - Compensation for rollback on failure
 * - Dead letter queue for failed operations
 * - Idempotency for safe retries
 */

export {
  executeWithRetry,
  withRetry,
  Retryable,
  estimateRetryDuration,
  type RetryResult,
  type AttemptInfo,
  type RetryOptions,
} from './retry.js';

export {
  CircuitBreaker,
  createCircuitBreaker,
  CircuitBreakerOpenError,
  WithCircuitBreaker,
  type CircuitBreakerEvent,
  type CircuitBreakerEventHandler,
  type CircuitBreakerStats,
} from './circuit-breaker.js';

export {
  CompensationManager,
  createCompensationManager,
  CompensationBuilder,
  compensationBuilder,
  type CompensationStep,
  type CompensationResult,
  type CompensationReport,
  type CompensationManagerSummary,
} from './compensation.js';

export {
  BaseDLQ,
  InMemoryDLQ,
  FileDLQ,
  createInMemoryDLQ,
  createFileDLQ,
  createDLQEntry,
  type ExtendedDeadLetterEntry,
  type DLQFilters,
} from './dead-letter.js';

export {
  BaseIdempotencyStore,
  InMemoryIdempotencyStore,
  FileIdempotencyStore,
  createInMemoryIdempotencyStore,
  createFileIdempotencyStore,
  generateIdempotencyKey,
  generateCustomKey,
  idempotent,
  Idempotent,
  type IdempotencyCheckResult,
} from './idempotency.js';
