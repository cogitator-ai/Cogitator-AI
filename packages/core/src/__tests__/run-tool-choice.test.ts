import { describe, it, expect, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolChoice,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

function lookupThenAnswer(seen: Array<ToolChoice | undefined>): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse => {
    seen.push(request.toolChoice);
    const answered = request.messages.some((m) => m.role === 'tool');
    return answered
      ? { id: 'r2', content: 'It is sunny.', finishReason: 'stop', usage }
      : {
          id: 'r1',
          content: '',
          toolCalls: [{ id: 'c1', name: 'weather', arguments: { city: 'Oslo' } }],
          finishReason: 'tool_calls',
          usage,
        };
  };
  return {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      const response = respond(request);
      if (response.content) yield { id: response.id, delta: { content: response.content } };
      yield {
        id: response.id,
        delta: { toolCalls: response.toolCalls },
        finishReason: response.finishReason,
        usage,
      };
    }),
  };
}

function weatherAgent() {
  const weather = tool({
    name: 'weather',
    description: 'Weather in a city',
    parameters: z.object({ city: z.string() }),
    execute: async () => 'sunny',
  });
  return new Agent({
    name: 'forecaster',
    model: 'scripted/m',
    instructions: 'x',
    tools: [weather],
  });
}

describe('RunOptions.toolChoice', () => {
  it.each([false, true])(
    'forces a tool call until the model makes one, then lets it answer (stream: %s)',
    async (stream) => {
      const seen: Array<ToolChoice | undefined> = [];
      const cog = new Cogitator({ llm: { backends: { scripted: lookupThenAnswer(seen) } } });

      const result = await cog.run(weatherAgent(), {
        input: 'Weather in Oslo?',
        toolChoice: 'required',
        ...(stream && { stream: true, onToken: () => undefined }),
      });

      expect(seen).toEqual(['required', undefined]);
      expect(result.output).toBe('It is sunny.');
      await cog.close();
    }
  );

  it('forces a named tool on the first turn', async () => {
    const seen: Array<ToolChoice | undefined> = [];
    const cog = new Cogitator({ llm: { backends: { scripted: lookupThenAnswer(seen) } } });
    const choice: ToolChoice = { type: 'function', function: { name: 'weather' } };

    await cog.run(weatherAgent(), { input: 'Weather in Oslo?', toolChoice: choice });

    expect(seen).toEqual([choice, undefined]);
    await cog.close();
  });

  it('keeps none on every turn', async () => {
    const seen: Array<ToolChoice | undefined> = [];
    const backend: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async (request: ChatRequest) => {
        seen.push(request.toolChoice);
        return { id: 'r', content: 'No tools needed.', finishReason: 'stop' as const, usage };
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
    const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

    await cog.run(weatherAgent(), { input: 'hi', toolChoice: 'none' });

    expect(seen).toEqual(['none']);
    await cog.close();
  });

  it('refuses to force a tool the agent does not have', async () => {
    const seen: Array<ToolChoice | undefined> = [];
    const cog = new Cogitator({ llm: { backends: { scripted: lookupThenAnswer(seen) } } });

    await expect(
      cog.run(weatherAgent(), {
        input: 'x',
        toolChoice: { type: 'function', function: { name: 'stocks' } },
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(seen).toEqual([]);
    await cog.close();
  });
});
