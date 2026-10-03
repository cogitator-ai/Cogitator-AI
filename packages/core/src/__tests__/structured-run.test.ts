import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { parseStructuredOutput, toLLMResponseFormat } from '../cogitator/response-format';

vi.mock('../llm/index', async (importOriginal) => {
  const original = await importOriginal<typeof import('../llm/index')>();
  return { ...original, createLLMBackend: vi.fn() };
});

const Weather = z.object({ city: z.string(), celsius: z.number() });

function backendAnswering(content: string) {
  const requests: ChatRequest[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      return {
        id: 'r',
        content,
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }),
    chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      requests.push(request);
      yield {
        id: 's',
        delta: { content },
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }),
  };
  return { backend, requests };
}

describe('structured output in runs', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function useBackend(backend: LLMBackend) {
    const { createLLMBackend } = await import('../llm/index');
    vi.mocked(createLLMBackend).mockReturnValue(backend);
  }

  const weatherAgent = () =>
    new Agent({
      name: 'weather',
      model: 'openai/gpt-6-luna',
      instructions: 'Answer with the weather.',
      responseFormat: { type: 'json_schema', schema: Weather },
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the schema to the backend and returns the parsed object', async () => {
    const { backend, requests } = backendAnswering('{"city":"Oslo","celsius":4}');
    await useBackend(backend);
    const cog = new Cogitator();

    const result = await cog.run(weatherAgent(), { input: 'Oslo?' });

    expect(requests[0].responseFormat).toMatchObject({
      type: 'json_schema',
      jsonSchema: {
        name: 'response',
        strict: true,
        schema: { type: 'object', required: ['city', 'celsius'] },
      },
    });
    expect(result.structured).toEqual({ city: 'Oslo', celsius: 4 });
    await cog.close();
  });

  it('sends the format on the streaming path too', async () => {
    const { backend, requests } = backendAnswering('```json\n{"city":"Rome","celsius":21}\n```');
    await useBackend(backend);
    const cog = new Cogitator();

    const result = await cog.run(weatherAgent(), {
      input: 'Rome?',
      stream: true,
      onToken: () => undefined,
    });

    expect(requests[0].responseFormat?.type).toBe('json_schema');
    expect(result.structured).toEqual({ city: 'Rome', celsius: 21 });
    await cog.close();
  });

  it('leaves structured undefined when the answer does not match the schema', async () => {
    const { backend } = backendAnswering('{"city":"Oslo"}');
    await useBackend(backend);
    const cog = new Cogitator();

    const result = await cog.run(weatherAgent(), { input: 'Oslo?' });

    expect(result.output).toBe('{"city":"Oslo"}');
    expect(result.structured).toBeUndefined();
    await cog.close();
  });

  it('asks for a JSON object in json mode and sends nothing for text', async () => {
    const { backend, requests } = backendAnswering('{"ok":true}');
    await useBackend(backend);
    const cog = new Cogitator();
    const agent = (type: 'json' | 'text') =>
      new Agent({
        name: type,
        model: 'openai/gpt-6-luna',
        instructions: 'x',
        responseFormat: { type },
      });

    const json = await cog.run(agent('json'), { input: 'x' });
    const text = await cog.run(agent('text'), { input: 'x' });

    expect(requests[0].responseFormat).toEqual({ type: 'json_object' });
    expect(json.structured).toEqual({ ok: true });
    expect(requests[1].responseFormat).toBeUndefined();
    expect(text.structured).toBeUndefined();
    await cog.close();
  });
});

describe('toLLMResponseFormat', () => {
  it('turns off strict mode for schemas with optional fields', () => {
    const format = toLLMResponseFormat({
      type: 'json_schema',
      schema: z.object({ name: z.string(), nickname: z.string().optional() }),
    });
    expect(format).toMatchObject({ type: 'json_schema', jsonSchema: { strict: false } });
  });

  it('keeps strict mode for nested objects that require every field', () => {
    const format = toLLMResponseFormat({
      type: 'json_schema',
      schema: z
        .object({ items: z.array(z.object({ id: z.number(), tags: z.array(z.string()) })) })
        .describe('An order'),
    });
    expect(format).toMatchObject({
      jsonSchema: { strict: true, description: 'An order' },
    });
    expect(JSON.stringify(format)).not.toContain('$schema');
  });
});

describe('parseStructuredOutput', () => {
  it('ignores text that is not JSON', () => {
    expect(parseStructuredOutput({ type: 'json' }, 'Sure! Here you go.')).toBeUndefined();
  });

  it('applies the schema output, so transforms and defaults are kept', () => {
    const schema = z.object({
      count: z.string().transform(Number),
      unit: z.string().default('kg'),
    });
    expect(parseStructuredOutput({ type: 'json_schema', schema }, '{"count":"3"}')).toEqual({
      count: 3,
      unit: 'kg',
    });
  });
});

describe('agent serialization', () => {
  it('keeps json formats and asks for the schema back on deserialize', () => {
    const json = new Agent({
      name: 'a',
      model: 'm',
      instructions: 'i',
      responseFormat: { type: 'json' },
    });
    expect(Agent.deserialize(json.serialize()).config.responseFormat).toEqual({ type: 'json' });

    const typed = new Agent({
      name: 'b',
      model: 'm',
      instructions: 'i',
      responseFormat: { type: 'json_schema', schema: Weather.describe('weather') },
    });
    const snapshot = typed.serialize();
    expect(snapshot.config.responseFormat).toEqual({ type: 'json_schema', schemaName: 'weather' });
    expect(() => Agent.deserialize(snapshot)).toThrow('overrides.responseFormat');
    expect(
      Agent.deserialize(snapshot, {
        overrides: { responseFormat: { type: 'json_schema', schema: Weather } },
      }).config.responseFormat?.type
    ).toBe('json_schema');
  });
});
