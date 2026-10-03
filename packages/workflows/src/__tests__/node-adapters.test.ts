import { describe, it, expect } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import type { WorkflowState } from '@cogitator-ai/types';
import { WorkflowBuilder } from '../builder';
import { WorkflowExecutor } from '../executor';
import {
  timerWorkflowNode,
  humanWorkflowNode,
  mapReduceWorkflowNode,
  subworkflowWorkflowNode,
  parallelSubworkflowsNode,
} from '../nodes/adapters';
import { delayNode } from '../timers/timer-node';
import { approvalNode } from '../human/human-node';
import { InMemoryApprovalStore } from '../human/approval-store';
import { mapReduceNode } from '../patterns/map-reduce';
import { subworkflowNode } from '../subworkflows/subworkflow-node';
import { fanOutFanIn } from '../subworkflows/parallel-subworkflows';

const cogitator = {} as Cogitator;

describe('timerWorkflowNode', () => {
  it('waits for the configured delay inside a workflow', async () => {
    const workflow = new WorkflowBuilder('timer')
      .addNode('wait', timerWorkflowNode(delayNode('wait', 20)))
      .build();

    const started = Date.now();
    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(result.nodeResults.get('wait')?.output).toMatchObject({ cancelled: false });
  });

  it('cancels the wait when the run is aborted', async () => {
    const controller = new AbortController();
    const workflow = new WorkflowBuilder('timer-abort')
      .addNode('wait', timerWorkflowNode(delayNode('wait', 10_000)))
      .build();

    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    const result = await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        signal: controller.signal,
      }
    );

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.nodeResults.get('wait')?.output).toMatchObject({ cancelled: true });
  });
});

describe('humanWorkflowNode', () => {
  it('pauses until the approval is answered and maps the decision into state', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const workflow = new WorkflowBuilder<{ approved?: boolean }>('approval')
      .initialState({})
      .addNode(
        'review',
        humanWorkflowNode(approvalNode('review', { title: 'Ship it?' }), {
          approvalStore,
          stateMapper: (result) => ({ approved: result.approved }),
        })
      )
      .build();

    const running = new WorkflowExecutor(cogitator).execute(workflow);

    let pending = await approvalStore.getPendingRequests();
    while (pending.length === 0) {
      await new Promise((r) => setTimeout(r, 2));
      pending = await approvalStore.getPendingRequests();
    }
    await approvalStore.submitResponse({
      requestId: pending[0].id,
      decision: true,
      respondedBy: 'lead',
      respondedAt: Date.now(),
    });

    const result = await running;
    expect(result.error).toBeUndefined();
    expect(result.state.approved).toBe(true);
    expect(result.nodeResults.get('review')?.output).toMatchObject({ approved: true });
  });

  it('outputs withdrawn when the request is deleted before anyone answers', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const workflow = new WorkflowBuilder('withdrawn')
      .addNode('review', humanWorkflowNode(approvalNode('review', { title: 'Ship it?' })))
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        approvalStore,
        onApprovalRequired: (request) => void approvalStore.deleteRequest(request.id),
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.nodeResults.get('review')?.output).toEqual({
      approved: false,
      decision: expect.anything(),
      timedOut: false,
      escalated: false,
      withdrawn: true,
    });
  });
});

describe('mapReduceWorkflowNode', () => {
  it('maps items in parallel and reduces them into state', async () => {
    const workflow = new WorkflowBuilder<{ numbers: number[]; total?: number }>('sum')
      .initialState({ numbers: [1, 2, 3, 4] })
      .addNode(
        'sum',
        mapReduceWorkflowNode(
          mapReduceNode<{ numbers: number[]; total?: number }, number, number>('sum', {
            map: {
              items: (state) => state.numbers,
              mapper: (item) => (item as number) * 10,
              concurrency: 2,
            },
            reduce: { initial: 0, reducer: (acc, item) => acc + item.result },
          }),
          { stateMapper: (result) => ({ total: result.reduced }) }
        )
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.state.total).toBe(100);
  });
});

describe('subworkflowWorkflowNode', () => {
  const child = new WorkflowBuilder<{ value: number }>('child')
    .initialState({ value: 0 })
    .addNode('double', async (ctx) => ({ state: { value: ctx.state.value * 2 } }))
    .build();

  it('runs a child workflow and maps its state back', async () => {
    const parent = new WorkflowBuilder<{ value: number; doubled?: number }>('parent')
      .initialState({ value: 21 })
      .addNode(
        'child',
        subworkflowWorkflowNode(
          subworkflowNode<{ value: number; doubled?: number }, { value: number }>('child', {
            workflow: child,
            inputMapper: (state) => ({ value: state.value }),
            outputMapper: (result, state) => ({ ...state, doubled: result.state.value }),
          })
        )
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(parent);

    expect(result.error).toBeUndefined();
    expect(result.state.doubled).toBe(42);
  });

  it('propagates child workflow failures', async () => {
    const failing = new WorkflowBuilder('failing')
      .addNode('boom', async () => {
        throw new Error('child exploded');
      })
      .build();

    const parent = new WorkflowBuilder('parent-fail')
      .addNode(
        'child',
        subworkflowWorkflowNode(
          subworkflowNode('child', {
            workflow: failing,
            inputMapper: () => ({}),
            outputMapper: (_result, state) => state,
          })
        )
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(parent);

    expect(result.error?.message).toContain('child exploded');
  });

  it("continues the parent with onError: 'catch' and outputs the caught error", async () => {
    const failing = new WorkflowBuilder('failing-caught')
      .addNode('boom', async () => {
        throw new Error('child exploded');
      })
      .build();
    const after: unknown[] = [];

    const parent = new WorkflowBuilder<{ value: number }>('parent-catch')
      .initialState({ value: 1 })
      .addNode(
        'child',
        subworkflowWorkflowNode(
          subworkflowNode<{ value: number }, WorkflowState>('child', {
            workflow: failing,
            inputMapper: () => ({}),
            outputMapper: (_result, state) => state,
            onError: 'catch',
          })
        )
      )
      .addNode(
        'after',
        async (ctx) => {
          after.push(ctx.input);
          return {};
        },
        { after: ['child'] }
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(parent);

    expect(result.error).toBeUndefined();
    expect(result.state.value).toBe(1);
    expect(after).toEqual([{ error: { name: 'Error', message: 'child exploded' } }]);
  });

  it('accepts parallel configs typed with the child state', async () => {
    interface ChildState extends WorkflowState {
      n: number;
    }
    const square = new WorkflowBuilder<ChildState>('square')
      .initialState({ n: 0 })
      .addNode('square', async (ctx) => ({ state: { n: ctx.state.n * ctx.state.n } }))
      .build();

    const parent = new WorkflowBuilder<{ total: number }>('fan')
      .initialState({ total: 0 })
      .addNode(
        'fan',
        parallelSubworkflowsNode(
          fanOutFanIn<{ total: number }, ChildState>('fan', {
            workflow: square,
            getInputs: () => [
              { id: 'a', input: { n: 2 } },
              { id: 'b', input: { n: 3 } },
            ],
            aggregator: (results, state) => ({
              ...state,
              total: [...results.values()].reduce((sum, r) => sum + r.state.n, 0),
            }),
          })
        )
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(parent);

    expect(result.state.total).toBe(13);
  });

  it('enforces maxDepth for recursive subworkflows', async () => {
    const recursive = new WorkflowBuilder('recursive').addNode('noop', async () => ({})).build();
    const nested = subworkflowNode('again', {
      workflow: recursive,
      inputMapper: () => ({}),
      outputMapper: (_result, state) => state,
      maxDepth: 2,
    });
    recursive.nodes.set('noop', { name: 'noop', fn: subworkflowWorkflowNode(nested).fn });

    const result = await new WorkflowExecutor(cogitator).execute(recursive);

    expect(result.error?.message).toContain('Maximum subworkflow depth exceeded');
  });
});
