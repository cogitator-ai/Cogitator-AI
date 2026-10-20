import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import type { ToolContext, ToolInvoker } from '@cogitator-ai/types';
import * as ai5 from 'ai-v5';
import * as ai6 from 'ai-v6';
import * as ai7 from 'ai';
import { MockLanguageModelV2 } from 'ai-v5/test';
import { MockLanguageModelV3 } from 'ai-v6/test';
import { MockLanguageModelV4 } from 'ai/test';
import { convertToolsToAISDK, toAISDKTool } from '../index';

const refundImpl = vi.fn(async ({ order }: { order: string }, _context: ToolContext) => ({
  refunded: order,
}));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});

const usageV2 = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const usageV3 = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that calls `toolName` with `input` first and answers with text after a tool result. */
function scriptedV2(toolName: string, input: unknown) {
  let step = 0;
  return new MockLanguageModelV2({
    doGenerate: async () =>
      step++ === 0
        ? {
            content: [
              { type: 'tool-call', toolCallId: 'tc1', toolName, input: JSON.stringify(input) },
            ],
            finishReason: 'tool-calls',
            usage: usageV2,
            warnings: [],
          }
        : {
            content: [{ type: 'text', text: 'done' }],
            finishReason: 'stop',
            usage: usageV2,
            warnings: [],
          },
  });
}

function toolCallV3(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'tc1',
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: usageV3,
    warnings: [],
  };
}

const textV3 = {
  content: [{ type: 'text' as const, text: 'done' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: usageV3,
  warnings: [],
};

let cogitator: Cogitator;

beforeEach(() => {
  refundImpl.mockClear();
  cogitator = new Cogitator();
});

afterEach(async () => {
  await cogitator.close();
});

describe('toAISDKTool with an invoker', () => {
  it('runs a call the ai@7 approval flow approved, without asking again', async () => {
    const onApproval = vi.fn(async () => ({ approved: false as const }));
    const tools = { refund: toAISDKTool(refund, { invoker: cogitator, onApproval }) };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) =>
        options.prompt.some((message) => message.role === 'tool')
          ? textV3
          : toolCallV3('refund', { order: 'A-1' }),
    });

    const paused = await ai7.generateText({ model, prompt: 'Refund A-1', tools });
    const request = paused.content.find((part) => part.type === 'tool-approval-request');
    if (request?.type !== 'tool-approval-request') throw new Error('no approval request');
    expect(refundImpl).not.toHaveBeenCalled();

    await ai7.generateText({
      model,
      tools,
      messages: [
        { role: 'user', content: 'Refund A-1' },
        ...paused.response.messages,
        {
          role: 'tool',
          content: [
            { type: 'tool-approval-response', approvalId: request.approvalId, approved: true },
          ],
        },
      ],
    });

    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(onApproval).not.toHaveBeenCalled();
  });

  it('runs a call the ai@6 approval flow approved', async () => {
    const tools = { refund: toAISDKTool(refund, { invoker: cogitator }) };
    const model = new MockLanguageModelV3({
      doGenerate: async (options) =>
        options.prompt.some((message) => message.role === 'tool')
          ? textV3
          : toolCallV3('refund', { order: 'A-2' }),
    });

    const paused = await ai6.generateText({ model, prompt: 'Refund A-2', tools });
    const request = paused.content.find((part) => part.type === 'tool-approval-request');
    if (request?.type !== 'tool-approval-request') throw new Error('no approval request');

    await ai6.generateText({
      model,
      tools,
      messages: [
        { role: 'user', content: 'Refund A-2' },
        ...paused.response.messages,
        {
          role: 'tool',
          content: [
            { type: 'tool-approval-response', approvalId: request.approvalId, approved: true },
          ],
        },
      ],
    });

    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(refundImpl.mock.calls[0]![0]).toEqual({ order: 'A-2' });
  });

  it('refuses a call on ai@5, which never asks, when nobody approves it', async () => {
    const result = await ai5.generateText({
      model: scriptedV2('refund', { order: 'A-3' }),
      tools: { refund: toAISDKTool(refund, { invoker: cogitator }) },
      stopWhen: ai5.stepCountIs(2),
      prompt: 'Refund A-3',
    });

    expect(refundImpl).not.toHaveBeenCalled();
    const error = result.steps[0]!.content.find((part) => part.type === 'tool-error');
    expect(error?.type === 'tool-error' && String(error.error)).toContain(
      'Tool "refund" needs approval, and nobody approved this call'
    );
  });

  it('asks onApproval for a call the AI SDK did not approve', async () => {
    const onApproval = vi.fn(async () => ({ approved: true as const }));
    const result = await ai5.generateText({
      model: scriptedV2('refund', { order: 'A-4' }),
      tools: convertToolsToAISDK([refund], { invoker: cogitator, onApproval }),
      stopWhen: ai5.stepCountIs(2),
      prompt: 'Refund A-4',
    });

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tc1',
        toolName: 'refund',
        arguments: { order: 'A-4' },
      })
    );
    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(result.steps[0]!.toolResults[0]!.output).toEqual({ refunded: 'A-4' });
  });

  it('passes the reason of a declined call to the model', async () => {
    const result = await ai5.generateText({
      model: scriptedV2('refund', { order: 'A-5' }),
      tools: {
        refund: toAISDKTool(refund, {
          invoker: cogitator,
          onApproval: async () => ({ approved: false, reason: 'fraud' }),
        }),
      },
      stopWhen: ai5.stepCountIs(2),
      prompt: 'Refund A-5',
    });

    expect(refundImpl).not.toHaveBeenCalled();
    const error = result.steps[0]!.content.find((part) => part.type === 'tool-error');
    expect(error?.type === 'tool-error' && String(error.error)).toContain(
      'The user declined this tool call: fraud'
    );
  });

  it('lets the guardrails decide when no onApproval is given', async () => {
    const onToolApproval = vi.fn(async (_toolName: string) => true);
    const guarded = new Cogitator({ guardrails: { enabled: true, onToolApproval } });
    try {
      await ai5.generateText({
        model: scriptedV2('refund', { order: 'A-6' }),
        tools: { refund: toAISDKTool(refund, { invoker: guarded }) },
        stopWhen: ai5.stepCountIs(2),
        prompt: 'Refund A-6',
      });
    } finally {
      await guarded.close();
    }

    expect(onToolApproval).toHaveBeenCalledTimes(1);
    expect(onToolApproval.mock.calls[0]![0]).toBe('refund');
    expect(refundImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the tool timeout', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Slow tool',
      parameters: z.object({}),
      timeout: 20,
      execute: () => new Promise<string>(() => {}),
    });

    const result = await ai5.generateText({
      model: scriptedV2('slow', {}),
      tools: { slow: toAISDKTool(slow, { invoker: cogitator }) },
      stopWhen: ai5.stepCountIs(2),
      prompt: 'go',
    });

    const error = result.steps[0]!.content.find((part) => part.type === 'tool-error');
    expect(error?.type === 'tool-error' && String(error.error)).toContain(
      'Tool "slow" timed out after 20ms'
    );
  });

  it('applies the schema transforms once, as the AI SDK parsed the arguments', async () => {
    const double = vi.fn(async ({ count }: { count: number }) => count * 2);
    const doubler = tool({
      name: 'double',
      description: 'Double a number',
      parameters: z.object({ count: z.string().transform((value) => Number(value)) }),
      execute: double,
    });

    const result = await ai5.generateText({
      model: scriptedV2('double', { count: '21' }),
      tools: { double: toAISDKTool(doubler, { invoker: cogitator }) },
      stopWhen: ai5.stepCountIs(2),
      prompt: 'double 21',
    });

    expect(double).toHaveBeenCalledWith({ count: 21 }, expect.anything());
    expect(result.steps[0]!.toolResults[0]!.output).toBe(42);
  });

  it('hands the invoker the call id, signal and the AI SDK context', async () => {
    const invokeTool = vi.fn<ToolInvoker['invokeTool']>(async (t) => ({
      callId: 'tc1',
      name: t.name,
      result: 'ok',
    }));
    const lookup = tool({
      name: 'lookup',
      description: 'Look something up',
      parameters: z.object({ q: z.string() }),
      execute: async () => 'unused',
    });
    const controller = new AbortController();

    await expect(
      toAISDKTool(lookup, { invoker: { invokeTool } }).execute(
        { q: 'x' },
        {
          toolCallId: 'tc1',
          messages: [],
          abortSignal: controller.signal,
          context: { agentId: 'web', runId: 'run-9', threadId: 't-1', userId: 'u-1' },
        }
      )
    ).resolves.toBe('ok');

    expect(invokeTool.mock.calls[0]![2]).toEqual({
      toolCallId: 'tc1',
      runId: 'run-9',
      agentId: 'web',
      signal: controller.signal,
      threadId: 't-1',
      userId: 'u-1',
    });
  });

  it('does not take an approval of another call, or a denial, as approving this one', async () => {
    const invokeTool = vi.fn<ToolInvoker['invokeTool']>(async (t) => ({
      callId: 'tc1',
      name: t.name,
      result: 'ok',
    }));
    const onApproval = vi.fn();
    const converted = toAISDKTool(refund, { invoker: { invokeTool }, onApproval });
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'other' },
          { type: 'tool-approval-request', approvalId: 'a2', toolCallId: 'tc1' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'a1', approved: true },
          { type: 'tool-approval-response', approvalId: 'a2', approved: false },
        ],
      },
    ];

    await converted.execute({ order: 'A-7' }, { toolCallId: 'tc1', messages });

    expect(invokeTool.mock.calls[0]![2]?.onApproval).toBe(onApproval);
  });
});

describe('toAISDKTool without an invoker', () => {
  it('lets the AI SDK call execute directly, as before', async () => {
    const result = await ai5.generateText({
      model: scriptedV2('refund', { order: 'B-1' }),
      tools: { refund: toAISDKTool(refund) },
      stopWhen: ai5.stepCountIs(2),
      prompt: 'Refund B-1',
    });

    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(result.steps[0]!.toolResults[0]!.output).toEqual({ refunded: 'B-1' });
  });
});
