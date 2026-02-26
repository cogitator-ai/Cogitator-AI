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
