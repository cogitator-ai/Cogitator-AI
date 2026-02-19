import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import type { Cogitator } from '@cogitator-ai/core';

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
        'You return data as JSON. Always respond with valid JSON only, no markdown, no code fences.',
      responseFormat: { type: 'json' },
    });

    const result = await cogitator.run(agent, {
      input:
        'Give me data about Tokyo as JSON with fields: name (string), population (number), country (string).',
    });

    expect(typeof result.output).toBe('string');
    const parsed = JSON.parse(extractJSON(result.output));
    expect(typeof parsed.name).toBe('string');
    expect(typeof parsed.population).toBe('number');
    expect(parsed.population).toBeGreaterThan(0);
    expect(typeof parsed.country).toBe('string');
  });

  it('returns valid JSON array', async () => {
    const agent = createTestAgent({
      instructions:
        'You return data as JSON arrays. Always respond with valid JSON only, no markdown, no code fences.',
      responseFormat: { type: 'json' },
    });

    const result = await cogitator.run(agent, {
      input:
        'List 3 European capitals as a JSON array. Each item should have "city" (string) and "country" (string) fields.',
    });

    expect(typeof result.output).toBe('string');
    const parsed = JSON.parse(extractJSON(result.output));
    const items = Array.isArray(parsed)
      ? parsed
      : parsed.capitals || parsed.cities || parsed.data || Object.values(parsed)[0];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(typeof item.city).toBe('string');
      expect(typeof item.country).toBe('string');
    }
  });
});
