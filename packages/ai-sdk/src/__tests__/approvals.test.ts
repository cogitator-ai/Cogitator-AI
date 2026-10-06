import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import * as ai5 from 'ai-v5';
import * as ai6 from 'ai-v6';
import * as ai7 from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { cogitatorModel, fromAISDKTool, toAISDKTool } from '../index';
import { approvalIdFor, parseApprovalId } from '../agent-runner';

const refundImpl = vi.fn(async ({ order }: { order: string }) => ({ refunded: order }));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});
const refundCall: ToolCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };

function answer(request: ChatRequest): ChatResponse {
  const results = request.messages.filter((m) => m.role === 'tool');
  if (results.length === 0) {
    return {
      id: 'r1',
      content: '',
      toolCalls: [refundCall],
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  }
  return {
    id: 'r2',
    content: `Result: ${results.map((m) => String(m.content)).join(' | ')}`,
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  };
}

const backend: LLMBackend = {
  provider: 'openai',
  chat: vi.fn(async (request: ChatRequest) => answer(request)),
  chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const response = answer(request);
    if (response.content) yield { id: response.id, delta: { content: response.content } };
    if (response.toolCalls) yield { id: response.id, delta: { toolCalls: response.toolCalls } };
    yield {
      id: response.id,
      delta: {},
      finishReason: response.finishReason,
      usage: response.usage,
    };
  }),
};

const clerk = new Agent({
  name: 'clerk',
  model: 'mock/m',
  instructions: 'Refund orders.',
  tools: [refund],
});

let cogitator: Cogitator;

beforeEach(() => {
  refundImpl.mockClear();
  cogitator = new Cogitator({ llm: { backends: { mock: backend } } });
});

afterEach(async () => {
  await cogitator.close();
});

describe('tool approval flags across the conversion', () => {
  it('fromAISDKTool keeps needsApproval as requiresApproval', () => {
    const always = fromAISDKTool(
      ai7.tool({
        description: 'Delete a file',
        inputSchema: z.object({ path: z.string() }),
        needsApproval: true,
        execute: async () => 'deleted',
      }),
      'delete_file'
    );
    const big = fromAISDKTool(
      ai7.tool({
        description: 'Pay',
        inputSchema: z.object({ amount: z.number() }),
        needsApproval: async () => false,
        execute: async () => 'paid',
      }),
      'pay'
    );
    const sync = fromAISDKTool({
      description: 'Pay',
      inputSchema: z.object({ amount: z.number() }),
      needsApproval: (input: unknown) => (input as { amount: number }).amount > 100,
      execute: async () => 'paid',
    });
    const plain = fromAISDKTool(
      ai7.tool({
        description: 'Read',
        inputSchema: z.object({}),
        execute: async () => 'read',
      }),
      'read'
    );

    expect(always.requiresApproval).toBe(true);
    expect(typeof big.requiresApproval).toBe('function');
    expect((big.requiresApproval as (a: Record<string, unknown>) => boolean)({ amount: 1 })).toBe(
      true
    );
    const check = sync.requiresApproval as (a: Record<string, unknown>) => boolean;
    expect(check({ amount: 500 })).toBe(true);
    expect(check({ amount: 5 })).toBe(false);
    expect(plain.requiresApproval).toBeUndefined();
  });

  it('a Cogitator run pauses before a tool that came from the AI SDK with needsApproval', async () => {
    const remove = vi.fn(async () => 'deleted');
    const deleteFile = fromAISDKTool(
      ai7.tool({
        description: 'Delete a file',
        inputSchema: z.object({ order: z.string() }),
        needsApproval: true,
        execute: remove,
      }),
      'refund'
    );
    const agent = clerk.clone({ tools: [deleteFile] });

    const result = await cogitator.run(agent, { input: 'Refund A-1' });

    expect(result.status).toBe('paused');
    expect(remove).not.toHaveBeenCalled();
  });

  it('toAISDKTool keeps requiresApproval as needsApproval', () => {
    const limited = tool({
      name: 'pay',
      description: 'Pay',
      parameters: z.object({ amount: z.number() }),
      requiresApproval: ({ amount }) => (amount as number) > 100,
      execute: async () => 'paid',
    });

    expect(toAISDKTool(refund).needsApproval).toBe(true);
    const check = toAISDKTool(limited).needsApproval as (input: unknown) => boolean;
    expect(check({ amount: 500 })).toBe(true);
    expect(check({ amount: 5 })).toBe(false);
    expect(toAISDKTool(tool({ ...limited, requiresApproval: undefined })).needsApproval).toBe(
      undefined
    );
  });

  it('ai@7 asks for approval before running a converted Cogitator tool', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          { type: 'tool-call', toolCallId: 't1', toolName: 'refund', input: '{"order":"A-1"}' },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    });

    const result = await ai7.generateText({
      model,
      prompt: 'Refund A-1',
      tools: { refund: toAISDKTool(refund) },
    });

    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.content.some((part) => part.type === 'tool-approval-request')).toBe(true);
  });
});

describe('agent models whose run pauses for approval', () => {
  it('ask for approval with tool-approval-request (ai@7, v4) and resume with the response', async () => {
    const model = cogitatorModel(cogitator, clerk, { specificationVersion: 'v4' });

    const paused = await ai7.generateText({ model, prompt: 'Refund A-1' });

    expect(refundImpl).not.toHaveBeenCalled();
    expect(paused.finishReason).toBe('tool-calls');
    const request = paused.content.find((part) => part.type === 'tool-approval-request');
    expect(request).toBeDefined();
    if (request?.type !== 'tool-approval-request') return;
    expect(request.toolCall.toolCallId).toBe('c1');
    expect(parseApprovalId(request.approvalId)).toEqual({
      threadId: paused.providerMetadata?.cogitator?.threadId,
      toolCallId: 'c1',
    });

    const done = await ai7.generateText({
      model,
      messages: [
        { role: 'user', content: 'Refund A-1' },
        ...paused.response.messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: request.approvalId,
              approved: true,
              providerExecuted: true,
            },
          ],
        },
      ],
    });

    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(done.finishReason).toBe('stop');
    expect(done.text).toContain('refunded');
  });

  it('decline when the user denies the approval (ai@6, v3)', async () => {
    const model = cogitatorModel(cogitator, clerk, { specificationVersion: 'v3' });

    const paused = await ai6.generateText({ model, prompt: 'Refund A-1' });
    const request = paused.content.find((part) => part.type === 'tool-approval-request');
    if (request?.type !== 'tool-approval-request') throw new Error('no approval request');

    const done = await ai6.generateText({
      model,
      messages: [
        { role: 'user', content: 'Refund A-1' },
        ...paused.response.messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: request.approvalId,
              approved: false,
              reason: 'fraud',
              providerExecuted: true,
            },
          ],
        },
      ],
    });

    expect(refundImpl).not.toHaveBeenCalled();
    expect(done.text).toContain('fraud');
  });

  it('stream the approval request (ai@7, v4)', async () => {
    const model = cogitatorModel(cogitator, clerk, { specificationVersion: 'v4' });

    const result = ai7.streamText({ model, prompt: 'Refund A-1' });
    const parts: string[] = [];
    for await (const part of result.fullStream) parts.push(part.type);

    expect(parts).toContain('tool-approval-request');
    expect(await result.finishReason).toBe('tool-calls');
    expect(refundImpl).not.toHaveBeenCalled();
  });

  it('report the pause with finishReason other and a warning where approvals are not supported (ai@5, v2)', async () => {
    const model = cogitatorModel(cogitator, clerk, { specificationVersion: 'v2' });

    const result = await ai5.generateText({ model, prompt: 'Refund A-1' });

    expect(result.finishReason).toBe('other');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'other', message: expect.stringContaining('paused') })
    );
    expect(result.providerMetadata?.cogitator).toMatchObject({
      status: 'paused',
      pendingApprovals: [expect.objectContaining({ toolCallId: 'c1', toolName: 'refund' })],
    });
    expect(refundImpl).not.toHaveBeenCalled();
  });
});

describe('approval ids', () => {
  it('round-trip thread and call ids with separators in them', () => {
    const id = approvalIdFor('thread:a/b', 'call:1');
    expect(parseApprovalId(id)).toEqual({ threadId: 'thread:a/b', toolCallId: 'call:1' });
    expect(parseApprovalId('other-provider-id')).toBeUndefined();
    expect(parseApprovalId('cogitator:only')).toBeUndefined();
  });
});
