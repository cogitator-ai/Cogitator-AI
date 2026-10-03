import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { findHandoffAgent } from '../cogitator/handoffs';

const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: async ({ order }) => ({ refunded: order }),
});
const faq = tool({
  name: 'faq',
  description: 'Search the FAQ',
  parameters: z.object({ q: z.string() }),
  execute: async () => 'see the FAQ',
});

const billing = new Agent({
  name: 'billing',
  description: 'Handles refunds and invoices',
  model: 'mock/billing-model',
  instructions: 'You are billing.',
  tools: [refund],
});
const triage = new Agent({
  name: 'triage',
  model: 'mock/triage-model',
  instructions: 'You are triage.',
  tools: [faq],
  handoffs: [billing],
});

/** Triage hands over; billing refunds when asked to and then answers. */
function scriptedBackend(billingRefunds = false) {
  const requests: ChatRequest[] = [];
  const respond = (request: ChatRequest): ChatResponse => {
    requests.push({ ...request, messages: [...request.messages] });
    const system = String(request.messages[0].content);
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    if (system.startsWith('You are triage.')) {
      return {
        id: 't',
        content: '',
        toolCalls: [
          { id: 'h1', name: 'transfer_to_billing', arguments: { reason: 'refund request' } },
        ],
        finishReason: 'tool_calls',
        usage,
      };
    }
    const refunded = request.messages.some((m) => m.role === 'tool' && m.name === 'refund');
    if (billingRefunds && !refunded) {
      return {
        id: 'b',
        content: '',
        toolCalls: [{ id: 'r1', name: 'refund', arguments: { order: 'A-1' } }],
        finishReason: 'tool_calls',
        usage,
      };
    }
    return { id: 'b', content: 'billing here', finishReason: 'stop', usage };
  };
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, requests };
}

describe('handoffs', () => {
  it('goes on as the agent the conversation was handed to', async () => {
    const { backend, requests } = scriptedBackend();
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const onHandoff = vi.fn();

    const result = await cog.run(triage, { input: 'I want my money back', onHandoff });

    expect(result.output).toBe('billing here');
    expect(result.handoffs).toEqual([{ from: 'triage', to: 'billing', reason: 'refund request' }]);
    expect(result.finalAgent).toBe('billing');
    expect(onHandoff).toHaveBeenCalledWith(result.handoffs![0]);
    expect(requests[0].model).toBe('triage-model');
    expect(requests[0].tools?.map((t) => t.name)).toEqual(['faq', 'transfer_to_billing']);
    expect(requests[1].model).toBe('billing-model');
    expect(requests[1].tools?.map((t) => t.name)).toEqual(['refund']);
    expect(requests[1].messages[0]).toEqual({ role: 'system', content: 'You are billing.' });
    expect(requests[1].messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(result.trace.spans.some((span) => span.name === 'agent.handoff')).toBe(true);
    await cog.close();
  });

  it('describes the handoff tool from the target agent, or as configured', () => {
    const { backend, requests } = scriptedBackend();
    const custom = triage.clone({
      handoffs: [{ agent: billing, toolName: 'ask_billing', description: 'Money questions' }],
    });
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    return cog.run(custom, { input: 'refund' }).then(async () => {
      const handoffTool = requests[0].tools?.find((t) => t.name === 'ask_billing');
      expect(handoffTool?.description).toBe('Money questions');
      await cog.close();
    });
  });

  it('resumes a run that paused after a handoff in the agent it was handed to', async () => {
    const { backend } = scriptedBackend(true);
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    const paused = await cog.run(triage, { input: 'refund A-1' });
    expect(paused.status).toBe('paused');
    expect(paused.checkpoint?.activeAgent).toBe('billing');

    const done = await cog.resume(triage, paused.checkpoint!, {
      decisions: { r1: { approved: true } },
    });

    expect(done.output).toBe('billing here');
    expect(done.finalAgent).toBe('billing');
    expect(done.handoffs).toEqual(paused.handoffs);
    await cog.close();
  });

  it('finds agents across handoff cycles', () => {
    const a = new Agent({ name: 'a', instructions: 'a' });
    const b = new Agent({ name: 'b', instructions: 'b', handoffs: [a] });
    const entry = a.clone({ id: a.id, handoffs: [b] });

    expect(findHandoffAgent(entry, 'b')).toBe(b);
    expect(findHandoffAgent(entry, 'missing')).toBeUndefined();
  });
});
