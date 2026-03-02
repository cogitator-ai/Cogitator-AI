import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestCogitator } from '../../helpers/setup';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import type { RunResult } from '@cogitator-ai/core';
import { z } from 'zod';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

describeGoogle('Core: Google Provider E2E', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: 'google/gemini-2.5-flash',
        providers: {
          google: {
            apiKey: process.env.GOOGLE_API_KEY!,
          },
        },
      },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('answers a factual question', { timeout: 120_000 }, async () => {
    const agent = new Agent({
      name: 'google-basic',
      instructions: 'You are a math assistant. Reply with ONLY the number, nothing else.',
      model: 'google/gemini-2.5-flash',
    });

    const result = await cogitator.run(agent, {
      input: 'What is 7 * 8? Reply with ONLY the number.',
    });

    expect(result.output).toContain('56');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('calls a tool and incorporates result', { timeout: 120_000 }, async () => {
    const multiplyTool = tool({
      name: 'multiply',
      description: 'Multiply two numbers together',
      parameters: z.object({
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      }),
      execute: async ({ a, b }) => ({ result: a * b }),
    });

    const agent = new Agent({
      name: 'google-tool-agent',
      instructions:
        'You are a math assistant. You MUST use the multiply tool for multiplication. Report the exact result.',
      model: 'google/gemini-2.5-flash',
      tools: [multiplyTool],
    });

    let result: RunResult | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await cogitator.run(agent, {
        input: 'Multiply 12 by 11 using the multiply tool.',
      });
      if (result.toolCalls.length > 0) break;
    }

    expect(result).toBeDefined();
    expect(result!.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);
    expect(result!.output).toContain('132');
  });

  it('returns structured JSON output', { timeout: 120_000 }, async () => {
    const agent = new Agent({
      name: 'google-json',
      instructions: 'Reply only with valid JSON. No markdown fences.',
      model: 'google/gemini-2.5-flash',
      responseFormat: { type: 'json' },
    });

    const result = await cogitator.run(agent, {
      input: 'Return a JSON object with key "answer" and value 42.',
    });

    const cleaned = result.output
      .replace(/```json?\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    expect(parsed.answer).toBe(42);
  });
});

describeGoogle('Core: Multi-Provider Consistency', () => {
  const multiplyTool = tool({
    name: 'multiply',
    description: 'Multiply two numbers',
    parameters: z.object({
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    }),
    execute: async ({ a, b }) => ({ result: a * b }),
  });

  const providers = [
    {
      name: 'google',
      available: !!process.env.GOOGLE_API_KEY,
      create: () =>
        new Cogitator({
          llm: {
            defaultModel: 'google/gemini-2.5-flash',
            providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
          },
        }),
      model: 'google/gemini-2.5-flash',
    },
  ];

  const ollamaAvailable = process.env.TEST_OLLAMA === 'true';
  if (ollamaAvailable) {
    providers.push({
      name: 'ollama',
      available: true,
      create: () => createTestCogitator(),
      model: `ollama/${process.env.TEST_MODEL || 'qwen2.5:0.5b'}`,
    });
  }

  for (const provider of providers.filter((p) => p.available)) {
    describe(`${provider.name}`, () => {
      let cogitator: Cogitator;

      beforeAll(() => {
        cogitator = provider.create();
      });

      afterAll(async () => {
        await cogitator.close();
      });

      it('agent calls tool and returns correct result', { timeout: 120_000 }, async () => {
        const agent = new Agent({
          name: `${provider.name}-multi-test`,
          instructions:
            'You MUST use the multiply tool for multiplication. Report the exact numeric result.',
          model: provider.model,
          tools: [multiplyTool],
        });

        let result: RunResult | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          result = await cogitator.run(agent, {
            input: 'Multiply 9 by 11 using the multiply tool.',
          });
          if (result.toolCalls.length > 0) break;
        }

        expect(result).toBeDefined();
        expect(result!.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);
        expect(result!.output).toContain('99');
      });
    });
  }
});
