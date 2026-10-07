import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AgentRunPausedError,
  Cogitator,
  findAgentRunPausedError,
  tool,
} from '@cogitator-ai/core';
import type {
  ApprovalRequest,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
  WorkflowState,
} from '@cogitator-ai/types';
import { WorkflowBuilder } from '../builder';
import { WorkflowExecutor } from '../executor';
import { agentNode } from '../nodes/agent';
import { InMemoryApprovalStore } from '../human/approval-store';

interface RefundState extends WorkflowState {
  answer?: string;
  notified?: string;
}

const refundImpl = vi.fn(async ({ order }: { order: string }) => ({ refunded: order }));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});
const refundCall: ToolCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };

function refundingBackend(): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse => {
    const results = request.messages.filter((m) => m.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'r1',
        content: 'Let me refund that.',
        toolCalls: [refundCall],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    return {
      id: 'r2',
      content: `Done: ${results.map((m) => String(m.content)).join(' | ')}`,
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    };
  };
  return {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

const agent = new Agent({
  name: 'clerk',
  model: 'mock/m',
  instructions: 'Refund orders.',
  tools: [refund],
});

let cogitator: Cogitator;
let backend: LLMBackend;
const notify = vi.fn(async (answer: string) => answer);

beforeEach(() => {
  refundImpl.mockClear();
  notify.mockClear();
  backend = refundingBackend();
  cogitator = new Cogitator({ llm: { backends: { mock: backend } } });
});

afterEach(async () => {
  await cogitator.close();
});

function refundWorkflow(options: Parameters<typeof agentNode<RefundState>>[1] = {}) {
  return new WorkflowBuilder<RefundState>('refunds')
    .initialState({})
    .addNode(
      'pay',
      agentNode<RefundState>(agent, {
        inputMapper: () => 'Refund A-1',
        stateMapper: (result) => ({ answer: result.output }),
        ...options,
      })
    )
    .addNode(
      'notify',
      async ({ state }) => ({ state: { notified: await notify(state.answer ?? '') } }),
      { after: ['pay'] }
    )
    .build();
}

async function answerFirstRequest(
  store: InMemoryApprovalStore,
  decision: boolean,
  comment?: string
): Promise<ApprovalRequest> {
  const request = await vi.waitFor(async () => {
    const [pending] = await store.getPendingRequests();
    if (!pending) throw new Error('no request yet');
    return pending;
  });
  await store.submitResponse({
    requestId: request.id,
    decision,
    respondedBy: 'manager',
    respondedAt: Date.now(),
    ...(comment && { comment }),
  });
  return request;
}

describe('agentNode with tool approvals', () => {
  it('asks the approval store, runs the approved call and passes the real answer on', async () => {
    const store = new InMemoryApprovalStore();
    const running = new WorkflowExecutor(cogitator).execute(refundWorkflow(), undefined, {
      approvalStore: store,
    });

    const request = await answerFirstRequest(store, true);
    const result = await running;

    expect(result.error).toBeUndefined();
    expect(request.type).toBe('approve-reject');
    expect(request.title).toBe('Allow clerk to call refund?');
    expect(request.description).toContain('{"order":"A-1"}');
    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(result.state.answer).toContain('"refunded":"A-1"');
    expect(notify).toHaveBeenCalledWith(result.state.answer);
  });

  it('declines a rejected call with the approver comment', async () => {
    const store = new InMemoryApprovalStore();
    const running = new WorkflowExecutor(cogitator).execute(
      refundWorkflow({ approvals: { assignee: 'manager' } }),
      undefined,
      { approvalStore: store }
    );

    const request = await answerFirstRequest(store, false, 'over the limit');
    const result = await running;

    expect(request.assignee).toBe('manager');
    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.state.answer).toContain('over the limit');
  });

  it('fails the node with AgentRunPausedError when there is no approval store', async () => {
    const result = await new WorkflowExecutor(cogitator).execute(refundWorkflow());

    const paused = findAgentRunPausedError(result.error);
    expect(paused).toBeInstanceOf(AgentRunPausedError);
    expect(paused?.message).toContain('paused in workflow');
    expect(paused?.checkpoint).toBeDefined();
    expect(refundImpl).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails with AgentRunPausedError when approvals are turned off, without retrying', async () => {
    const store = new InMemoryApprovalStore();
    const workflow = new WorkflowBuilder<RefundState>('refunds')
      .initialState({})
      .addNode(
        'pay',
        agentNode<RefundState>(agent, { inputMapper: () => 'Refund A-1', approvals: false }),
        { config: { retries: 2 } }
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow, undefined, {
      approvalStore: store,
    });

    expect(findAgentRunPausedError(result.error)).toBeInstanceOf(AgentRunPausedError);
    expect(await store.getPendingRequests()).toEqual([]);
    expect(backend.chat).toHaveBeenCalledTimes(1);
  });

  it('never runs a call that runOptions.onApproval declines', async () => {
    const result = await new WorkflowExecutor(cogitator).execute(
      refundWorkflow({ runOptions: { onApproval: () => ({ approved: false, reason: 'policy' }) } })
    );

    expect(result.error).toBeUndefined();
    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.state.answer).toContain('policy');
  });
});

describe('agentNode asks for each paused call on its own', () => {
  it('opens one request per call when a turn makes two identical calls', async () => {
    const twice: ToolCall[] = [
      { id: 'c1', name: 'refund', arguments: { order: 'A-1' } },
      { id: 'c2', name: 'refund', arguments: { order: 'A-1' } },
    ];
    const chat = vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      const results = request.messages.filter((m) => m.role === 'tool');
      return results.length === 0
        ? {
            id: 'r1',
            content: 'Refunding twice.',
            toolCalls: twice,
            finishReason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
        : {
            id: 'r2',
            content: 'Done.',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
    });
    await cogitator.close();
    cogitator = new Cogitator({
      llm: {
        backends: {
          mock: {
            provider: 'openai',
            chat,
            chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
              yield { id: 's', delta: {}, finishReason: 'stop' };
            }),
          },
        },
      },
    });
    const store = new InMemoryApprovalStore();
    const running = new WorkflowExecutor(cogitator).execute(refundWorkflow(), undefined, {
      approvalStore: store,
    });

    const pending = await vi.waitFor(async () => {
      const requests = await store.getPendingRequests();
      if (requests.length < 2) throw new Error('waiting for both requests');
      return requests;
    });
    expect(new Set(pending.map((request) => request.id)).size).toBe(2);
    await store.submitResponse({
      requestId: pending[0].id,
      decision: true,
      respondedBy: 'manager',
      respondedAt: Date.now(),
    });
    await store.submitResponse({
      requestId: pending[1].id,
      decision: false,
      comment: 'only once',
      respondedBy: 'manager',
      respondedAt: Date.now(),
    });
    const result = await running;

    expect(result.error).toBeUndefined();
    expect(refundImpl).toHaveBeenCalledTimes(1);
  });
});
