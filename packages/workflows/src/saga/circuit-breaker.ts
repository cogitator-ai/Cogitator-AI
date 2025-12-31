/**
 * Circuit Breaker pattern implementation
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Failures exceeded threshold, requests fail fast
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 *
 * Features:
 * - Per-node circuit breakers
 * - Configurable failure threshold
 * - Automatic recovery testing
 * - Success threshold for full recovery
 * - Event hooks for monitoring
 */

import type { CircuitBreakerConfig, CircuitBreakerState } from '@cogitator-ai/types';

const DEFAULT_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT = 30000;
const DEFAULT_SUCCESS_THRESHOLD = 2;
const DEFAULT_HALF_OPEN_MAX = 3;

/**
 * Circuit breaker state data
 */
interface CircuitBreakerData {
  state: CircuitBreakerState;
  failures: number;
  successes: number;
  lastFailure?: number;
  lastStateChange: number;
  halfOpenAttempts: number;
  totalFailures: number;
  totalSuccesses: number;
  consecutiveSuccesses: number;
}

/**
 * Circuit breaker event types
 */
export type CircuitBreakerEvent =
  | { type: 'state_change'; from: CircuitBreakerState; to: CircuitBreakerState; nodeId: string }
  | { type: 'success'; nodeId: string; duration: number }
  | { type: 'failure'; nodeId: string; error: Error }
  | { type: 'rejected'; nodeId: string; reason: string };

/**
 * Circuit breaker event handler
 */
export type CircuitBreakerEventHandler = (event: CircuitBreakerEvent) => void;

/**
 * CircuitBreaker class for managing per-node circuit breakers
 */
/**
 * Internal config type with defaults
 */
interface CircuitBreakerInternalConfig {
  enabled: boolean;
  threshold: number;
  resetTimeout: number;
  successThreshold: number;
  halfOpenMax: number;
  onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState, nodeId: string) => void;
}

export class CircuitBreaker {
  private config: CircuitBreakerInternalConfig;
  private breakers = new Map<string, CircuitBreakerData>();
  private eventHandlers: CircuitBreakerEventHandler[] = [];

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      threshold: config.threshold ?? DEFAULT_THRESHOLD,
      resetTimeout: config.resetTimeout ?? DEFAULT_RESET_TIMEOUT,
      successThreshold: config.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD,
      halfOpenMax: config.halfOpenMax ?? DEFAULT_HALF_OPEN_MAX,
      onStateChange: config.onStateChange,
    };
  }

  /**
   * Get or create circuit breaker data for a node
   */
  private getBreaker(nodeId: string): CircuitBreakerData {
    if (!this.breakers.has(nodeId)) {
      this.breakers.set(nodeId, {
        state: 'closed',
        failures: 0,
        successes: 0,
        lastStateChange: Date.now(),
        halfOpenAttempts: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        consecutiveSuccesses: 0,
      });
    }
    return this.breakers.get(nodeId)!;
  }

  /**
   * Change circuit state
   */
  private changeState(
    nodeId: string,
    breaker: CircuitBreakerData,
    newState: CircuitBreakerState
  ): void {
    if (breaker.state === newState) return;

    const oldState = breaker.state;
    breaker.state = newState;
    breaker.lastStateChange = Date.now();

    if (newState === 'half-open') {
      breaker.halfOpenAttempts = 0;
      breaker.consecutiveSuccesses = 0;
    } else if (newState === 'closed') {
      breaker.failures = 0;
      breaker.successes = 0;
    }

    const event: CircuitBreakerEvent = {
      type: 'state_change',
      from: oldState,
      to: newState,
      nodeId,
    };
    this.emit(event);

    this.config.onStateChange?.(oldState, newState, nodeId);
  }

  /**
   * Check if request should be allowed
   */
  canExecute(nodeId: string): boolean {
    if (!this.config.enabled) return true;

    const breaker = this.getBreaker(nodeId);
    const now = Date.now();

    switch (breaker.state) {
      case 'closed':
        return true;

      case 'open': {
        const elapsed = now - breaker.lastStateChange;
        if (elapsed >= this.config.resetTimeout) {
          this.changeState(nodeId, breaker, 'half-open');
          return true;
        }
        return false;
      }

      case 'half-open':
        return breaker.halfOpenAttempts < this.config.halfOpenMax;

      default:
        return true;
    }
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute(nodeId)) {
      const event: CircuitBreakerEvent = {
        type: 'rejected',
        nodeId,
        reason: 'Circuit breaker is open',
      };
      this.emit(event);
      throw new CircuitBreakerOpenError(nodeId, this.getBreaker(nodeId));
    }

    const breaker = this.getBreaker(nodeId);
    const startTime = Date.now();

    if (breaker.state === 'half-open') {
      breaker.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.recordSuccess(nodeId, Date.now() - startTime);
      return result;
    } catch (error) {
      this.recordFailure(nodeId, error as Error);
      throw error;
    }
  }

  /**
   * Record a successful execution
   */
  recordSuccess(nodeId: string, duration = 0): void {
    const breaker = this.getBreaker(nodeId);

    breaker.successes++;
    breaker.totalSuccesses++;
    breaker.consecutiveSuccesses++;

    const event: CircuitBreakerEvent = {
      type: 'success',
      nodeId,
      duration,
    };
    this.emit(event);

    switch (breaker.state) {
      case 'half-open':
        if (breaker.consecutiveSuccesses >= this.config.successThreshold) {
          this.changeState(nodeId, breaker, 'closed');
        }
        break;

      case 'closed':
        breaker.failures = 0;
        break;
    }
  }

  /**
   * Record a failed execution
   */
  recordFailure(nodeId: string, error: Error): void {
    const breaker = this.getBreaker(nodeId);

    breaker.failures++;
    breaker.totalFailures++;
    breaker.lastFailure = Date.now();
    breaker.consecutiveSuccesses = 0;

    const event: CircuitBreakerEvent = {
      type: 'failure',
      nodeId,
      error,
    };
    this.emit(event);

    switch (breaker.state) {
      case 'closed':
        if (breaker.failures >= this.config.threshold) {
          this.changeState(nodeId, breaker, 'open');
        }
        break;

      case 'half-open':
        this.changeState(nodeId, breaker, 'open');
        break;
    }
  }

  /**
   * Get current state for a node
   */
  getState(nodeId: string): CircuitBreakerState {
    return this.getBreaker(nodeId).state;
  }

  /**
   * Get detailed stats for a node
   */
  getStats(nodeId: string): CircuitBreakerStats {
    const breaker = this.getBreaker(nodeId);
    const now = Date.now();

    return {
      nodeId,
      state: breaker.state,
      failures: breaker.failures,
      successes: breaker.successes,
      totalFailures: breaker.totalFailures,
      totalSuccesses: breaker.totalSuccesses,
      consecutiveSuccesses: breaker.consecutiveSuccesses,
      lastFailure: breaker.lastFailure,
      lastStateChange: breaker.lastStateChange,
      timeInState: now - breaker.lastStateChange,
      timeUntilReset:
        breaker.state === 'open'
          ? Math.max(0, this.config.resetTimeout - (now - breaker.lastStateChange))
          : undefined,
    };
  }

  /**
   * Get all node stats
   */
  getAllStats(): Map<string, CircuitBreakerStats> {
    const stats = new Map<string, CircuitBreakerStats>();
    for (const nodeId of this.breakers.keys()) {
      stats.set(nodeId, this.getStats(nodeId));
    }
    return stats;
  }

  /**
   * Force circuit state (for testing/admin)
   */
  forceState(nodeId: string, state: CircuitBreakerState): void {
    const breaker = this.getBreaker(nodeId);
    this.changeState(nodeId, breaker, state);
  }

  /**
   * Reset a circuit breaker
   */
  reset(nodeId: string): void {
    const breaker = this.getBreaker(nodeId);
    breaker.failures = 0;
    breaker.successes = 0;
    breaker.consecutiveSuccesses = 0;
    breaker.halfOpenAttempts = 0;
    this.changeState(nodeId, breaker, 'closed');
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const nodeId of this.breakers.keys()) {
      this.reset(nodeId);
    }
  }

  /**
   * Add event handler
   */
  onEvent(handler: CircuitBreakerEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx !== -1) {
        this.eventHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Emit event to all handlers
   */
  private emit(event: CircuitBreakerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
      }
    }
  }
}

/**
 * Circuit breaker stats
 */
export interface CircuitBreakerStats {
  nodeId: string;
  state: CircuitBreakerState;
  failures: number;
  successes: number;
  totalFailures: number;
  totalSuccesses: number;
  consecutiveSuccesses: number;
  lastFailure?: number;
  lastStateChange: number;
  timeInState: number;
  timeUntilReset?: number;
}

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  readonly nodeId: string;
  readonly state: CircuitBreakerState;
  readonly failures: number;
  readonly lastFailure?: number;

  constructor(nodeId: string, breaker: CircuitBreakerData) {
    super(`Circuit breaker is open for node '${nodeId}'`);
    this.name = 'CircuitBreakerOpenError';
    this.nodeId = nodeId;
    this.state = breaker.state;
    this.failures = breaker.failures;
    this.lastFailure = breaker.lastFailure;
  }
}

/**
 * Create a circuit breaker instance
 */
export function createCircuitBreaker(
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  return new CircuitBreaker(config);
}

/**
 * Decorator for circuit breaker protected methods
 */
export function WithCircuitBreaker(
  breaker: CircuitBreaker,
  nodeId: string
) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>;

    descriptor.value = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      return breaker.execute(nodeId, () => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}
