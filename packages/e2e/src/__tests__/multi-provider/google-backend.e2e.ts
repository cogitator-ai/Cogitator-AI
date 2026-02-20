import { describe, it, expect, beforeAll } from 'vitest';
import { GoogleBackend, tool, toolToSchema } from '@cogitator-ai/core';
import { z } from 'zod';
import { createTestJudge } from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

describeGoogle('Multi-Provider: Google Gemini Backend', () => {
  let backend: GoogleBackend;

  beforeAll(() => {
    backend = new GoogleBackend({ apiKey: process.env.GOOGLE_API_KEY! });
    setJudge(createTestJudge());
  });

  it('basic chat returns a valid response', async () => {
    const response = await backend.chat({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: 'What is the capital of Japan? Reply with just the city name.',
        },
      ],
      temperature: 0,
      maxTokens: 100,
    });

    expect(typeof response.content).toBe('string');
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.usage.totalTokens).toBeGreaterThan(0);

    await expectJudge(response.content, {
      question: 'What is the capital of Japan?',
      criteria: 'Answer mentions Tokyo',
    });
  });

  it('streaming delivers chunks with usage', async () => {
    const chunks: Array<{
      content?: string;
      finishReason?: string;
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    }> = [];

    for await (const chunk of backend.chatStream({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: 'Count from 1 to 5, one number per line.',
        },
      ],
      temperature: 0,
      maxTokens: 200,
    })) {
      chunks.push({
        content: chunk.delta.content,
        finishReason: chunk.finishReason,
        usage: chunk.usage,
      });
    }

    expect(chunks.length).toBeGreaterThan(1);

    const accumulated = chunks.map((c) => c.content ?? '').join('');
    expect(accumulated.length).toBeGreaterThan(0);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.usage).toBeDefined();
    expect(lastChunk.usage!.inputTokens).toBeGreaterThan(0);
    expect(lastChunk.usage!.outputTokens).toBeGreaterThan(0);
  });

  it('triggers tool calling for get_weather', async () => {
    const weatherTool = tool({
      name: 'get_weather',
      description: 'Get the current weather for a given location',
      parameters: z.object({
        location: z.string().describe('City name'),
      }),
      execute: async ({ location }) => ({ temp: 22, location }),
    });

    const response = await backend.chat({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: "What's the weather in Paris?",
        },
      ],
      tools: [toolToSchema(weatherTool)],
      temperature: 0,
      maxTokens: 256,
    });

    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls!.length).toBeGreaterThan(0);
    expect(response.toolCalls![0].name).toBe('get_weather');
    expect(response.toolCalls![0].arguments).toHaveProperty('location');
  });
});
