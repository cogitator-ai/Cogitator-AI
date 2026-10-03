import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

type Turn = Pick<ChatResponse, 'content' | 'finishReason'> & { toolCalls?: ToolCall[] };

const text = (content: string): Turn => ({ content, finishReason: 'stop' });
const empty = (finishReason: ChatResponse['finishReason'] = 'stop'): Turn => ({
  content: '',
  finishReason,
});

function scripted(...turns: Turn[]) {
  const requests: ChatRequest[] = [];
  const next = () => turns[Math.min(requests.length - 1, turns.length - 1)];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push({ ...request, messages: [...request.messages] });
      return { id: `r${requests.length}`, usage, ...next() };
    }),
    chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      requests.push({ ...request, messages: [...request.messages] });
      const turn = next();
      if (turn.content) yield { id: 's', delta: { content: turn.content } };
      yield { id: 's', delta: {}, finishReason: turn.finishReason, usage };
    }),
  };
  return { backend, requests };
}

const lookupWeather = tool({
  name: 'lookup_weather',
  description: 'Current weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, celsius: 18 }),
});

const Weather = z.object({ city: z.string(), celsius: z.number() });

describe('empty answers', () => {
  it('asks again after a tool turn and never puts the empty turn in the history', async () => {
    const { backend, requests } = scripted(
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'lookup_weather', arguments: { city: 'Lisbon' } }],
      },
      empty(),
      text('{"city":"Lisbon","celsius":18}')
    );
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
    });
    const agent = new Agent({
      name: 'weather',
      model: 'mock/m',
      instructions: 'Use the tool, then report the weather.',
      tools: [lookupWeather],
      responseFormat: { type: 'json_schema', schema: Weather },
    });

    const result = await cog.run(agent, { input: 'Lisbon?', threadId: 't-empty' });

    expect(result.structured).toEqual({ city: 'Lisbon', celsius: 18 });
    expect(requests).toHaveLength(3);
    expect(requests[2].messages).toEqual(requests[1].messages);

    const history = await cog.memory!.getEntries({ threadId: 't-empty' });
    if (!history.success) throw new Error(history.error);
    expect(history.data.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(history.data.at(-1)?.message.content).toBe('{"city":"Lisbon","celsius":18}');
    await cog.close();
  });

  it('retries twice at most and then returns what the model gave', async () => {
    const { backend, requests } = scripted(empty());
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = new Agent({ name: 'quiet', model: 'mock/m', instructions: 'Answer.' });

    const result = await cog.run(agent, { input: 'Hello?' });

    expect(requests).toHaveLength(3);
    expect(result.output).toBe('');
    await cog.close();
  });

  it('keeps the answer when a retry produces one', async () => {
    const { backend, requests } = scripted(empty(), empty(), text('Hello!'));
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = new Agent({ name: 'greeter', model: 'mock/m', instructions: 'Greet.' });

    const result = await cog.run(agent, { input: 'Hi' });

    expect(result.output).toBe('Hello!');
    expect(requests).toHaveLength(3);
    await cog.close();
  });

  it('does not retry a turn cut off by the token limit', async () => {
    const { backend, requests } = scripted(empty('length'));
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = new Agent({ name: 'long', model: 'mock/m', instructions: 'Answer.' });

    await cog.run(agent, { input: 'Write a novel' });

    expect(requests).toHaveLength(1);
    await cog.close();
  });

  it('does not exceed maxIterations while retrying', async () => {
    const { backend, requests } = scripted(empty());
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = new Agent({
      name: 'bounded',
      model: 'mock/m',
      instructions: 'Answer.',
      maxIterations: 2,
    });

    await cog.run(agent, { input: 'Hi' });

    expect(requests).toHaveLength(2);
    await cog.close();
  });

  it('asks again when a streamed turn comes back empty', async () => {
    const { backend, requests } = scripted(empty(), text('Streamed answer'));
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = new Agent({ name: 'streamer', model: 'mock/m', instructions: 'Answer.' });
    const tokens: string[] = [];

    const result = await cog.run(agent, {
      input: 'Hi',
      stream: true,
      onToken: (token) => tokens.push(token),
    });

    expect(result.output).toBe('Streamed answer');
    expect(tokens.join('')).toBe('Streamed answer');
    expect(requests).toHaveLength(2);
    await cog.close();
  });
});
