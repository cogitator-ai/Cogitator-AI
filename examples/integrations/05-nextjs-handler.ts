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
});

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async ({ expression }) => {
    const result = new Function(`return (${expression})`)() as number;
    return { expression, result };
  },
});

const agent = new Agent({
  name: 'assistant',
  model: 'google/gemini-2.5-flash',
  instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
  tools: [calculator],
  temperature: 0.3,
});

// app/api/chat/route.ts — streaming chat handler (works with useChat)
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

// app/api/agent/route.ts — JSON response handler (works with useAgent)
export const POST_AGENT = createAgentHandler(cogitator, agent, {
  afterRun: async (result) => {
    console.log(`Agent output: ${result.output.slice(0, 100)}`);
  },
});
