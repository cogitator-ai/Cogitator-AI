import { describe, it, expect, beforeAll } from 'vitest';
import { OllamaBackend } from '../../llm/ollama';
import { Cogitator } from '../../cogitator';
import { Agent } from '../../agent';
import { tool } from '../../tool';
import { z } from 'zod';

const TEST_MODEL = process.env.TEST_MODEL || 'qwen2.5:0.5b';

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    return res.ok;
  } catch {
    return false;
  }
}

const describeIfOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeIfOllama('Ollama Integration', () => {
  let backend: OllamaBackend;
  let ollamaAvailable = false;

  beforeAll(async () => {
    ollamaAvailable = await isOllamaRunning();
    if (ollamaAvailable) {
      backend = new OllamaBackend({ baseUrl: 'http://localhost:11434' });
    }
  });

  describe('chat()', () => {
    it('completes a simple prompt', async () => {
      if (!ollamaAvailable) return;

      const response = await backend.chat({
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
        maxTokens: 10,
      });

      expect(response.content.toLowerCase()).toContain('hello');
      expect(response.usage.totalTokens).toBeGreaterThan(0);
    });

    it('handles system messages', async () => {
      if (!ollamaAvailable) return;

      const response = await backend.chat({
        model: TEST_MODEL,
        messages: [
          { role: 'system', content: 'Always respond with exactly one word.' },
          { role: 'user', content: 'What color is the sky?' },
        ],
        maxTokens: 10,
      });

      expect(response.content.length).toBeLessThan(50);
    });

    it('respects temperature setting', async () => {
      if (!ollamaAvailable) return;

      const response = await backend.chat({
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
        maxTokens: 5,
        temperature: 0,
      });

      expect(response.content).toContain('4');
    });
  });

  describe('chatStream()', () => {
    it('streams response chunks', async () => {
      if (!ollamaAvailable) return;

      const chunks: string[] = [];

      for await (const chunk of backend.chatStream({
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
        maxTokens: 30,
      })) {
        if (chunk.delta.content) {
          chunks.push(chunk.delta.content);
        }
      }

      const fullText = chunks.join('');
      expect(fullText).toContain('1');
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('Cogitator with Ollama', () => {
    it('runs agent with tool execution', async () => {
      if (!ollamaAvailable) return;

      const calculatorTool = tool({
        name: 'multiply',
        description: 'Multiply two numbers',
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
        execute: async ({ a, b }) => ({ result: a * b }),
      });

      const agent = new Agent({
        name: 'MathAgent',
        instructions: 'You are a math assistant. Use tools to calculate.',
        model: `ollama/${TEST_MODEL}`,
        tools: [calculatorTool],
      });

      const cogitator = new Cogitator({
        defaultModel: `ollama/${TEST_MODEL}`,
      });

      const result = await cogitator.run(agent, 'What is 6 times 7?', {
        maxIterations: 3,
      });

      expect(result.success).toBe(true);

      await cogitator.close();
    });
  });
});
