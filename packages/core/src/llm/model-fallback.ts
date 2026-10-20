import {
  CogitatorError,
  ErrorCode,
  isRetryableError,
  type LLMBackend,
  type LLMErrorKind,
  type ModelCircuitBreakerConfig,
  type ModelFallbackEvent,
} from '@cogitator-ai/types';
import { CircuitBreakerRegistry } from '../utils/circuit-breaker';
import { abortReason, LLMError } from './errors';

/** One model of a turn's fallback chain, routed to the backend it runs on. */
export interface ModelCandidate {
  /** `provider/model`, the name the model is reported and priced by */
  name: string;
  backend: LLMBackend;
  /** The model name to send `backend` */
  model: string;
}

/** What a turn's model chain answered, and which model answered it. */
export interface ModelChainResult<T> {
  result: T;
  candidate: ModelCandidate;
}

/**
 * One model that failed a turn, for `details.attempts` of the error a chain fails with. Only
 * `details` holds the failures' messages: the error's own message, which servers pass on to
 * their clients, names the models and why they failed, never what an error of a backend said.
 */
export interface ModelAttempt {
  model: string;
  code?: ErrorCode;
  kind?: LLMErrorKind;
  message: string;
}

const FALLBACK_CODES: ReadonlySet<string> = new Set([
  ErrorCode.LLM_UNAVAILABLE,
  ErrorCode.LLM_RATE_LIMITED,
  ErrorCode.LLM_TIMEOUT,
  ErrorCode.LLM_QUOTA_EXCEEDED,
  ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED,
  ErrorCode.LLM_INVALID_RESPONSE,
  ErrorCode.CIRCUIT_OPEN,
]);

const STAYING_KINDS: ReadonlySet<LLMErrorKind> = new Set(['content_filter', 'invalid_request']);

const LASTING_KINDS: ReadonlySet<LLMErrorKind> = new Set([
  'quota',
  'authentication',
  'permission',
  'not_found',
]);

function kindOf(error: unknown): LLMErrorKind | undefined {
  return error instanceof LLMError ? error.kind : undefined;
}

/**
 * Whether a model call that failed with `error` may succeed on another model: the provider is
 * down, overloaded, slow or out of quota, the key or the model is wrong, or the answer was
 * unreadable. A request the provider refused for what it asks (`content_filter`,
 * `invalid_request`) would fail the same way elsewhere, and an error that is not a model
 * provider's, such as a bug in a tool or a configuration error, is not the model's to fix.
 */
export function fallsBackOn(error: unknown): boolean {
  const kind = kindOf(error);
  if (kind && STAYING_KINDS.has(kind)) return false;
  if (error instanceof CogitatorError) return FALLBACK_CODES.has(error.code);
  return isRetryableError(error);
}

/**
 * Whether `error` says the model will keep failing for longer than a breaker's failure count
 * should wait: an account out of quota, a rejected key, a model the credentials may not use or
 * that does not exist.
 */
function failsLasting(error: unknown): boolean {
  const kind = kindOf(error);
  return kind !== undefined && LASTING_KINDS.has(kind);
}

/**
 * Whether a failure of a model call counts against the model's breaker: one that falls back,
 * except a prompt too long for the model, which says nothing of the model's health.
 */
function countsAgainstModel(error: unknown): boolean {
  return (
    !(error instanceof CallerAbort) && fallsBackOn(error) && kindOf(error) !== 'context_overflow'
  );
}

/** A call that failed because the run was aborted or timed out, which no breaker should count. */
class CallerAbort extends Error {
  constructor() {
    super('The call was aborted');
  }
}

/** The error code every attempt failed with, when they all share one, else `LLM_UNAVAILABLE`. */
function commonCode(attempts: readonly ModelAttempt[]): ErrorCode {
  const [first] = attempts;
  const shared = first?.code;
  return shared !== undefined &&
    shared !== ErrorCode.CIRCUIT_OPEN &&
    attempts.every((attempt) => attempt.code === shared)
    ? shared
    : ErrorCode.LLM_UNAVAILABLE;
}

function describe(error: unknown): ModelAttempt['message'] {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs each turn of a run on the first of its models that answers. A model's failure moves the
 * turn to the next model only when `fallsBackOn` holds and the caller still allows it (a stream
 * that already reached the caller cannot be taken back); any other failure ends the turn as it
 * is. Every model has a circuit breaker shared across runs: a model that keeps failing, or fails
 * in a way that lasts, is skipped until its breaker lets a call through again.
 */
export class ModelFallbackChain {
  private readonly breakers: CircuitBreakerRegistry;

  constructor(config: ModelCircuitBreakerConfig = {}) {
    this.breakers = new CircuitBreakerRegistry({
      failureThreshold: config.failureThreshold,
      resetTimeout: config.resetTimeout,
      halfOpenRequests: config.halfOpenRequests,
      isFailure: countsAgainstModel,
    });
  }

  /**
   * `call` on the first model of `candidates` that answers. Without other models the call runs
   * as it is, outside any breaker, so a run without `fallbackModels` behaves as before.
   */
  async run<T>(
    candidates: readonly ModelCandidate[],
    call: (candidate: ModelCandidate) => Promise<T>,
    options: {
      signal?: AbortSignal;
      /** Whether a failed call may still move to the next model */
      canSwitch?: () => boolean;
      onFallback?: (event: ModelFallbackEvent) => void;
    } = {}
  ): Promise<ModelChainResult<T>> {
    const [first] = candidates;
    if (!first) {
      throw new CogitatorError({
        message: 'A turn needs at least one model',
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    if (candidates.length === 1) return { result: await call(first), candidate: first };

    const attempts: ModelAttempt[] = [];
    const errors: unknown[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const breaker = this.breakers.get(candidate.name);
      try {
        const result = await breaker.execute(async () => {
          try {
            return await call(candidate);
          } catch (error) {
            throw options.signal?.aborted ? new CallerAbort() : error;
          }
        });
        return { result, candidate };
      } catch (error) {
        const aborted = abortReason(options.signal);
        if (aborted) throw aborted;
        if (!fallsBackOn(error) || (options.canSwitch && !options.canSwitch())) throw error;
        if (failsLasting(error)) breaker.open();
        errors.push(error);
        const kind = kindOf(error);
        attempts.push({
          model: candidate.name,
          ...(error instanceof CogitatorError && { code: error.code }),
          ...(kind && { kind }),
          message: describe(error),
        });
        const next = candidates[i + 1];
        if (next) {
          options.onFallback?.({
            from: candidate.name,
            to: next.name,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    }

    throw new CogitatorError({
      message: `Every model of the turn failed: ${attempts.map((a) => `${a.model} (${a.kind ?? a.code ?? 'error'})`).join(', ')}`,
      code: commonCode(attempts),
      cause: errors.find((e): e is Error => e instanceof Error),
      retryable: errors.some(isRetryableError),
      details: { attempts },
    });
  }
}
