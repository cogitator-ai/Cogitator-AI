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

const lookup = (id: string, city = `City ${id}`): Turn => ({
  content: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name: 'lookup_weather', arguments: { city } }],
});
const text = (content: string): Turn => ({ content, finishReason: 'stop' });

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
      if (turn.toolCalls) yield { id: 's', delta: { toolCalls: turn.toolCalls } };
      yield { id: 's', delta: {}, finishReason: turn.finishReason, usage };
    }),
  };
  return { backend, requests };
}

function weatherTool() {
  const execute = vi.fn(async ({ city }: { city: string }) => ({ city, celsius: 18 }));
  return {
    execute,
    tool: tool({
      name: 'lookup_weather',
      description: 'Current weather for a city',
      parameters: z.object({ city: z.string() }),
      execute,
    }),
  };
}

const Weather = z.object({ city: z.string(), celsius: z.number() });

function agentWith(
  weather: ReturnType<typeof weatherTool>,
  extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}
) {
  return new Agent({
    name: 'weather',
    model: 'mock/m',
    instructions: 'Use the tool, then report the weather.',
    tools: [weather.tool],
    responseFormat: { type: 'json_schema', schema: Weather },
    maxIterations: 2,
    ...extra,
  });
}

describe('the iteration limit', () => {
  it('asks for an answer without tools when tool calls use up the iterations', async () => {
    const { backend, requests } = scripted(
      lookup('c1'),
      lookup('c2'),
      text('{"city":"Lisbon","celsius":18}')
    );
    const weather = weatherTool();
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    const result = await cog.run(agentWith(weather), { input: 'Lisbon?' });

    expect(weather.execute).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(3);
    expect(requests[0].toolChoice).toBeUndefined();
    expect(requests[2].toolChoice).toBe('none');
    expect(requests[2].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Do not call any more tools'),
    });
    expect(result.structured).toEqual({ city: 'Lisbon', celsius: 18 });
    expect(result.iterationLimitReached).toBe(true);
  });

  it('ends at the last tool turn with onIterationLimit stop', async () => {
    const { backend, requests } = scripted(lookup('c1'), lookup('c2'), text('{}'));
    const weather = weatherTool();
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    const result = await cog.run(agentWith(weather, { onIterationLimit: 'stop' }), {
      input: 'Lisbon?',
    });

    expect(requests).toHaveLength(2);
    expect(result.structured).toBeUndefined();
    expect(result.iterationLimitReached).toBe(true);
  });

  it('never runs tools the model asks for on the closing turn', async () => {
    const { backend } = scripted(lookup('c1'), lookup('c2'), {
      ...lookup('c3'),
      content: '{"city":"Lisbon","celsius":18}',
    });
    const weather = weatherTool();
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    const result = await cog.run(agentWith(weather), { input: 'Lisbon?' });

    expect(weather.execute).toHaveBeenCalledTimes(2);
    expect(result.structured).toEqual({ city: 'Lisbon', celsius: 18 });
    const last = result.messages.at(-1) as { role: string; toolCalls?: unknown };
    expect(last.role).toBe('assistant');
    expect(last.toolCalls).toBeUndefined();
  });

  it('closes a streamed run the same way', async () => {
    const { backend, requests } = scripted(
      lookup('c1'),
      lookup('c2'),
      text('{"city":"Lisbon","celsius":18}')
    );
    const weather = weatherTool();
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const tokens: string[] = [];

    const result = await cog.run(agentWith(weather), {
      input: 'Lisbon?',
      stream: true,
      onToken: (token) => tokens.push(token),
    });

    expect(backend.chatStream).toHaveBeenCalledTimes(3);
    expect(requests[2].toolChoice).toBe('none');
    expect(tokens.join('')).toBe('{"city":"Lisbon","celsius":18}');
    expect(result.iterationLimitReached).toBe(true);
  });

  it('leaves a run that answers within the limit alone', async () => {
    const { backend, requests } = scripted(lookup('c1'), text('{"city":"Lisbon","celsius":18}'));
    const weather = weatherTool();
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    const result = await cog.run(agentWith(weather), { input: 'Lisbon?' });

    expect(requests).toHaveLength(2);
    expect(result.iterationLimitReached).toBeUndefined();
    expect(result.structured).toEqual({ city: 'Lisbon', celsius: 18 });
  });

  it('closes a run whose last allowed tool call waited for approval', async () => {
    const { backend, requests } = scripted(
      lookup('c1', 'Lisbon'),
      text('{"city":"Lisbon","celsius":18}')
    );
    const execute = vi.fn(async ({ city }: { city: string }) => ({ city, celsius: 18 }));
    const guarded = tool({
      name: 'lookup_weather',
      description: 'Current weather for a city',
      parameters: z.object({ city: z.string() }),
      requiresApproval: true,
      execute,
    });
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = new Agent({
      name: 'weather',
      model: 'mock/m',
      instructions: 'Use the tool, then report the weather.',
      tools: [guarded],
      responseFormat: { type: 'json_schema', schema: Weather },
      maxIterations: 1,
    });

    const paused = await cog.run(agent, { input: 'Lisbon?' });
    expect(paused.status).toBe('paused');
    if (!paused.checkpoint) throw new Error('The paused run has no checkpoint');

    const result = await cog.resume(agent, paused.checkpoint, {
      decisions: { c1: { approved: true } },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].toolChoice).toBe('none');
    expect(result.status).toBe('completed');
    expect(result.structured).toEqual({ city: 'Lisbon', celsius: 18 });
    expect(result.iterationLimitReached).toBe(true);
  });

  it('keeps onIterationLimit through serialize and deserialize', () => {
    const weather = weatherTool();
    const snapshot = agentWith(weather, { onIterationLimit: 'stop' }).serialize();
    expect(snapshot.config.onIterationLimit).toBe('stop');
    const restored = Agent.deserialize(snapshot, {
      tools: [weather.tool],
      overrides: { responseFormat: { type: 'json_schema', schema: Weather } },
    });
    expect(restored.config.onIterationLimit).toBe('stop');
  });
});
