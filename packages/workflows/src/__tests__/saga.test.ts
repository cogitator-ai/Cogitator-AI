import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeWithRetry,
  withRetry,
  CircuitBreaker,
  createCircuitBreaker,
  CircuitBreakerOpenError,
  CompensationManager,
  createCompensationManager,
  CompensationBuilder,
  compensationBuilder,
  InMemoryDLQ,
  createInMemoryDLQ,
  createDLQEntry,
  InMemoryIdempotencyStore,
  createInMemoryIdempotencyStore,
  generateIdempotencyKey,
  idempotent,
} from '../saga/index.js';

interface TestState {
  value: number;
  steps: string[];
}

describe('Saga Pattern', () => {
  describe('Retry', () => {
    it('succeeds on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await executeWithRetry(fn, { maxRetries: 3, backoff: 'constant', initialDelay: 100 });

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and eventually succeeds', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('success');

      // Use isRetryable: () => true to force retries on all errors
      const result = await executeWithRetry(fn, {
        maxRetries: 5,
        backoff: 'constant',
        initialDelay: 10,
        isRetryable: () => true,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('fails after max retries', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('connection reset'));

      // isRetryable: () => true means it will retry all errors
      const result = await executeWithRetry(fn, {
        maxRetries: 2,
        backoff: 'constant',
        initialDelay: 10,
        isRetryable: () => true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // maxRetries: 2 means 3 total attempts (1 initial + 2 retries)
      expect(result.attempts).toBe(3);
    });

    it('applies exponential backoff', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('success');

      const startTime = Date.now();

      await executeWithRetry(fn, {
        maxRetries: 3,
        backoff: 'exponential',
        initialDelay: 50,
        maxDelay: 1000,
        isRetryable: () => true,
      });
      const elapsed = Date.now() - startTime;

      // Should have waited at least initialDelay (50ms)
      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some tolerance
    });

    it('respects isRetryable condition', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fatal error'));

      const result = await executeWithRetry(fn, {
        maxRetries: 5,
        backoff: 'constant',
        initialDelay: 10,
        isRetryable: (error) => !error.message.includes('fatal'),
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1); // Should not retry
    });

    describe('withRetry wrapper', () => {
      it('wraps function with retry logic', async () => {
        const fn = vi.fn()
          .mockRejectedValueOnce(new Error('timeout'))
          .mockResolvedValue('success');

        const wrappedFn = withRetry(fn, {
          maxRetries: 3,
          backoff: 'constant',
          initialDelay: 10,
          isRetryable: () => true,
        });

        const result = await wrappedFn();
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Circuit Breaker', () => {
    let circuitBreaker: CircuitBreaker;
    const nodeId = 'test-node';

    beforeEach(() => {
      circuitBreaker = createCircuitBreaker({
        threshold: 3,
        resetTimeout: 100,
        successThreshold: 2,
      });
    });

    it('starts in closed state', () => {
      expect(circuitBreaker.getState(nodeId)).toBe('closed');
    });

    it('opens after reaching failure threshold', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // 3 failures should open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(nodeId, fn);
        } catch {
          // Expected
        }
      }

      expect(circuitBreaker.getState(nodeId)).toBe('open');
    });

    it('rejects calls when open', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(nodeId, fn);
        } catch {
          // Expected
        }
      }

      // Should reject without calling fn
      await expect(circuitBreaker.execute(nodeId, fn)).rejects.toThrow(CircuitBreakerOpenError);
      expect(fn).toHaveBeenCalledTimes(3); // No additional calls
    });

    it('transitions to half-open after reset timeout', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(nodeId, fn);
        } catch {
          // Expected
        }
      }

      expect(circuitBreaker.getState(nodeId)).toBe('open');

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Check if can execute - this will transition to half-open
      expect(circuitBreaker.canExecute(nodeId)).toBe(true);
      expect(circuitBreaker.getState(nodeId)).toBe('half-open');
    });

    it('closes after success threshold in half-open', async () => {
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) throw new Error('fail');
        return 'success';
      });

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(nodeId, fn);
        } catch {
          // Expected
        }
      }

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Trigger transition to half-open
      expect(circuitBreaker.canExecute(nodeId)).toBe(true);

      // Succeed twice to close
      await circuitBreaker.execute(nodeId, fn);
      await circuitBreaker.execute(nodeId, fn);

      expect(circuitBreaker.getState(nodeId)).toBe('closed');
    });

    it('provides statistics', async () => {
      const fnSuccess = vi.fn().mockResolvedValue('success');
      const fnFail = vi.fn().mockRejectedValue(new Error('fail'));

      await circuitBreaker.execute(nodeId, fnSuccess);
      try {
        await circuitBreaker.execute(nodeId, fnFail);
      } catch {
        // Expected
      }

      const stats = circuitBreaker.getStats(nodeId);
      expect(stats.totalSuccesses).toBe(1);
      expect(stats.totalFailures).toBe(1);
    });
  });

  describe('Compensation Manager', () => {
    it('executes compensations in reverse order', async () => {
      const manager = createCompensationManager<TestState>();
      const order: string[] = [];

      manager.registerCompensation('step1', async () => {
        order.push('comp1');
      });

      manager.registerCompensation('step2', async () => {
        order.push('comp2');
      });

      manager.registerCompensation('step3', async () => {
        order.push('comp3');
      });

      // Mark steps as completed
      manager.markCompleted('step1', { value: 1 });
      manager.markCompleted('step2', { value: 2 });
      manager.markCompleted('step3', { value: 3 });

      const state: TestState = { value: 0, steps: [] };
      const report = await manager.compensate(state, 'step3', new Error('Test failure'));

      expect(order).toEqual(['comp3', 'comp2', 'comp1']);
      expect(report.allSuccessful).toBe(true);
    });

    it('skips steps based on condition', async () => {
      const manager = createCompensationManager<TestState>();
      const executed: string[] = [];

      manager.registerCompensation(
        'step1',
        async () => {
          executed.push('comp1');
        },
        { condition: () => true }
      );

      manager.registerCompensation(
        'step2',
        async () => {
          executed.push('comp2');
        },
        { condition: () => false } // Skip this one
      );

      manager.markCompleted('step1', { value: 1 });
      manager.markCompleted('step2', { value: 2 });

      const state: TestState = { value: 0, steps: [] };
      const report = await manager.compensate(state, 'step2', new Error('Test failure'));

      expect(executed).toEqual(['comp1']);
      expect(report.compensated.find((r) => r.nodeId === 'step2')?.skipped).toBe(true);
    });

    it('only compensates completed nodes', async () => {
      const manager = createCompensationManager<TestState>();
      const executed: string[] = [];

      manager.registerCompensation('step1', async () => {
        executed.push('comp1');
      });

      manager.registerCompensation('step2', async () => {
        executed.push('comp2');
      });

      manager.registerCompensation('step3', async () => {
        executed.push('comp3');
      });

      // Only mark step1 and step2 as completed (step3 not completed)
      manager.markCompleted('step1', { value: 1 });
      manager.markCompleted('step2', { value: 2 });

      const state: TestState = { value: 0, steps: [] };
      await manager.compensate(state, 'step2', new Error('Test failure'));

      expect(executed).toEqual(['comp2', 'comp1']);
      expect(executed).not.toContain('comp3');
    });

    it('handles compensation failures', async () => {
      const manager = createCompensationManager<TestState>();
      const executed: string[] = [];

      manager.registerCompensation('step1', async () => {
        executed.push('comp1');
      });

      manager.registerCompensation('step2', async () => {
        throw new Error('comp2 failed');
      });

      manager.registerCompensation('step3', async () => {
        executed.push('comp3');
      });

      manager.markCompleted('step1', { value: 1 });
      manager.markCompleted('step2', { value: 2 });
      manager.markCompleted('step3', { value: 3 });

      const state: TestState = { value: 0, steps: [] };
      const report = await manager.compensate(state, 'step3', new Error('Test failure'));

      // All compensations should be attempted
      expect(executed).toContain('comp1');
      expect(executed).toContain('comp3');
      expect(report.allSuccessful).toBe(false);
      expect(report.partialFailures).toContain('step2');
    });

    describe('CompensationBuilder', () => {
      it('builds compensation manager with fluent API', () => {
        const manager = compensationBuilder<TestState>()
          .addStep('step1', async () => {})
          .addStep('step2', async () => {})
          .addConditionalStep(
            'step3',
            async () => {},
            () => true
          )
          .build();

        expect(manager.hasCompensation('step1')).toBe(true);
        expect(manager.hasCompensation('step2')).toBe(true);
        expect(manager.hasCompensation('step3')).toBe(true);
      });
    });
  });

  describe('Dead Letter Queue', () => {
    let dlq: InMemoryDLQ;

    beforeEach(() => {
      dlq = createInMemoryDLQ();
    });

    afterEach(() => {
      dlq.destroy();
    });

    it('adds entries', async () => {
      const entry = createDLQEntry(
        'node1',
        'wf1',
        'TestWorkflow',
        { value: 1 },
        new Error('test error'),
        { input: { test: true } }
      );

      const id = await dlq.add(entry);

      const entries = await dlq.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].nodeId).toBe('node1');
    });

    it('gets entry by id', async () => {
      const entry = createDLQEntry(
        'node1',
        'wf1',
        'TestWorkflow',
        { value: 1 },
        new Error('test'),
        {}
      );

      // add() returns the generated id
      const generatedId = await dlq.add(entry);

      const retrieved = await dlq.get(generatedId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.nodeId).toBe('node1');
    });

    it('removes entry', async () => {
      const entry = createDLQEntry(
        'node1',
        'wf1',
        'TestWorkflow',
        { value: 1 },
        new Error('test'),
        {}
      );

      const id = await dlq.add(entry);

      await dlq.remove(id);

      const retrieved = await dlq.get(id);
      expect(retrieved).toBeNull();
    });

    it('filters entries', async () => {
      const entry1 = createDLQEntry('node1', 'wf1', 'Workflow1', { value: 1 }, new Error('test'), {});
      const entry2 = createDLQEntry('node2', 'wf2', 'Workflow2', { value: 2 }, new Error('test'), {});

      await dlq.add(entry1);
      await dlq.add(entry2);

      const filtered = await dlq.list({ workflowId: 'wf1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].workflowId).toBe('wf1');
    });
  });

  describe('Idempotency Store', () => {
    let store: InMemoryIdempotencyStore;

    beforeEach(() => {
      store = createInMemoryIdempotencyStore();
    });

    afterEach(() => {
      store.destroy();
    });

    it('generates consistent keys', () => {
      const key1 = generateIdempotencyKey('wf1', 'node1', { a: 1 });
      const key2 = generateIdempotencyKey('wf1', 'node1', { a: 1 });
      const key3 = generateIdempotencyKey('wf1', 'node1', { a: 2 });

      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });

    it('checks and records execution', async () => {
      const key = 'test-key';

      // First check should indicate not executed
      const first = await store.check(key);
      expect(first.isDuplicate).toBe(false);

      // Store the result
      await store.store(key, { result: 'success' });

      // Second check should indicate executed
      const second = await store.check(key);
      expect(second.isDuplicate).toBe(true);
      expect(second.record?.result).toEqual({ result: 'success' });
    });

    it('respects TTL', async () => {
      const shortTTLStore = new InMemoryIdempotencyStore({ ttl: 50 });
      const key = 'ttl-test';

      await shortTTLStore.store(key, { result: 'success' });

      // Check immediately
      let check = await shortTTLStore.check(key);
      expect(check.isDuplicate).toBe(true);

      // Wait for TTL
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should be expired
      check = await shortTTLStore.check(key);
      expect(check.isDuplicate).toBe(false);

      shortTTLStore.destroy();
    });

    describe('idempotent wrapper', () => {
      it('prevents duplicate execution', async () => {
        let callCount = 0;
        const fn = async () => {
          callCount++;
          return `result-${callCount}`;
        };

        const key = 'same-key';

        // Call with same key twice
        const result1 = await idempotent(store, key, fn);
        const result2 = await idempotent(store, key, fn);

        expect(callCount).toBe(1);
        expect(result1).toBe('result-1');
        expect(result2).toBe('result-1');
      });

      it('executes for different keys', async () => {
        let callCount = 0;
        const fn = async () => {
          callCount++;
          return `result-${callCount}`;
        };

        await idempotent(store, 'key-a', fn);
        await idempotent(store, 'key-b', fn);

        expect(callCount).toBe(2);
      });

      it('stores and rethrows errors', async () => {
        const fn = async () => {
          throw new Error('Test error');
        };

        const key = 'error-key';

        // First call throws
        await expect(idempotent(store, key, fn)).rejects.toThrow('Test error');

        // Second call should also throw the cached error
        await expect(idempotent(store, key, fn)).rejects.toThrow('Test error');
      });
    });
  });
});
