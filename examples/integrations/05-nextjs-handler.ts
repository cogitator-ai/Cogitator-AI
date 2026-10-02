// Reference file — copy into your Next.js project at app/api/chat/route.ts
// This is not directly runnable as a standalone script.

import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { createChatHandler, createAgentHandler } from '@cogitator-ai/next';
import { z } from 'zod';

const cogitator = new Cogitator({
  llm: {
    defaultProvider: 'google',
    providers: {
      google: { apiKey: process.env.GOOGLE_API_KEY },
    },
  },
  memory: { adapter: 'memory' },
});

function evaluateArithmetic(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[-+*/%()]|\S/g) ?? [];
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const primary = (): number => {
    const token = next();
    if (token === '(') {
      const value = sum();
      if (next() !== ')') throw new Error('Missing closing parenthesis');
      return value;
    }
    if (token === '-') return -primary();
    if (token === '+') return primary();
    if (token !== undefined && /^\d/.test(token)) return Number(token);
    throw new Error(`Unexpected token: ${token ?? 'end of input'}`);
  };

  const product = (): number => {
    let value = primary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const rhs = primary();
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
    return value;
  };

  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = product();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  };

  const result = sum();
  if (pos !== tokens.length) throw new Error(`Unexpected token: ${peek()}`);
  return result;
}

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate an arithmetic expression (+ - * / % and parentheses)',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async ({ expression }) => {
    try {
      return { expression, result: evaluateArithmetic(expression) };
    } catch (error) {
      return { expression, error: error instanceof Error ? error.message : String(error) };
    }
  },
});

const agent = new Agent({
  name: 'assistant',
  model: 'google/gemini-2.5-flash',
  instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

// app/api/chat/route.ts — streaming chat handler (consume with useCogitatorChat).
// The server returns the thread id in the `finish` event; with memory enabled
// the conversation history is restored from that thread on the next turn.
export const POST = createChatHandler(cogitator, agent, {
  beforeRun: async (req) => {
    const auth = req.headers.get('authorization');
    if (!auth) throw new Error('Unauthorized');
    return { userId: auth };
  },
  afterRun: async (result) => {
    console.log(`Tokens used: ${result.usage.totalTokens}`);
  },
});

// app/api/agent/route.ts — JSON response handler (consume with useCogitatorAgent).
// In that route file export it as `export const POST = agentHandler;`
export const agentHandler = createAgentHandler(cogitator, agent, {
  afterRun: async (result) => {
    console.log(`Agent output: ${result.output.slice(0, 100)}`);
  },
});
