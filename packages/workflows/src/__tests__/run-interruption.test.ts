import { describe, it, expect, vi } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import type { NodeResult, WorkflowCheckpoint } from '@cogitator-ai/types';
import { WorkflowBuilder } from '../builder';
import { WorkflowExecutor } from '../executor';
import { InMemoryCheckpointStore } from '../checkpoint';
import { createInMemoryIdempotencyStore } from '../saga/idempotency';
import { InMemoryDLQ } from '../saga/dead-letter';
import { createWorkflowManager } from '../manager/workflow-manager';
import { executeMap, executeMapReduce, collect, type MapItemResult } from '../patterns/map-reduce';
import { mapWorkflowNode } from '../nodes/adapters';

const cogitator = {} as Cogitator;

type State = Record<string, unknown>;

function waitFor(condition: () => boolean, timeout = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error('condition not met'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

type MapFailure<T> = Error & { partialResults: MapItemResult<T>[] };

async function mapFailure<T>(run: Promise<MapItemResult<T>[]>): Promise<MapFailure<T>> {
  try {
    await run;
  } catch (error) {
    return error as MapFailure<T>;
  }
  throw new Error('the map did not fail');
}

function abortable(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true }
    );
  });
}

describe('idempotency across resume', () => {
  it('does not repeat a side effect when a run resumes from a checkpoint taken before it', async () => {
    const checkpoints: WorkflowCheckpoint[] = [];
    const store = new InMemoryCheckpointStore();
    const save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
      await save(checkpoint);
    });

    let charges = 0;
    const workflow = new WorkflowBuilder<State>('checkout')
      .addNode('a', async () => ({ output: 'a' }))
      .addNode('b', async () => ({ output: 'b' }), { after: ['a'] })
      .addNode(
        'charge',
        async (): Promise<NodeResult<State>> => {
          charges++;
          return { output: `receipt-${charges}` };
        },
        { after: ['b'] }
      )
      .build();

    const idempotencyStore = createInMemoryIdempotencyStore();
    const executor = new WorkflowExecutor(cogitator, store);
    const first = await executor.execute(
      workflow,
      {},
      {
        workflowId: 'wf-checkout',
        checkpoint: true,
        idempotencyStore,
      }
    );
    expect(first.error).toBeUndefined();
    expect(charges).toBe(1);

    const beforeCharge = checkpoints.find(
      (c) => c.completedNodes.includes('b') && !c.completedNodes.includes('charge')
    );
    expect(beforeCharge).toBeDefined();

    const resumed = await executor.resume(workflow, beforeCharge!.id, { idempotencyStore });

    expect(resumed.error).toBeUndefined();
    expect(charges).toBe(1);
    expect(resumed.nodeResults.get('charge')?.output).toBe('receipt-1');
  });

  it('keys every visit of a looping node separately, also after a resume', async () => {
    const checkpoints: WorkflowCheckpoint[] = [];
    const store = new InMemoryCheckpointStore();
    const save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
      await save(checkpoint);
    });

    const visits: number[] = [];
    const workflow = new WorkflowBuilder<{ count: number }>('loop')
      .initialState({ count: 0 })
      .addNode('tick', async (ctx) => {
        visits.push(ctx.state.count);
        return { state: { count: ctx.state.count + 1 }, output: ctx.state.count };
      })
      .addLoop('again', {
        condition: (state) => state.count < 3,
        back: 'tick',
        exit: 'done',
        after: ['tick'],
      })
      .addNode('done', async () => ({ output: 'done' }))
      .build();

    const idempotencyStore = createInMemoryIdempotencyStore();
    const executor = new WorkflowExecutor(cogitator, store);
    const result = await executor.execute(
      workflow,
      {},
      {
        workflowId: 'wf-loop',
        checkpoint: true,
        idempotencyStore,
      }
    );

    expect(result.error).toBeUndefined();
    expect(visits).toEqual([0, 1, 2]);
    expect(checkpoints.at(-1)?.nodeVisits).toMatchObject({ tick: 3 });
  });
});

describe('stopped runs and the dead letter queue', () => {
  it('pausing a run does not dead-letter the node it interrupted', async () => {
    let started = false;
    const workflow = new WorkflowBuilder<State>('pausable')
      .addNode('slow', async (ctx) => {
        started = true;
        await abortable((ctx as { signal?: AbortSignal }).signal, 5000);
        return { output: 'done' };
      })
      .build();

    const dlq = new InMemoryDLQ();
    const onNodeError = vi.fn();
    const manager = createWorkflowManager({
      cogitator,
      checkpointStore: new InMemoryCheckpointStore(),
    });

    let runId: string | undefined;
    manager.onRunStateChange((run) => {
      runId ??= run.id;
    });
    const running = manager.execute(workflow, undefined, { deadLetterQueue: dlq, onNodeError });
    await waitFor(() => started && runId !== undefined);

    await manager.pause(runId!);
    const result = await running;

    expect(result.error?.message).toContain('paused');
    expect(await dlq.count()).toBe(0);
    expect(onNodeError).not.toHaveBeenCalled();
    expect((await manager.getStatus(runId!))?.status).toBe('paused');
  });

  it('still dead-letters a node that fails on its own', async () => {
    const workflow = new WorkflowBuilder<State>('failing')
      .addNode('broken', async () => {
        throw new Error('boom');
      })
      .build();
    const dlq = new InMemoryDLQ();

    const result = await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        deadLetterQueue: dlq,
      }
    );

    expect(result.error?.message).toBe('boom');
    expect(await dlq.count()).toBe(1);
  });
});

describe('map cancellation', () => {
  it('starts no new items after one fails, and reports what each item really did', async () => {
    const started: number[] = [];
    const error = await mapFailure(
      executeMap(
        { items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
        {
          name: 'fail-fast',
          items: (state) => state.items,
          concurrency: 2,
          mapper: async (item, _index, _state, ctx) => {
            const n = item as number;
            started.push(n);
            if (n === 0) throw new Error('item 0 broke');
            await abortable(ctx.signal, 30);
            return n * 10;
          },
        }
      )
    );

    expect(error.message).toBe('item 0 broke');
    expect(started.length).toBeLessThanOrEqual(2);
    const results = error.partialResults;
    expect(results).toHaveLength(10);
    expect(results[0]).toMatchObject({ success: false, error: { message: 'item 0 broke' } });
    expect(
      results.slice(2).every((r) => !r.success && r.error?.name === 'MapItemSkippedError')
    ).toBe(true);
  });

  it('keeps the results of items that finished before the failure', async () => {
    const error = await mapFailure(
      executeMap(
        { items: [1, 2, 3] },
        {
          name: 'partial',
          items: (state) => state.items,
          concurrency: 1,
          mapper: async (item) => {
            if (item === 2) throw new Error('two');
            return (item as number) * 10;
          },
        }
      )
    );

    expect(error.partialResults[0]).toMatchObject({ success: true, result: 10 });
    expect(error.partialResults[1]).toMatchObject({ success: false });
    expect(error.partialResults[2]).toMatchObject({ success: false });
  });

  it('aborts a timed-out attempt before retrying, so attempts never overlap', async () => {
    let running = 0;
    let maxRunning = 0;
    const aborted: number[] = [];

    const results = await executeMap(
      { items: ['x'] },
      {
        name: 'timeouts',
        items: (state) => state.items,
        timeout: 20,
        retry: { maxAttempts: 3, delay: 1 },
        continueOnError: true,
        mapper: async (_item, _index, _state, ctx) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          try {
            await abortable(ctx.signal, 200);
          } catch (e) {
            aborted.push(ctx.attempt);
            throw e;
          } finally {
            running--;
          }
          return 'never';
        },
      }
    );

    expect(results[0].success).toBe(false);
    expect(aborted).toEqual([1, 2, 3]);
    expect(maxRunning).toBe(1);
  });

  it('stops the items in flight when the workflow run is aborted', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    let finished = 0;

    const workflow = new WorkflowBuilder<{ items: number[] }>('map-node')
      .initialState({ items: [1, 2, 3, 4] })
      .addNode(
        'map',
        mapWorkflowNode({
          name: 'map',
          items: (state: { items: number[] }) => state.items,
          concurrency: 2,
          mapper: async (_item, _index, _state, ctx) => {
            signals.push(ctx.signal);
            await abortable(ctx.signal, 500);
            finished++;
            return 1;
          },
        }).fn
      )
      .build();

    const running = new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        signal: controller.signal,
      }
    );
    await waitFor(() => signals.length === 2);
    controller.abort(new Error('cancelled by user'));
    const result = await running;

    expect(result.error).toBeDefined();
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(finished).toBe(0);
  });

  it('passes the run signal through map-reduce nodes too', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const mapper = vi.fn(async () => 1);

    await expect(
      executeMapReduce(
        { items: [1, 2] },
        {
          name: 'mr',
          map: { items: (state: { items: number[] }) => state.items, mapper },
          reduce: collect<number>(),
        },
        { signal: controller.signal }
      )
    ).rejects.toThrow('already cancelled');
    expect(mapper).not.toHaveBeenCalled();
  });
});
