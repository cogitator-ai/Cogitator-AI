import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { getLogger } from '../logger';

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

function callsLookup(): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse =>
    request.messages.some((m) => m.role === 'tool')
      ? { id: 'r2', content: 'done', finishReason: 'stop', usage }
      : {
          id: 'r1',
          content: '',
          toolCalls: [{ id: 'c1', name: 'lookup', arguments: {} }],
          finishReason: 'tool_calls',
          usage,
        };
  return {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

const lookup = (answer: string) =>
  tool({
    name: 'lookup',
    description: 'Look something up',
    parameters: z.object({}),
    execute: async () => answer,
  });

const replacementWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter(([message]) => String(message).includes('replaces another tool'));

describe('the tools of a run', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lets an agent tool stand in for a global tool of the same name, without a warning', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({ llm: { backends: { scripted: callsLookup() } } });
    cog.tools.register(lookup('global'));
    const agent = new Agent({
      name: 'a',
      model: 'scripted/m',
      instructions: 'x',
      tools: [lookup('own')],
    });

    const result = await cog.run(agent, { input: 'go' });

    expect(result.toolCalls).toHaveLength(1);
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('"own"');
    expect(replacementWarnings(warn)).toHaveLength(0);
    await cog.close();
  });

  it('warns when an agent has two different tools of one name', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({ llm: { backends: { scripted: callsLookup() } } });
    const agent = new Agent({
      name: 'a',
      model: 'scripted/m',
      instructions: 'x',
      tools: [lookup('first'), lookup('second')],
    });

    await cog.run(agent, { input: 'go' });

    expect(replacementWarnings(warn).length).toBeGreaterThan(0);
    await cog.close();
  });
});
