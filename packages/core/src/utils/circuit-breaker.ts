/**
 * Circuit Breaker pattern implementation
 *
 * Prevents cascading failures by failing fast when a service is unhealthy.
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests fail immediately
 * - HALF_OPEN: Testing if service recovered
 */

import { CogitatorError, ErrorCode, isRetryableError } from '@cogitator-ai/types';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms before trying again after opening (default: 30000) */
  resetTimeout?: number;
  /** Max requests allowed in half-open state (default: 3) */
  halfOpenRequests?: number;
  /** Function to determine if error should count as failure */
  isFailure?: (error: Error) => boolean;
  /** Called when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

const DEFAULT_OPTIONS: Required<Omit<CircuitBreakerOptions, 'isFailure' | 'onStateChange'>> = {
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenRequests: 3,
};

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  totalRequests: number;
  lastFailure?: Date;
  lastSuccess?: Date;
}

/**
 * Circuit Breaker for protecting external service calls
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({
 *   failureThreshold: 5,
 *   resetTimeout: 30000,
 *   onStateChange: (from, to) => {
 *     console.log(`Circuit ${from} -> ${to}`);
 *   },
 * });
 *
 * try {
 *   const result = await breaker.execute(() => callExternalService());
 * } catch (error) {
 *   if (error.code === ErrorCode.CIRCUIT_OPEN) {
 *     // Circuit is open, service is unhealthy
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private totalRequests = 0;
  private halfOpenRequests = 0;
  private lastFailure?: Date;
  private lastSuccess?: Date;
  private openedAt?: Date;
  private readonly options: Required<Omit<CircuitBreakerOptions, 'isFailure' | 'onStateChange'>>;
  private readonly isFailure: (error: Error) => boolean;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.isFailure = options.isFailure ?? isRetryableError;
    this.onStateChange = options.onStateChange;
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalRequests: this.totalRequests,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
    };
  }

  /**
   * Check if circuit should transition from open to half-open
   */
  private shouldAttemptReset(): boolean {
    if (this.state !== 'open' || !this.openedAt) {
      return false;
    }
    const elapsed = Date.now() - this.openedAt.getTime();
    return elapsed >= this.options.resetTimeout;
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;

    if (newState === 'open') {
      this.openedAt = new Date();
      this.halfOpenRequests = 0;
    } else if (newState === 'closed') {
      this.failures = 0;
      this.halfOpenRequests = 0;
    } else if (newState === 'half-open') {
      this.halfOpenRequests = 0;
    }

    this.onStateChange?.(oldState, newState);
  }

  /**
   * Record a successful call
   */
  private recordSuccess(): void {
    this.successes++;
    this.lastSuccess = new Date();

    if (this.state === 'half-open') {
      this.halfOpenRequests++;
      if (this.halfOpenRequests >= this.options.halfOpenRequests) {
        this.transitionTo('closed');
      }
    } else if (this.state === 'closed') {

      this.failures = 0;
    }
  }

  /**
   * Record a failed call
   */
  private recordFailure(): void {
    this.failures++;
    this.lastFailure = new Date();

    if (this.state === 'half-open') {

      this.transitionTo('open');
    } else if (this.state === 'closed') {
      if (this.failures >= this.options.failureThreshold) {
        this.transitionTo('open');
      }
    }
  }

  /**
   * Execute a function through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    if (this.shouldAttemptReset()) {
      this.transitionTo('half-open');
    }

    if (this.state === 'open') {
      throw new CogitatorError({
        message: 'Circuit breaker is open',
        code: ErrorCode.CIRCUIT_OPEN,
        retryable: true,
        retryAfter: this.options.resetTimeout,
        details: {
          state: this.state,
          failures: this.failures,
          lastFailure: this.lastFailure?.toISOString(),
        },
      });
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (this.isFailure(err)) {
        this.recordFailure();
      }

      throw error;
    }
  }

  /**
   * Force circuit to open state
   */
  open(): void {
    this.transitionTo('open');
  }

  /**
   * Force circuit to closed state
   */
  close(): void {
    this.transitionTo('closed');
  }

  /**
   * Reset circuit to initial state
   */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.totalRequests = 0;
    this.halfOpenRequests = 0;
    this.lastFailure = undefined;
    this.lastSuccess = undefined;
    this.openedAt = undefined;
  }
}

/**
 * Registry for managing multiple circuit breakers
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private readonly defaultOptions: CircuitBreakerOptions;

  constructor(defaultOptions: CircuitBreakerOptions = {}) {
    this.defaultOptions = defaultOptions;
  }

  /**
   * Get or create a circuit breaker by name
   */
  get(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ ...this.defaultOptions, ...options });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /**
   * Get all circuit breaker states
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
