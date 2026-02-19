import { describe, it, expect, beforeAll } from 'vitest';
import { GoogleBackend } from '../../llm/google';
import { Cogitator } from '../../cogitator';
import { Agent } from '../../agent';
import { tool } from '../../tool';
import { z } from 'zod';

const hasGoogleKey = !!process.env.GOOGLE_API_KEY;

describe.skipIf(!hasGoogleKey)('Google Integration', () => {
  let backend: GoogleBackend;

  beforeAll(() => {
    backend = new GoogleBackend({ apiKey: process.env.GOOGLE_API_KEY! });
  });

  describe('chat()', () => {
    it('completes a simple prompt', async () => {
      const response = await backend.chat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
        maxTokens: 10,
      });

      expect(response.content.toLowerCase()).toContain('hello');
      expect(response.usage.totalTokens).toBeGreaterThan(0);
    });

    it('handles system messages', async () => {
      const response = await backend.chat({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'You are a pirate. Always say "Arrr!" at the start.' },
          { role: 'user', content: 'Hello' },
        ],
        maxTokens: 50,
      });

      expect(response.content.toLowerCase()).toContain('arrr');
    });

    it('respects temperature setting', async () => {
      const response = await backend.chat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
        maxTokens: 5,
        temperature: 0,
      });

      expect(response.content).toContain('4');
    });
  });

  describe('chatStream()', () => {
    it('streams response chunks', async () => {
      const chunks: string[] = [];

      for await (const chunk of backend.chatStream({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
        maxTokens: 50,
      })) {
        if (chunk.content) {
          chunks.push(chunk.content);
        }
      }

      const fullText = chunks.join('');
      expect(fullText).toContain('1');
      expect(fullText).toContain('5');
    });
  });

  describe('tool calling', () => {
    it('calls a tool and returns result', async () => {
      const response = await backend.chat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'What is 15 * 7? Use the calculator tool.' }],
        tools: [
          {
            name: 'calculator',
            description: 'Perform arithmetic calculations',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
                operation: { type: 'string', enum: ['add', 'multiply'] },
              },
              required: ['a', 'b', 'operation'],
            },
          },
        ],
        maxTokens: 100,
      });

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls!.length).toBeGreaterThan(0);
      expect(response.toolCalls![0].name).toBe('calculator');
    });
  });

  describe('Cogitator with Google', () => {
    it('runs agent with tool execution', async () => {
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
        model: 'google:gemini-2.5-flash',
        tools: [calculatorTool],
      });

      const cogitator = new Cogitator({
        defaultModel: 'google:gemini-2.5-flash',
        llm: {
          providers: {
            google: { apiKey: process.env.GOOGLE_API_KEY! },
          },
        },
      });

      const result = await cogitator.run(agent, 'What is 12 times 8?', {
        maxIterations: 3,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('96');

      await cogitator.close();
    });
  });
});
