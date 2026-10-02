import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import type { RunResult } from '@cogitator-ai/core';
import { z } from 'zod';

const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;
const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

describeOllama('Core: runtime integrity (Ollama)', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator({ memory: true });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('links every span to the emitted agent.run root span', { timeout: 120_000 }, async () => {
    const result = await cogitator.run(createTestAgent(), { input: 'Say hi in one word.' });

    const [root, ...children] = result.trace.spans;
    expect(root.name).toBe('agent.run');
    expect(children.length).toBeGreaterThan(0);
    for (const span of children) {
      expect(span.parentId).toBe(root.id);
    }
  });

  it(
    'recovers from a stored history that contains a cut-off tool exchange',
    { timeout: 120_000 },
    async () => {
      const threadId = `integrity_${Date.now()}`;
      const agent = createTestAgent({
        instructions: 'You are a helpful assistant. Answer in one short sentence.',
      });

      await cogitator.run(agent, { input: 'My favourite colour is green.', threadId });
      await cogitator.memory!.addEntry({
        threadId,
        message: { role: 'tool', content: '"stale"', toolCallId: 'call_missing', name: 'lookup' },
        tokenCount: 4,
      });

      const result = await cogitator.run(agent, { input: 'Say OK.', threadId });

      expect(result.output.length).toBeGreaterThan(0);
      expect(
        result.messages.some((m) => m.role === 'tool' && m.toolCallId === 'call_missing')
      ).toBe(false);
    }
  );
});

describeGoogle('Core: runtime integrity (Gemini)', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: 'google/gemini-2.5-flash',
        providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
      },
      memory: { adapter: 'memory' },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it(
    'completes a turn with parallel tool calls answered together',
    { timeout: 180_000 },
    async () => {
      const temperatures: Record<string, number> = { tokyo: 21, paris: 14 };
      const weather = tool({
        name: 'get_temperature',
        description: 'Get the current temperature in Celsius for one city',
        parameters: z.object({ city: z.string().describe('City name') }),
        execute: async ({ city }) => ({
          city,
          celsius: temperatures[city.trim().toLowerCase()] ?? 0,
        }),
      });

      const agent = new Agent({
        name: 'parallel-weather',
        instructions:
          'Always call get_temperature once per city, calling it for all cities in the same turn. Then report each temperature as a number.',
        model: 'google/gemini-2.5-flash',
        tools: [weather],
      });

      let result: RunResult | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await cogitator.run(agent, {
          input: 'What is the temperature in Tokyo and in Paris right now?',
          parallelToolCalls: true,
        });
        if (result.toolCalls.length >= 2) break;
      }

      expect(result).toBeDefined();
      expect(result!.toolCalls.filter((tc) => tc.name === 'get_temperature').length).toBe(2);
      expect(result!.output).toContain('21');
      expect(result!.output).toContain('14');
    }
  );

  it(
    'round-trips Gemini 3 thought signatures through a multi-step tool run',
    { timeout: 180_000 },
    async () => {
      const lookup = tool({
        name: 'get_population',
        description: 'Get the population of a city in millions',
        parameters: z.object({ city: z.string().describe('City name') }),
        execute: async () => ({ millions: 37 }),
      });

      const agent = new Agent({
        name: 'gemini3-tools',
        instructions:
          'Always use get_population to answer population questions. Report the number.',
        model: 'google/gemini-3-flash',
        tools: [lookup],
      });

      let result: RunResult | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await cogitator.run(agent, { input: 'What is the population of Tokyo?' });
        if (result.toolCalls.length > 0) break;
      }

      expect(result).toBeDefined();
      expect(result!.toolCalls.some((tc) => tc.name === 'get_population')).toBe(true);
      expect(result!.toolCalls.every((tc) => typeof tc.thoughtSignature === 'string')).toBe(true);
      expect(result!.output).toContain('37');
    }
  );

  it(
    'keeps working on a thread whose stored history lost the tool call',
    { timeout: 120_000 },
    async () => {
      const threadId = `gemini_integrity_${Date.now()}`;
      const agent = new Agent({
        name: 'gemini-history',
        instructions: 'Answer in one short sentence.',
        model: 'google/gemini-2.5-flash',
      });

      await cogitator.run(agent, { input: 'Remember the number 42.', threadId });
      await cogitator.memory!.addEntry({
        threadId,
        message: { role: 'tool', content: '{"ok":true}', toolCallId: 'call_lost', name: 'save' },
        tokenCount: 4,
      });

      const result = await cogitator.run(agent, {
        input: 'Which number did I ask you to remember?',
        threadId,
      });

      expect(result.output).toContain('42');
    }
  );
});
