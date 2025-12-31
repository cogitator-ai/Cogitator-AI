/**
 * Structured error types for Cogitator
 *
 * Provides a comprehensive error system with:
 * - Typed error codes for programmatic handling
 * - HTTP status codes for API responses
 * - Error details for debugging
 * - Cause chaining for root cause analysis
 */


/**
 * Error codes organized by domain
 */
export enum ErrorCode {

  LLM_UNAVAILABLE = 'LLM_UNAVAILABLE',
  LLM_RATE_LIMITED = 'LLM_RATE_LIMITED',
  LLM_TIMEOUT = 'LLM_TIMEOUT',
  LLM_INVALID_RESPONSE = 'LLM_INVALID_RESPONSE',
  LLM_CONTEXT_LENGTH_EXCEEDED = 'LLM_CONTEXT_LENGTH_EXCEEDED',
  LLM_CONTENT_FILTERED = 'LLM_CONTENT_FILTERED',

  SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE',
  SANDBOX_TIMEOUT = 'SANDBOX_TIMEOUT',
  SANDBOX_OOM = 'SANDBOX_OOM',
  SANDBOX_EXECUTION_FAILED = 'SANDBOX_EXECUTION_FAILED',
  SANDBOX_INVALID_MODULE = 'SANDBOX_INVALID_MODULE',

  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TOOL_INVALID_ARGS = 'TOOL_INVALID_ARGS',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  TOOL_TIMEOUT = 'TOOL_TIMEOUT',

  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  MEMORY_WRITE_FAILED = 'MEMORY_WRITE_FAILED',
  MEMORY_READ_FAILED = 'MEMORY_READ_FAILED',

  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  AGENT_ALREADY_RUNNING = 'AGENT_ALREADY_RUNNING',
  AGENT_MAX_ITERATIONS = 'AGENT_MAX_ITERATIONS',

  WORKFLOW_NOT_FOUND = 'WORKFLOW_NOT_FOUND',
  WORKFLOW_STEP_FAILED = 'WORKFLOW_STEP_FAILED',
  WORKFLOW_CYCLE_DETECTED = 'WORKFLOW_CYCLE_DETECTED',

  SWARM_NO_WORKERS = 'SWARM_NO_WORKERS',
  SWARM_CONSENSUS_FAILED = 'SWARM_CONSENSUS_FAILED',

  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
}

/**
 * Maps error codes to HTTP status codes
 */
export const ERROR_STATUS_CODES: Record<ErrorCode, number> = {

  [ErrorCode.LLM_UNAVAILABLE]: 503,
  [ErrorCode.LLM_RATE_LIMITED]: 429,
  [ErrorCode.LLM_TIMEOUT]: 504,
  [ErrorCode.LLM_INVALID_RESPONSE]: 502,
  [ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED]: 400,
  [ErrorCode.LLM_CONTENT_FILTERED]: 400,

  [ErrorCode.SANDBOX_UNAVAILABLE]: 503,
  [ErrorCode.SANDBOX_TIMEOUT]: 504,
  [ErrorCode.SANDBOX_OOM]: 507,
  [ErrorCode.SANDBOX_EXECUTION_FAILED]: 500,
  [ErrorCode.SANDBOX_INVALID_MODULE]: 400,

  [ErrorCode.TOOL_NOT_FOUND]: 404,
  [ErrorCode.TOOL_INVALID_ARGS]: 400,
  [ErrorCode.TOOL_EXECUTION_FAILED]: 500,
  [ErrorCode.TOOL_TIMEOUT]: 504,

  [ErrorCode.MEMORY_UNAVAILABLE]: 503,
  [ErrorCode.MEMORY_WRITE_FAILED]: 500,
  [ErrorCode.MEMORY_READ_FAILED]: 500,

  [ErrorCode.AGENT_NOT_FOUND]: 404,
  [ErrorCode.AGENT_ALREADY_RUNNING]: 409,
  [ErrorCode.AGENT_MAX_ITERATIONS]: 400,

  [ErrorCode.WORKFLOW_NOT_FOUND]: 404,
  [ErrorCode.WORKFLOW_STEP_FAILED]: 500,
  [ErrorCode.WORKFLOW_CYCLE_DETECTED]: 400,

  [ErrorCode.SWARM_NO_WORKERS]: 503,
  [ErrorCode.SWARM_CONSENSUS_FAILED]: 500,

  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.CONFIGURATION_ERROR]: 500,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.NOT_IMPLEMENTED]: 501,
  [ErrorCode.CIRCUIT_OPEN]: 503,
};

/**
 * Error details for additional context
 */
export type ErrorDetails = Record<string, unknown>;

/**
 * Options for creating a CogitatorError
 */
export interface CogitatorErrorOptions {
  message: string;
  code: ErrorCode;
  statusCode?: number;
  details?: ErrorDetails;
  cause?: Error;
  retryable?: boolean;
  retryAfter?: number;
}

/**
 * Base error class for all Cogitator errors
 *
 * @example
 * ```typescript
 * throw new CogitatorError({
 *   message: 'LLM backend unavailable',
 *   code: ErrorCode.LLM_UNAVAILABLE,
 *   details: { backend: 'ollama', endpoint: 'http://localhost:11434' },
 *   retryable: true,
 *   retryAfter: 5000,
 * });
 * ```
 */
export class CogitatorError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: ErrorDetails;
  readonly retryable: boolean;
  readonly retryAfter?: number;

  constructor(options: CogitatorErrorOptions) {
    super(options.message);
    this.name = 'CogitatorError';
    this.code = options.code;
    this.statusCode = options.statusCode ?? ERROR_STATUS_CODES[options.code];
    this.details = options.details;
    this.cause = options.cause;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter;

    const ErrorCtor = Error as typeof Error & {
      captureStackTrace?: (target: object, ctor?: NewableFunction) => void;
    };
    ErrorCtor.captureStackTrace?.(this, CogitatorError);
  }

  /**
   * Create a JSON representation for API responses
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
    };
  }

  /**
   * Check if an error is a CogitatorError
   */
  static isCogitatorError(error: unknown): error is CogitatorError {
    return error instanceof CogitatorError;
  }

  /**
   * Wrap any error as a CogitatorError
   */
  static wrap(error: unknown, code: ErrorCode = ErrorCode.INTERNAL_ERROR): CogitatorError {
    if (error instanceof CogitatorError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error : undefined;

    return new CogitatorError({
      message,
      code,
      cause,
    });
  }
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof CogitatorError) {
    return error.retryable;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('rate limit') ||
      message.includes('503') ||
      message.includes('429')
    );
  }

  return false;
}

/**
 * Get retry delay from an error
 */
export function getRetryDelay(error: unknown, defaultDelay = 1000): number {
  if (error instanceof CogitatorError && error.retryAfter) {
    return error.retryAfter;
  }
  return defaultDelay;
}
