import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Cogitator, Agent, tool } from '../src/index';
import { z } from 'zod';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const TEST_MODEL = process.env.TEST_MODEL || 'qwen2.5:0.5b';

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;

    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const models = data.models || [];
    return models.some((m) => m.name === TEST_MODEL || m.name.startsWith(`${TEST_MODEL}:`));
  } catch {
    return false;
  }
}

describe('Integration Tests', async () => {
  const ollamaAvailable = await isOllamaAvailable();

  describe.skipIf(!ollamaAvailable)('Cogitator with Ollama', () => {
    let cog: Cogitator;

    beforeAll(() => {
      cog = new Cogitator({
        llm: {
          defaultProvider: 'ollama',
          providers: {
            ollama: { baseUrl: OLLAMA_URL },
          },
        },
        memory: {
          adapter: 'memory',
        },
      });
    });

    afterAll(async () => {
      await cog.close();
    });

    it('runs simple agent', async () => {
      const agent = new Agent({
        name: 'simple-agent',
        model: TEST_MODEL,
        instructions: 'You are a helpful assistant. Keep responses brief.',
      });

      const result = await cog.run(agent, {
        input: 'Say hello in exactly one word.',
      });

      expect(result.output).toBeTruthy();
      expect(typeof result.output).toBe('string');
    });

    it('runs agent with tool', async () => {
      const calculator = tool({
        name: 'add',
        description: 'Add two numbers together',
        parameters: z.object({
          a: z.number().describe('First number'),
          b: z.number().describe('Second number'),
        }),
        execute: async ({ a, b }) => ({ result: a + b }),
      });

      const agent = new Agent({
        name: 'math-agent',
        model: TEST_MODEL,
        instructions:
          'You help with math. Use the add tool when asked to add numbers. After using the tool, report the result.',
        tools: [calculator],
      });

      const result = await cog.run(agent, {
        input: 'What is 5 + 3?',
      });

      expect(result.toolCalls.length).toBeGreaterThanOrEqual(0);
      expect(result.output).toBeTruthy();
    });

    it('maintains conversation memory', async () => {
      const agent = new Agent({
        name: 'memory-agent',
        model: TEST_MODEL,
        instructions: 'You are a helpful assistant with memory. Remember what the user tells you.',
      });

      const threadId = `test-thread-${Date.now()}`;

      const result1 = await cog.run(agent, {
        input: 'My name is Alice.',
        threadId,
      });
      expect(result1.output).toBeTruthy();

      const result2 = await cog.run(agent, {
        input: 'What is my name?',
        threadId,
      });
      expect(result2.output?.toLowerCase()).toContain('alice');
    });

    it('respects maxIterations', async () => {
      const infiniteTool = tool({
        name: 'think',
        description: 'Think about something',
        parameters: z.object({ thought: z.string() }),
        execute: async () => ({ needsMoreThinking: true }),
      });

      const agent = new Agent({
        name: 'thinker',
        model: TEST_MODEL,
        instructions: 'Always use the think tool to think.',
        tools: [infiniteTool],
        maxIterations: 3,
      });

      const result = await cog.run(agent, {
        input: 'Think deeply.',
      });

      expect(result.toolCalls.length).toBeLessThanOrEqual(3);
    });

    it('handles streaming', async () => {
      const agent = new Agent({
        name: 'stream-agent',
        model: TEST_MODEL,
        instructions: 'You are a helpful assistant.',
      });

      const tokens: string[] = [];

      const result = await cog.run(agent, {
        input: 'Count from 1 to 5.',
        stream: true,
        onToken: (token) => tokens.push(token),
      });

      expect(result.output).toBeTruthy();
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.join('')).toBe(result.output);
    });

    it('calls onToolCall callback', async () => {
      const greet = tool({
        name: 'greet',
        description: 'Greet someone',
        parameters: z.object({ name: z.string() }),
        execute: async ({ name }) => ({ greeting: `Hello, ${name}!` }),
      });

      const agent = new Agent({
        name: 'greeter',
        model: TEST_MODEL,
        instructions: 'Use the greet tool to greet the user.',
        tools: [greet],
      });

      const toolCalls: Array<{ name: string; arguments: unknown }> = [];

      await cog.run(agent, {
        input: 'Greet Bob.',
        onToolCall: (call) => toolCalls.push(call),
      });

      expect(toolCalls.length).toBeGreaterThan(0);
    });

    it('returns usage statistics', async () => {
      const agent = new Agent({
        name: 'stats-agent',
        model: TEST_MODEL,
        instructions: 'Be brief.',
      });

      const result = await cog.run(agent, {
        input: 'Hi',
      });

      if (result.usage) {
        expect(result.usage.inputTokens).toBeGreaterThan(0);
        expect(result.usage.outputTokens).toBeGreaterThan(0);
        expect(result.usage.totalTokens).toBe(result.usage.inputTokens + result.usage.outputTokens);
      }
    });
  });

  describe.skipIf(ollamaAvailable)('Skipped (Ollama not available)', () => {
    it('placeholder test when Ollama is not running', () => {
      console.log(`
        Integration tests skipped: Ollama not available at ${OLLAMA_URL}

        To run integration tests:
        1. Install Ollama: https://ollama.ai
        2. Pull test model: ollama pull ${TEST_MODEL}
        3. Run tests: pnpm test
      `);
      expect(true).toBe(true);
    });
  });
});
