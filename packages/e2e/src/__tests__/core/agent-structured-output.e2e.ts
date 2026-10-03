import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

function extractJSON(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

describeE2E('Core: Structured Output', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('returns valid JSON matching schema', async () => {
    const agent = createTestAgent({
      instructions:
        'You return data as JSON. Always respond with valid JSON only, no markdown, no code fences, no explanation.',
      responseFormat: { type: 'json' },
    });

    const result = await cogitator.run(agent, {
      input:
        'Return a JSON object with exactly these fields: "name" (string value "Tokyo"), "age" (number value 100). Nothing else.',
    });

    const parsed = JSON.parse(extractJSON(result.output));
    expect(typeof parsed.name).toBe('string');
    expect(typeof parsed.age).toBe('number');
  });

  it('json array output', async () => {
    const agent = createTestAgent({
      instructions:
        'You return data as JSON arrays. Always respond with valid JSON only, no markdown, no code fences, no explanation.',
      responseFormat: { type: 'json' },
    });

    const result = await cogitator.run(agent, {
      input:
        'Return a JSON array of color strings. Example: ["red", "green", "blue"]. Return ONLY the JSON array.',
    });

    const parsed = JSON.parse(extractJSON(result.output));
    const items = Array.isArray(parsed) ? parsed : Object.values(parsed);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(1);

    for (const item of items) {
      const val = typeof item === 'object' && item !== null ? Object.values(item)[0] : item;
      expect(typeof val).toBe('string');
    }
  });
});

const Weather = z.object({ city: z.string(), celsius: z.number(), sunny: z.boolean() });

const lookupWeather = tool({
  name: 'lookup_weather',
  description: 'Current weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, celsius: 18, sunny: true }),
});

describeE2E('Core: Structured Output with a JSON schema on Ollama', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('returns result.structured that matches the schema', async () => {
    const agent = createTestAgent({
      instructions: 'You describe the weather.',
      responseFormat: { type: 'json_schema', schema: Weather },
    });

    const result = await cogitator.run(agent, {
      input: 'It is 21 degrees Celsius and sunny in Rome. Describe it.',
    });

    expect(Weather.safeParse(result.structured).success).toBe(true);
  });
});

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

describeGoogle('Core: Structured Output with a JSON schema on Gemini', () => {
  let cogitator: Cogitator;
  const model = 'google/gemini-3.5-flash-lite';

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: { defaultModel: model, providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('returns result.structured without any JSON instructions in the prompt', async () => {
    const agent = new Agent({
      name: 'weather',
      model,
      instructions: 'You describe the weather.',
      responseFormat: { type: 'json_schema', schema: Weather },
    });

    const result = await cogitator.run(agent, {
      input: 'It is 21 degrees Celsius and sunny in Rome.',
    });

    expect(result.structured).toEqual({ city: 'Rome', celsius: 21, sunny: true });
  });

  it('calls tools and then answers in the schema', async () => {
    const agent = new Agent({
      name: 'weather-tools',
      model,
      instructions: 'Use the lookup_weather tool, then report the weather.',
      tools: [lookupWeather],
      responseFormat: { type: 'json_schema', schema: Weather },
    });

    const result = await cogitator.run(agent, { input: 'What is the weather in Lisbon?' });

    expect(result.toolCalls.map((call) => call.name)).toContain('lookup_weather');
    expect(result.structured, `final answer: ${result.output}`).toEqual({
      city: 'Lisbon',
      celsius: 18,
      sunny: true,
    });
  });
});
