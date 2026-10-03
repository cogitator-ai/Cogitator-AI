import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import type {
  ApprovalRequest,
  DeadLetterEntry,
  NodeContext,
  NodeResult,
  TimerEntry,
  WorkflowState,
} from '@cogitator-ai/types';
import { WorkflowBuilder } from '../builder';
import { WorkflowExecutor, NodeTimeoutError } from '../executor';
import { functionNode, customNode } from '../nodes';
import { humanWorkflowNode, timerWorkflowNode } from '../nodes/adapters';
import { createTracer, setGlobalTracer } from '../observability/tracer';
import { createMetricsCollector, setGlobalMetrics } from '../observability/metrics';
import { InMemoryCheckpointStore } from '../checkpoint';
import { delayNode } from '../timers/timer-node';
import { createInMemoryTimerStore } from '../timers/timer-store';
import { approvalNode } from '../human/human-node';
import { InMemoryApprovalStore } from '../human/approval-store';
import { createInMemoryDLQ } from '../saga/dead-letter';
import { DefaultWorkflowManager } from '../manager/workflow-manager';
import type { ExtendedNodeContext } from '../nodes/base';

const cogitator = {} as Cogitator;

function recorder() {
  const runs: string[] = [];
  const node =
    (name: string, delay = 0) =>
    async (): Promise<NodeResult<Record<string, unknown>>> => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      runs.push(name);
      return { output: name };
    };
  return { runs, node };
}

describe('WorkflowExecutor join semantics', () => {
  it('runs a join node once, after every upstream branch finished', async () => {
    const { runs, node } = recorder();
    const workflow = new WorkflowBuilder('join')
      .addParallel('fan', ['a', 'b'])
      .addNode('a', node('a'))
      .addNode('b', node('b'))
      .addNode('b2', node('b2'), { after: ['b'] })
      .addNode('b3', node('b3'), { after: ['b2'] })
      .addNode('merge', node('merge'), { after: ['a', 'b3'] })
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeUndefined();
    expect(runs.filter((r) => r === 'merge')).toHaveLength(1);
    expect(runs.indexOf('merge')).toBeGreaterThan(runs.indexOf('b3'));
    expect(result.nodeResults.get('merge')?.output).toBe('merge');
  });

  it('gives the join node the outputs of all its dependencies', async () => {
    let seen: unknown;
    const workflow = new WorkflowBuilder('join-input')
      .addParallel('fan', ['a', 'b'])
      .addNode('a', async () => ({ output: 1 }))
      .addNode('b', async () => ({ output: 2 }))
      .addNode('b2', async () => ({ output: 3 }), { after: ['b'] })
      .addNode(
        'merge',
        async (ctx) => {
          seen = ctx.input;
          return {};
        },
        { after: ['a', 'b2'] }
      )
      .build();

    await new WorkflowExecutor(cogitator).execute(workflow);

    expect(seen).toEqual([1, 3]);
  });

  it('does not block nodes inside loops on themselves', async () => {
    let count = 0;
    const workflow = new WorkflowBuilder<{ count: number }>('loop')
      .initialState({ count: 0 })
      .addNode('inc', async (ctx) => {
        count++;
        return { state: { count: ctx.state.count + 1 } };
      })
      .addLoop('check', {
        condition: (state) => (state as { count: number }).count < 3,
        back: 'inc',
        exit: 'done',
        after: ['inc'],
      })
      .addNode('done', async () => ({ output: 'done' }), { after: ['check'] })
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeUndefined();
    expect(count).toBe(3);
    expect(result.state.count).toBe(3);
    expect(result.nodeResults.has('done')).toBe(true);
  });
});

describe('WorkflowExecutor node config', () => {
  it('retries a failing node up to config.retries times', async () => {
    let attempts = 0;
    const workflow = new WorkflowBuilder('retry')
      .addNode(
        'flaky',
        async () => {
          attempts++;
          if (attempts < 3) throw new Error('transient');
          return { output: 'ok' };
        },
        { config: { retries: 2, retryDelay: 1 } }
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeUndefined();
    expect(attempts).toBe(3);
  });

  it('fails a node that exceeds config.timeout', async () => {
    const workflow = new WorkflowBuilder('timeout')
      .addNode('slow', () => new Promise(() => {}), { config: { timeout: 20 } })
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeInstanceOf(NodeTimeoutError);
    expect(result.error?.message).toBe("Node 'slow' timed out after 20ms");
  });

  it('aborts the node signal when the attempt times out', async () => {
    let seen: AbortSignal | undefined;
    const workflow = new WorkflowBuilder('timeout-abort')
      .addNode(
        'slow',
        (ctx) => {
          seen = (ctx as ExtendedNodeContext).signal;
          return new Promise(() => {});
        },
        { config: { timeout: 20 } }
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeInstanceOf(NodeTimeoutError);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(result.error);
  });

  it('forwards a run abort to a node that has a timeout', async () => {
    const controller = new AbortController();
    let abortedAfter: number | undefined;
    const workflow = new WorkflowBuilder('run-abort')
      .addNode(
        'waiting',
        (ctx) =>
          new Promise((_resolve, reject) => {
            const started = Date.now();
            (ctx as ExtendedNodeContext).signal?.addEventListener('abort', () => {
              abortedAfter = Date.now() - started;
              reject(new Error('cancelled'));
            });
          }),
        { config: { timeout: 5_000 } }
      )
      .build();

    setTimeout(() => controller.abort(), 20);
    await new WorkflowExecutor(cogitator).execute(workflow, undefined, {
      signal: controller.signal,
    });

    expect(abortedAfter).toBeDefined();
    expect(abortedAfter!).toBeLessThan(1_000);
  });

  it('passes the run signal itself to nodes without a timeout', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const workflow = new WorkflowBuilder('run-signal')
      .addNode('plain', async (ctx) => {
        seen = (ctx as ExtendedNodeContext).signal;
        return { output: 'ok' };
      })
      .build();

    await new WorkflowExecutor(cogitator).execute(workflow, undefined, {
      signal: controller.signal,
    });

    expect(seen).toBe(controller.signal);
  });

  it('keeps config from node factories', async () => {
    let attempts = 0;
    const node = customNode('factory', async () => {
      attempts++;
      if (attempts === 1) throw new Error('first attempt fails');
      return { output: 'second' };
    });
    node.config = { retries: 1 };

    const workflow = new WorkflowBuilder('factory').addNode('factory', node).build();
    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeUndefined();
    expect(result.nodeResults.get('factory')?.output).toBe('second');
  });

  it('passes the run signal to nodes', async () => {
    let received: AbortSignal | undefined;
    const controller = new AbortController();
    const workflow = new WorkflowBuilder('signal')
      .addNode('n', async (ctx: NodeContext) => {
        received = (ctx as NodeContext & { signal?: AbortSignal }).signal;
        return {};
      })
      .build();

    await new WorkflowExecutor(cogitator).execute(workflow, {}, { signal: controller.signal });

    expect(received).toBe(controller.signal);
  });
});

describe('WorkflowBuilder', () => {
  it('accepts node factories directly', () => {
    const workflow = new WorkflowBuilder('factories')
      .addNode(
        'double',
        functionNode('double', async () => 2)
      )
      .build();

    expect(workflow.nodes.get('double')?.fn).toBeTypeOf('function');
  });

  it('starts at a root parallel node', () => {
    const workflow = new WorkflowBuilder('fan')
      .addParallel('fan', ['a', 'b'])
      .addNode('a', async () => ({}))
      .addNode('b', async () => ({}))
      .build();

    expect(workflow.entryPoint).toBe('fan');
  });

  it('requires an explicit entry point when independent roots exist', () => {
    const builder = new WorkflowBuilder('two-roots')
      .addNode('a', async () => ({}))
      .addNode('b', async () => ({}));

    expect(() => builder.build()).toThrow('multiple root nodes: a, b');
  });

  it('routes conditional branches to conditionals and parallels', async () => {
    const { runs, node } = recorder();
    const workflow = new WorkflowBuilder<{ go: boolean }>('nested')
      .initialState({ go: true })
      .addNode('start', node('start'))
      .addConditional('first', (state) => ((state as { go: boolean }).go ? 'fan' : 'skip'), {
        after: ['start'],
      })
      .addParallel('fan', ['x', 'y'], { after: ['first'] })
      .addNode('skip', node('skip'), { after: ['first'] })
      .addNode('x', node('x'))
      .addNode('y', node('y'))
      .build();

    await new WorkflowExecutor(cogitator).execute(workflow);

    expect(runs.sort()).toEqual(['start', 'x', 'y']);
  });

  it('rejects nodes that hang off a loop without being its back or exit', () => {
    const builder = new WorkflowBuilder('bad-loop')
      .addNode('work', async () => ({}))
      .addLoop('loop', { condition: () => false, back: 'work', exit: 'end', after: ['work'] })
      .addNode('end', async () => ({}))
      .addNode('orphan', async () => ({}), { after: ['loop'] });

    expect(() => builder.build()).toThrow("'orphan' runs after loop 'loop'");
  });
});

describe('Observability integration', () => {
  it('records workflow and node spans and metrics', async () => {
    const tracer = createTracer({ exporter: 'console', enabled: true });
    const metricsCollector = createMetricsCollector();
    const exported = vi.spyOn(console, 'log').mockImplementation(() => {});

    const workflow = new WorkflowBuilder('observed')
      .addNode('a', async () => ({ output: 1 }))
      .addNode('b', async () => ({ output: 2 }), { after: ['a'] })
      .build();

    await new WorkflowExecutor(cogitator).execute(workflow, {}, { tracer, metricsCollector });

    const metrics = metricsCollector.getWorkflowMetrics('observed');
    expect(metrics?.executionCount).toBe(1);
    expect(metrics?.successCount).toBe(1);
    expect(metrics?.nodeMetrics.get('a')?.executionCount).toBe(1);

    const spans = (
      tracer as unknown as {
        completedSpans: { name: string; parentSpanId?: string; spanId: string }[];
      }
    ).completedSpans;
    const workflowSpan = spans.find((s) => s.name === 'workflow:observed');
    expect(workflowSpan).toBeDefined();
    expect(
      spans
        .filter((s) => s.name.startsWith('node:'))
        .every((s) => s.parentSpanId === workflowSpan?.spanId)
    ).toBe(true);
    exported.mockRestore();
  });
});

describe('DefaultWorkflowManager', () => {
  it('fails runs that exceed defaultTimeout', async () => {
    const manager = new DefaultWorkflowManager({ cogitator, defaultTimeout: 30 });
    const workflow = new WorkflowBuilder('slow')
      .addNode('wait', async () => {
        await new Promise((r) => setTimeout(r, 60));
        return {};
      })
      .addNode('after', async () => ({}), { after: ['wait'] })
      .build();

    const result = await manager.execute(workflow);

    expect(result.error?.message).toContain('timed out after 30ms');
    expect(result.nodeResults.has('after')).toBe(false);
  });
});

describe('WorkflowExecutor run policies', () => {
  it('applies defaultRetry to nodes without their own retries', async () => {
    let attempts = 0;
    const workflow = new WorkflowBuilder('default-retry')
      .addNode('flaky', async () => {
        attempts++;
        if (attempts < 3) throw new Error('ECONNRESET while calling upstream');
        return { output: 'ok' };
      })
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        defaultRetry: { maxRetries: 3, backoff: 'constant', initialDelay: 1, jitter: 0 },
      }
    );

    expect(result.error).toBeUndefined();
    expect(attempts).toBe(3);
  });

  it('stops retrying errors the policy marks as not retryable', async () => {
    let attempts = 0;
    const workflow = new WorkflowBuilder('not-retryable')
      .addNode('fatal', async () => {
        attempts++;
        throw new Error('invalid input');
      })
      .build();

    await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        defaultRetry: { maxRetries: 5, initialDelay: 1, isRetryable: () => false },
      }
    );

    expect(attempts).toBe(1);
  });

  it('opens a per-node circuit breaker shared across runs', async () => {
    let calls = 0;
    const workflow = new WorkflowBuilder('breaker')
      .addNode('unstable', async () => {
        calls++;
        throw new Error('down');
      })
      .build();
    const executor = new WorkflowExecutor(cogitator);
    const defaultCircuitBreaker = { threshold: 2, resetTimeout: 60_000 };

    await executor.execute(workflow, {}, { defaultCircuitBreaker });
    await executor.execute(workflow, {}, { defaultCircuitBreaker });
    const third = await executor.execute(workflow, {}, { defaultCircuitBreaker });

    expect(calls).toBe(2);
    expect(third.error?.name).toBe('CircuitBreakerOpenError');
  });

  it('writes finally failed nodes to the dead letter queue', async () => {
    const { createInMemoryDLQ } = await import('../saga/dead-letter');
    const deadLetterQueue = createInMemoryDLQ();
    const workflow = new WorkflowBuilder<{ orderId: string }>('dlq')
      .initialState({ orderId: 'o-1' })
      .addNode('charge', async () => {
        throw new Error('card declined');
      })
      .build();

    await new WorkflowExecutor(cogitator).execute(workflow, {}, { deadLetterQueue });

    const entries = await deadLetterQueue.list({ workflowName: 'dlq' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ nodeId: 'charge', error: { message: 'card declined' } });
    expect(entries[0].state).toMatchObject({ orderId: 'o-1' });
  });

  it('reuses completed node results for the same workflow id', async () => {
    const { createInMemoryIdempotencyStore } = await import('../saga/idempotency');
    const idempotencyStore = createInMemoryIdempotencyStore();
    let charges = 0;
    const workflow = new WorkflowBuilder('idempotent')
      .addNode('charge', async () => {
        charges++;
        return { output: `receipt-${charges}` };
      })
      .build();
    const executor = new WorkflowExecutor(cogitator);

    const first = await executor.execute(workflow, {}, { workflowId: 'wf-1', idempotencyStore });
    const second = await executor.execute(workflow, {}, { workflowId: 'wf-1', idempotencyStore });

    expect(charges).toBe(1);
    expect(second.nodeResults.get('charge')?.output).toBe(first.nodeResults.get('charge')?.output);
  });

  it('provides run-level approval stores to human nodes', async () => {
    const { humanWorkflowNode } = await import('../nodes/adapters');
    const { approvalNode } = await import('../human/human-node');
    const { InMemoryApprovalStore } = await import('../human/approval-store');
    const approvalStore = new InMemoryApprovalStore();

    const workflow = new WorkflowBuilder('approval-defaults')
      .addNode('ok', humanWorkflowNode(approvalNode('ok', { title: 'OK?' })))
      .build();

    const running = new WorkflowExecutor(cogitator).execute(workflow, {}, { approvalStore });
    let pending = await approvalStore.getPendingRequests();
    while (pending.length === 0) {
      await new Promise((r) => setTimeout(r, 2));
      pending = await approvalStore.getPendingRequests();
    }
    await approvalStore.submitResponse({
      requestId: pending[0].id,
      decision: false,
      respondedBy: 'qa',
      respondedAt: Date.now(),
    });

    const result = await running;
    expect(result.nodeResults.get('ok')?.output).toMatchObject({ approved: false });
  });
});

describe('Run observer callbacks', () => {
  it('reports persisted timers to onTimerScheduled', async () => {
    const timerStore = createInMemoryTimerStore();
    const scheduled: TimerEntry[] = [];
    const workflow = new WorkflowBuilder('timed')
      .addNode('wait', timerWorkflowNode(delayNode('wait', 5, { persist: true })))
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        timerStore,
        onTimerScheduled: (entry) => scheduled.push(entry),
      }
    );

    expect(result.error).toBeUndefined();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ nodeId: 'wait', workflowId: result.workflowId });
  });

  it('reports approval requests to onApprovalRequired', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const requested: ApprovalRequest[] = [];
    const workflow = new WorkflowBuilder('approve')
      .addNode('review', humanWorkflowNode(approvalNode('review', { title: 'Ship it?' })))
      .build();

    const running = new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        approvalStore,
        onApprovalRequired: (request) => {
          requested.push(request);
          void approvalStore.submitResponse({
            requestId: request.id,
            decision: true,
            respondedBy: 'lead',
            respondedAt: Date.now(),
          });
        },
      }
    );

    const result = await running;
    expect(result.error).toBeUndefined();
    expect(requested.map((r) => r.title)).toEqual(['Ship it?']);
  });

  it('reports dead-lettered nodes to onDeadLetter', async () => {
    const deadLetterQueue = createInMemoryDLQ();
    const dead: DeadLetterEntry[] = [];
    const workflow = new WorkflowBuilder('dlq')
      .addNode('boom', async () => {
        throw new Error('exploded');
      })
      .build();

    await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        deadLetterQueue,
        onDeadLetter: (entry) => dead.push(entry),
      }
    );

    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ nodeId: 'boom', error: { message: 'exploded' } });
    expect(await deadLetterQueue.get(dead[0].id)).not.toBeNull();
  });

  it('keeps running when an observer throws', async () => {
    const deadLetterQueue = createInMemoryDLQ();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workflow = new WorkflowBuilder('dlq-throw')
      .addNode('boom', async () => {
        throw new Error('exploded');
      })
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        deadLetterQueue,
        onDeadLetter: () => {
          throw new Error('observer broke');
        },
      }
    );

    expect(result.error?.message).toBe('exploded');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Saga compensation', () => {
  interface BookingState extends WorkflowState {
    log: string[];
  }

  function bookingWorkflow(log: string[], failAt = 'pay') {
    const step = (name: string) => ({
      name,
      fn: async (): Promise<NodeResult<BookingState>> => {
        if (name === failAt) throw new Error(`${name} failed`);
        log.push(`do:${name}`);
        return { output: `${name}-ref` };
      },
      config: {
        compensation: {
          compensate: async (_state: BookingState, original: unknown) => {
            log.push(`undo:${name}:${String(original)}`);
          },
        },
      },
    });
    return new WorkflowBuilder<BookingState>('booking')
      .initialState({ log: [] })
      .addNode('flight', step('flight'))
      .addNode('hotel', step('hotel'), { after: ['flight'] })
      .addNode('pay', step('pay'), { after: ['hotel'] })
      .build();
  }

  it('compensates completed nodes in reverse order when a later node fails', async () => {
    const log: string[] = [];
    const started: string[] = [];
    const completed: string[] = [];

    const result = await new WorkflowExecutor(cogitator).execute(
      bookingWorkflow(log),
      {},
      {
        onCompensationStart: (node) => started.push(node),
        onCompensationComplete: (node) => completed.push(node),
      }
    );

    expect(result.error?.message).toBe('pay failed');
    expect(log).toEqual([
      'do:flight',
      'do:hotel',
      'undo:hotel:hotel-ref',
      'undo:flight:flight-ref',
    ]);
    expect(started).toEqual(['hotel', 'flight']);
    expect(completed).toEqual(['hotel', 'flight']);
  });

  it('does not compensate a run that succeeded or was aborted', async () => {
    const log: string[] = [];
    await new WorkflowExecutor(cogitator).execute(bookingWorkflow(log, 'none'));
    expect(log).toEqual(['do:flight', 'do:hotel', 'do:pay']);

    const aborted: string[] = [];
    const controller = new AbortController();
    const workflow = new WorkflowBuilder<BookingState>('abortable')
      .initialState({ log: [] })
      .addNode('book', {
        name: 'book',
        fn: async () => ({ output: 'ref' }),
        config: { compensation: { compensate: async () => void aborted.push('undo') } },
      })
      .addNode(
        'wait',
        async (ctx) => {
          controller.abort();
          throw (ctx as ExtendedNodeContext<BookingState>).signal?.reason ?? new Error('aborted');
        },
        { after: ['book'] }
      )
      .build();

    await new WorkflowExecutor(cogitator).execute(workflow, {}, { signal: controller.signal });
    expect(aborted).toEqual([]);
  });

  it('compensates nodes that completed before a checkpoint resume', async () => {
    const log: string[] = [];
    const checkpointStore = new InMemoryCheckpointStore();
    const executor = new WorkflowExecutor(cogitator, checkpointStore);
    let failPay = false;
    const workflow = new WorkflowBuilder<BookingState>('resumable-booking')
      .initialState({ log: [] })
      .addNode('flight', {
        name: 'flight',
        fn: async () => ({ output: 'flight-ref' }),
        config: {
          compensation: { compensate: async (_s, ref) => void log.push(`undo:${String(ref)}`) },
        },
      })
      .addNode(
        'pay',
        async () => {
          if (failPay) throw new Error('declined');
          return {};
        },
        { after: ['flight'] }
      )
      .build();

    const first = await executor.execute(workflow, {}, { checkpoint: true });
    const [afterFlight] = (await checkpointStore.list('resumable-booking')).filter(
      (c) => c.completedNodes.includes('flight') && !c.completedNodes.includes('pay')
    );
    expect(first.error).toBeUndefined();

    failPay = true;
    const resumed = await executor.resume(workflow, afterFlight.id);

    expect(resumed.error?.message).toBe('declined');
    expect(log).toEqual(['undo:flight-ref']);
  });
});

describe('Global observability', () => {
  afterEach(() => {
    setGlobalTracer(createTracer({ enabled: false }));
    setGlobalMetrics(createMetricsCollector({ enabled: false }));
  });

  it('uses the global tracer and metrics when a run passes none', async () => {
    const tracer = createTracer({ enabled: true, exporter: 'console' });
    const startWorkflowSpan = vi.spyOn(tracer, 'startWorkflowSpan');
    const metrics = createMetricsCollector();
    setGlobalTracer(tracer);
    setGlobalMetrics(metrics);

    const workflow = new WorkflowBuilder('global-observed').addNode('a', async () => ({})).build();
    await new WorkflowExecutor(cogitator).execute(workflow);

    expect(startWorkflowSpan).toHaveBeenCalledWith(
      'global-observed',
      expect.any(String),
      expect.any(String)
    );
    expect(metrics.getWorkflowMetrics('global-observed')?.executionCount).toBe(1);
  });

  it('prefers the run tracer and metrics over the global ones', async () => {
    const globalTracer = createTracer({ enabled: true, exporter: 'console' });
    const globalSpans = vi.spyOn(globalTracer, 'startWorkflowSpan');
    const globalMetrics = createMetricsCollector();
    setGlobalTracer(globalTracer);
    setGlobalMetrics(globalMetrics);

    const workflow = new WorkflowBuilder('run-observed').addNode('a', async () => ({})).build();
    await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        tracer: createTracer({ enabled: true, exporter: 'console' }),
        metricsCollector: createMetricsCollector(),
      }
    );

    expect(globalSpans).not.toHaveBeenCalled();
    expect(globalMetrics.getWorkflowMetrics('run-observed')).toBeNull();
  });
});

describe('Executor resume and stream options', () => {
  it('passes executor-only options such as signal through resume() and stream()', async () => {
    const checkpointStore = new InMemoryCheckpointStore();
    const executor = new WorkflowExecutor(cogitator, checkpointStore);
    const workflow = new WorkflowBuilder('resumable')
      .addNode('a', async () => ({ output: 'a' }))
      .addNode('b', async () => ({ output: 'b' }), { after: ['a'] })
      .build();
    await executor.execute(workflow, {}, { checkpoint: true });
    const [first] = (await checkpointStore.list('resumable')).filter(
      (c) => c.completedNodes.length === 1
    );

    const controller = new AbortController();
    controller.abort();
    const resumed = await executor.resume(workflow, first.id, { signal: controller.signal });
    expect(resumed.error?.message).toBe('Workflow execution aborted');

    const metricsCollector = createMetricsCollector();
    for await (const event of executor.stream(workflow, {}, { metricsCollector })) {
      if (event.type === 'workflow_completed') expect(event.result.error).toBeUndefined();
    }
    expect(metricsCollector.getWorkflowMetrics('resumable')?.executionCount).toBe(1);
  });
});
