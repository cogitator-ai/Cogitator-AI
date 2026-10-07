import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import {
  InMemoryApprovalStore,
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
} from '@cogitator-ai/workflows';
import type { WorkflowState } from '@cogitator-ai/types';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

interface RefundState extends WorkflowState {
  answer?: string;
}

describeGoogle('Workflows: agent node tool approvals (Gemini)', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: 'google/gemini-2.5-flash',
        providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
      },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('asks the approval store before the refund runs, then answers with its result', async () => {
    const refund = vi.fn(async ({ order }: { order: string }) => ({ refunded: order, ok: true }));
    const clerk = new Agent({
      name: 'clerk',
      model: 'google/gemini-2.5-flash',
      instructions:
        'You process refunds. Always call the refund tool for the order the user names, then confirm in one sentence.',
      tools: [
        tool({
          name: 'refund',
          description: 'Refund an order by its id',
          parameters: z.object({ order: z.string() }),
          requiresApproval: true,
          execute: refund,
        }),
      ],
    });
    const store = new InMemoryApprovalStore();
    const asked: string[] = [];
    const workflow = new WorkflowBuilder<RefundState>('refunds')
      .initialState({})
      .addNode(
        'pay',
        agentNode<RefundState>(clerk, {
          inputMapper: () => 'Please refund order A-17.',
          stateMapper: (result) => ({ answer: result.output }),
        })
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow, undefined, {
      approvalStore: store,
      onApprovalRequired: (request) => {
        asked.push(request.title);
        void store.submitResponse({
          requestId: request.id,
          decision: true,
          respondedBy: 'manager',
          respondedAt: Date.now(),
        });
      },
    });

    expect(result.error).toBeUndefined();
    expect(asked).toEqual(['Allow clerk to call refund?']);
    expect(refund).toHaveBeenCalledWith({ order: 'A-17' }, expect.anything());
    expect(result.state.answer?.length).toBeGreaterThan(0);
  }, 60_000);
});
