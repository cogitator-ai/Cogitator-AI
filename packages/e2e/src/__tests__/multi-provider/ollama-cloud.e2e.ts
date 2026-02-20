import { describe, it, expect, beforeAll } from 'vitest';
import { OllamaBackend, tool, toolToSchema } from '@cogitator-ai/core';
import { z } from 'zod';
import { createTestJudge } from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';

const describeOllamaCloud = process.env.OLLAMA_API_KEY ? describe : describe.skip;

describeOllamaCloud('Multi-Provider: Ollama Cloud Backend', () => {
  let backend: OllamaBackend;
  const model = process.env.OLLAMA_CLOUD_MODEL ?? 'gemma3:4b';
  const toolModel = process.env.OLLAMA_CLOUD_TOOL_MODEL ?? 'devstral-small-2:24b';

  beforeAll(() => {
    backend = new OllamaBackend({
      baseUrl: 'https://ollama.com',
      apiKey: process.env.OLLAMA_API_KEY!,
    });
    setJudge(createTestJudge());
  });

  it('basic chat returns a valid response', async () => {
    const response = await backend.chat({
      model,
      messages: [
        {
          role: 'user',
          content: 'What is the capital of France? Reply with just the city name.',
        },
      ],
      temperature: 0,
      maxTokens: 100,
    });

    expect(typeof response.content).toBe('string');
    expect(response.content.length).toBeGreaterThan(0);

    await expectJudge(response.content, {
      question: 'What is the capital of France?',
      criteria: 'Answer mentions Paris',
    });
  });

  it('streaming delivers chunks', async () => {
    const chunks: Array<{
      content?: string;
      finishReason?: string;
    }> = [];

    for await (const chunk of backend.chatStream({
      model,
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
      });
    }

    expect(chunks.length).toBeGreaterThan(1);

    const accumulated = chunks.map((c) => c.content ?? '').join('');
    expect(accumulated.length).toBeGreaterThan(0);
    expect(accumulated).toContain('3');
  });

  it('triggers tool calling', async () => {
    const weatherTool = tool({
      name: 'get_weather',
      description: 'Get the current weather for a given location',
      parameters: z.object({
        location: z.string().describe('City name'),
      }),
      execute: async ({ location }) => ({ temp: 22, location }),
    });

    const response = await backend.chat({
      model: toolModel,
      messages: [
        {
          role: 'user',
          content: "What's the weather in Tokyo?",
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
