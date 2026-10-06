import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import type { ApprovalRequest, NodeContext, WorkflowState } from '@cogitator-ai/types';
import { WorkflowBuilder } from '../builder';
import { WorkflowExecutor } from '../executor';
import { toolNode } from '../nodes/tool';
import { InMemoryApprovalStore } from '../human/approval-store';

interface PayState extends WorkflowState {
  order: string;
  receipt?: string;
}

const refundImpl = vi.fn(async ({ order }: { order: string }) => `refunded ${order}`);
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});

const lookupImpl = vi.fn(async ({ order }: { order: string }) => `found ${order}`);
const lookup = tool({
  name: 'lookup',
  description: 'Look an order up',
  parameters: z.object({ order: z.string().min(3) }),
  execute: lookupImpl,
});

function refundWorkflow() {
  return new WorkflowBuilder<PayState>('refunds')
    .initialState({ order: 'A-1' })
    .addNode(
      'refund',
      toolNode<PayState, { order: string }>(refund, {
        argsMapper: (state) => ({ order: state.order }),
        stateMapper: (result) => ({ receipt: result as string }),
      })
    )
    .build();
}

let cogitator: Cogitator;

beforeEach(() => {
  refundImpl.mockClear();
  lookupImpl.mockClear();
  cogitator = new Cogitator();
});

describe('toolNode runs its tool the way an agent run does', () => {
  it('does not run a tool that needs approval when nobody can approve it', async () => {
    const result = await new WorkflowExecutor(cogitator).execute(refundWorkflow());

    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.error?.message).toMatch(/refund.*needs approval/);
  });

  it('asks the approval store and runs the tool once the call is approved', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const requests: ApprovalRequest[] = [];
    const executor = new WorkflowExecutor(cogitator);
    const run = executor.execute(refundWorkflow(), undefined, {
      approvalStore,
      onApprovalRequired: (request) => {
        requests.push(request);
        void approvalStore.submitResponse({
          requestId: request.id,
          decision: true,
          respondedBy: 'manager',
          respondedAt: Date.now(),
        });
      },
    });

    const result = await run;
    expect(result.error).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].title).toContain('refund');
    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(result.state.receipt).toBe('refunded A-1');
  });

  it('fails the node without running the tool when the call is declined', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const result = await new WorkflowExecutor(cogitator).execute(refundWorkflow(), undefined, {
      approvalStore,
      onApprovalRequired: (request) => {
        void approvalStore.submitResponse({
          requestId: request.id,
          decision: false,
          comment: 'not this one',
          respondedBy: 'manager',
          respondedAt: Date.now(),
        });
      },
    });

    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.error?.message).toMatch(/declined.*not this one/);
  });

  it('validates the mapped arguments against the tool schema', async () => {
    const node = toolNode<PayState, { order: string }>(lookup, {
      argsMapper: () => ({ order: 'x' }),
    });
    const ctx = {
      state: { order: 'x' },
      nodeId: 'lookup',
      workflowId: 'wf-1',
      step: 0,
      cogitator,
    } as NodeContext<PayState>;

    await expect(node.fn(ctx)).rejects.toThrow(/lookup/);
    expect(lookupImpl).not.toHaveBeenCalled();
  });

  it('keeps the tool timeout', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Takes too long',
      parameters: z.object({}),
      timeout: 20,
      execute: async (_args, ctx) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve('late'), 1000);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    });
    const node = toolNode<PayState, Record<string, never>>(slow, { argsMapper: () => ({}) });
    const ctx = {
      state: { order: 'A-1' },
      nodeId: 'slow',
      workflowId: 'wf-1',
      step: 0,
      cogitator,
    } as NodeContext<PayState>;

    await expect(node.fn(ctx)).rejects.toThrow(/slow/);
  });

  it('needs a Cogitator in the node context', async () => {
    const node = toolNode<PayState, { order: string }>(lookup, {
      argsMapper: () => ({ order: 'A-100' }),
    });
    const ctx: NodeContext<PayState> = {
      state: { order: 'A-100' },
      nodeId: 'lookup',
      workflowId: 'wf-1',
      step: 0,
    };

    await expect(node.fn(ctx)).rejects.toThrow(/requires a Cogitator/);
    expect(lookupImpl).not.toHaveBeenCalled();
  });
});
