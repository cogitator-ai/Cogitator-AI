/**
 * Circuit breaker for preventing cascading failures
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  threshold: number;
  /** Time in ms to wait before allowing a test request */
  resetTimeout: number;
  /** Number of successful requests needed to close the circuit from half-open */
  successThreshold?: number;
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private stateChangeListeners: Array<(state: CircuitState) => void> = [];

  constructor(config: CircuitBreakerConfig) {
    this.config = {
      successThreshold: 1,
      ...config,
    };
  }

  getState(): CircuitState {
    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.config.resetTimeout) {
        this.setState('half-open');
      }
    }
    return this.state;
  }

  canExecute(): boolean {
    const state = this.getState();
    return state === 'closed' || state === 'half-open';
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold!) {
        this.setState('closed');
        this.reset();
      }
    } else if (this.state === 'closed') {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.setState('open');
      this.successCount = 0;
    } else if (this.state === 'closed') {
      this.failureCount++;
      if (this.failureCount >= this.config.threshold) {
        this.setState('open');
      }
    }
  }

  reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.setState('closed');
  }

  onStateChange(listener: (state: CircuitState) => void): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      const index = this.stateChangeListeners.indexOf(listener);
      if (index >= 0) {
        this.stateChangeListeners.splice(index, 1);
      }
    };
  }

  private setState(newState: CircuitState): void {
    if (this.state !== newState) {
      this.state = newState;
      for (const listener of this.stateChangeListeners) {
        try {
          listener(newState);
        } catch {
        }
      }
    }
  }
}
