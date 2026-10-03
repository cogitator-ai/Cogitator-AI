import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { ChatRequest, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { parseStructuredOutput, structuredOutputProblem } from '../cogitator/response-format';

const Weather = z.object({ city: z.string(), celsius: z.number() });
const format = { type: 'json_schema' as const, schema: Weather };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function answering(...answers: string[]) {
  const requests: ChatRequest[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      requests.push({ ...request, messages: [...request.messages] });
      const content = answers[Math.min(requests.length - 1, answers.length - 1)];
      return { id: `r${requests.length}`, content, finishReason: 'stop' as const, usage };
    }),
    chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      requests.push(request);
      yield { id: 's', delta: { content: answers[0] } };
      yield { id: 's', delta: {}, finishReason: 'stop', usage };
    }),
  };
  return { backend, requests };
}

const agent = () =>
  new Agent({
    name: 'weather',
    model: 'mock/m',
    instructions: 'Report the weather.',
    responseFormat: format,
  });

describe('structured output parsing', () => {
  it('reads JSON wrapped in prose', () => {
    expect(
      parseStructuredOutput(format, 'Here it is: {"city":"Rome","celsius":21} — enjoy!')
    ).toEqual({ city: 'Rome', celsius: 21 });
  });

  it('says what is wrong with an answer', () => {
    expect(structuredOutputProblem(format, 'no idea')).toBe('the answer is not valid JSON');
    expect(structuredOutputProblem(format, '{"city":"Rome","celsius":"21"}')).toMatch(/^celsius: /);
    expect(structuredOutputProblem(format, '{"city":"Rome","celsius":21}')).toBeUndefined();
  });
});

describe('structured output repair', () => {
  it('asks once more with the validation problem and keeps only the corrected answer', async () => {
    const { backend, requests } = answering(
      '{"city":"Rome","celsius":"21"}',
      '{"city":"Rome","celsius":21}'
    );
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
    });

    const result = await cog.run(agent(), { input: 'Rome?', threadId: 't-1' });

    expect(result.structured).toEqual({ city: 'Rome', celsius: 21 });
    expect(requests).toHaveLength(2);
    expect(String(requests[1].messages.at(-1)?.content)).toMatch(/celsius: .*corrected JSON/);
    const history = await cog.memory!.getEntries({ threadId: 't-1' });
    if (!history.success) throw new Error(history.error);
    expect(history.data.map((entry) => entry.message.content)).toEqual([
      'Rome?',
      '{"city":"Rome","celsius":21}',
    ]);
    await cog.close();
  });

  it('gives up after one correction', async () => {
    const { backend, requests } = answering('not json', 'still not json');
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    const result = await cog.run(agent(), { input: 'Rome?' });

    expect(result.structured).toBeUndefined();
    expect(requests).toHaveLength(2);
    await cog.close();
  });

  it('does not ask again when the answer was already streamed', async () => {
    const { backend, requests } = answering('not json');
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    const result = await cog.run(agent(), { input: 'Rome?', stream: true, onToken: () => {} });

    expect(result.structured).toBeUndefined();
    expect(requests).toHaveLength(1);
    await cog.close();
  });
});
