/**
 * Basic Agent Example
 *
 * This example demonstrates how to create a simple agent with tools.
 */

import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
    },
  },
});

const getCurrentTime = tool({
  name: 'get_current_time',
  description: 'Get the current date and time',
  parameters: z.object({
    timezone: z.string().default('UTC').describe('Timezone (e.g., "America/New_York")'),
  }),
  execute: async ({ timezone }) => {
    const now = new Date();
    return {
      timestamp: now.toISOString(),
      formatted: now.toLocaleString('en-US', { timeZone: timezone }),
      timezone,
    };
  },
});

const calculate = tool({
  name: 'calculate',
  description: 'Perform mathematical calculations',
  parameters: z.object({
    expression: z.string().describe('Mathematical expression (e.g., "2 + 2 * 3")'),
  }),
  execute: async ({ expression }) => {
    const result = Function(`'use strict'; return (${expression})`)();
    return { expression, result };
  },
});

const assistant = new Agent({
  name: 'helpful-assistant',
  model: 'llama3.1:8b',
  instructions: `You are a helpful assistant. You can:
    - Answer questions
    - Perform calculations using the calculate tool
    - Tell the current time using the get_current_time tool

    Always be concise and helpful.`,
  tools: [getCurrentTime, calculate],
  temperature: 0.7,
});

async function main() {
  console.log('Starting basic agent example...\n');

  console.log('Example 1: Simple question');
  const result1 = await cog.run(assistant, {
    input: 'What is the capital of France?',
  });
  console.log('Response:', result1.output);
  console.log('Tokens used:', result1.usage.totalTokens);
  console.log();

  console.log('Example 2: Using calculate tool');
  const result2 = await cog.run(assistant, {
    input: 'What is 15% of 250?',
  });
  console.log('Response:', result2.output);
  console.log(
    'Tool calls:',
    result2.toolCalls.map((t) => t.name)
  );
  console.log();

  console.log('Example 3: Using time tool');
  const result3 = await cog.run(assistant, {
    input: 'What time is it in Tokyo?',
  });
  console.log('Response:', result3.output);
  console.log();

  console.log('Example 4: Streaming response');
  process.stdout.write('Response: ');
  await cog.run(assistant, {
    input: 'Write a haiku about programming.',
    stream: true,
    onToken: (token) => process.stdout.write(token),
  });
  console.log('\n');

  await cog.close();
}

main().catch(console.error);
