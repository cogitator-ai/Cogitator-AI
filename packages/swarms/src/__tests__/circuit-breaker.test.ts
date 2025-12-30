/**
 * Tests for CircuitBreaker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from '../resources/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      threshold: 3,
      resetTimeout: 1000,
      successThreshold: 2,
    });
  });

  describe('initial state', () => {
    it('should start closed', () => {
      expect(breaker.getState()).toBe('closed');
    });

    it('should allow execution when closed', () => {
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('failure tracking', () => {
    it('should open after threshold failures', () => {
      breaker.recordFailure();
      expect(breaker.getState()).toBe('closed');

      breaker.recordFailure();
      expect(breaker.getState()).toBe('closed');

      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');
    });

    it('should not allow execution when open', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.canExecute()).toBe(false);
    });

    it('should reset failure count on success', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();

      expect(breaker.getState()).toBe('closed');

      breaker.recordFailure();
      expect(breaker.getState()).toBe('closed');
    });
  });

  describe('half-open state', () => {
    it('should transition to half-open after timeout', async () => {
      vi.useFakeTimers();

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.getState()).toBe('open');

      vi.advanceTimersByTime(1100);

      expect(breaker.getState()).toBe('half-open');
      expect(breaker.canExecute()).toBe(true);

      vi.useRealTimers();
    });

    it('should close after success threshold in half-open', async () => {
      vi.useFakeTimers();

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      vi.advanceTimersByTime(1100);
      expect(breaker.getState()).toBe('half-open');

      breaker.recordSuccess();
      expect(breaker.getState()).toBe('half-open');

      breaker.recordSuccess();
      expect(breaker.getState()).toBe('closed');

      vi.useRealTimers();
    });

    it('should reopen on failure in half-open', async () => {
      vi.useFakeTimers();

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      vi.advanceTimersByTime(1100);
      expect(breaker.getState()).toBe('half-open');

      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');

      vi.useRealTimers();
    });
  });

  describe('reset', () => {
    it('should reset to closed state', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.getState()).toBe('open');

      breaker.reset();

      expect(breaker.getState()).toBe('closed');
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('state change listeners', () => {
    it('should notify on state change', () => {
      const states: string[] = [];

      breaker.onStateChange((state) => {
        states.push(state);
      });

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(states).toContain('open');
    });

    it('should allow unsubscription', () => {
      const states: string[] = [];

      const unsub = breaker.onStateChange((state) => {
        states.push(state);
      });

      breaker.recordFailure();
      breaker.recordFailure();

      unsub();

      breaker.recordFailure();

      expect(states).toHaveLength(0);
    });
  });
});
