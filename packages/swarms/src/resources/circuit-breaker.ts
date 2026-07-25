export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  threshold: number;
  resetTimeout: number;
  successThreshold?: number;
}

interface ResolvedCircuitBreakerConfig {
  threshold: number;
  resetTimeout: number;
  successThreshold: number;
}

export class CircuitBreaker {
  private config: ResolvedCircuitBreakerConfig;
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private stateChangeListeners: ((state: CircuitState) => void)[] = [];

  constructor(config: CircuitBreakerConfig) {
    this.config = {
      threshold: config.threshold,
      resetTimeout: config.resetTimeout,
      successThreshold: config.successThreshold ?? 1,
    };
  }

  getState(): CircuitState {
    return this.state;
  }

  canExecute(): boolean {
    this.checkOpenTimeout();
    return this.state === 'closed' || this.state === 'half-open';
  }

  recordSuccess(): void {
    this.checkOpenTimeout();
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
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

  private checkOpenTimeout(): void {
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.config.resetTimeout) {
      this.setState('half-open');
    }
  }

  private setState(newState: CircuitState): void {
    if (this.state !== newState) {
      this.state = newState;
      for (const listener of this.stateChangeListeners) {
        void Promise.resolve(listener(newState)).catch((error) => {
          console.warn('[CircuitBreaker] State change listener error:', error);
        });
      }
    }
  }
}
