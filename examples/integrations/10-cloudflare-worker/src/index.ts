import { env } from 'cloudflare:workers';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/hono';
import { z } from 'zod';

interface Env {
  GOOGLE_API_KEY: string;
}

const calculator = tool({
  name: 'calculator',
  description: 'Add, subtract, multiply or divide two numbers',
  parameters: z.object({
    a: z.number(),
    b: z.number(),
    op: z.enum(['+', '-', '*', '/']),
  }),
  execute: async ({ a, b, op }) => {
    const result = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b;
    return { result };
  },
});

const assistant = new Agent({
  name: 'assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant. Use the calculator for arithmetic. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

const cogitator = new Cogitator({
  llm: { providers: { google: { apiKey: (env as Env).GOOGLE_API_KEY } } },
});

export default cogitatorApp({ cogitator, agents: { assistant } });
