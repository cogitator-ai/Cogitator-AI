import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';
import { tool } from '@cogitator-ai/core';
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import OpenAI from 'openai';
import { z } from 'zod';

const PORT = 8080;

const multiply = tool({
  name: 'multiply',
  description: 'Multiply two numbers',
  parameters: z.object({
    a: z.number().describe('First factor'),
    b: z.number().describe('Second factor'),
  }),
  execute: async ({ a, b }) => ({ a, b, product: a * b }),
});

async function main() {
  header('06 — OpenAI-Compatible Server');

  const cog = createCogitator();

  const server = createOpenAIServer(cog, {
    port: PORT,
    tools: [multiply],
    defaultModel: DEFAULT_MODEL,
    logging: false,
  });

  await server.start();

  console.log();
  console.log('Test with curl:');
  console.log();
  console.log(`  curl ${server.getUrl()}/health`);
  console.log(`  curl ${server.getBaseUrl()}/models`);
  console.log();
  console.log('Or use the OpenAI SDK (demo below):');
  console.log();

  try {
    await demoOpenAIClient(server.getBaseUrl());
  } finally {
    await server.stop();
    await cog.close();
  }
}

async function demoOpenAIClient(baseURL: string) {
  const client = new OpenAI({
    baseURL,
    apiKey: 'not-needed',
  });

  const assistant = await client.beta.assistants.create({
    name: 'math-helper',
    model: 'cogitator',
    instructions:
      'You are a math helper. Use the multiply tool for products and get_unit_price for prices. Be concise.',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_unit_price',
          description: 'Get the unit price in USD of a product from the client catalog',
          parameters: {
            type: 'object',
            properties: { product: { type: 'string' } },
            required: ['product'],
          },
        },
      },
    ],
  });
  console.log('Created assistant:', assistant.id);

  const thread = await client.beta.threads.create();
  console.log('Created thread:', thread.id);

  await client.beta.threads.messages.create(thread.id, {
    role: 'user',
    content: 'What is 42 * 17?',
  });

  const run = await client.beta.threads.runs.createAndPoll(thread.id, {
    assistant_id: assistant.id,
  });
  console.log('Run status:', run.status);

  const messages = await client.beta.threads.messages.list(thread.id);
  const lastMessage = messages.data[0];
  if (lastMessage?.content[0]?.type === 'text') {
    console.log('Response:', lastMessage.content[0].text.value);
  }

  console.log('\n--- Client-side function calling (requires_action) ---');
  await client.beta.threads.messages.create(thread.id, {
    role: 'user',
    content: 'How much do 3 widgets cost? Look up the widget price first.',
  });

  let priced = await client.beta.threads.runs.createAndPoll(thread.id, {
    assistant_id: assistant.id,
  });
  while (priced.status === 'requires_action') {
    const calls = priced.required_action!.submit_tool_outputs.tool_calls;
    for (const call of calls)
      console.log(`Model asked for ${call.function.name}(${call.function.arguments})`);
    priced = await client.beta.threads.runs.submitToolOutputsAndPoll(priced.id, {
      thread_id: thread.id,
      tool_outputs: calls.map((call) => ({
        tool_call_id: call.id,
        output: JSON.stringify({ currency: 'USD', unit_price: 19.99 }),
      })),
    });
  }
  console.log('Run status:', priced.status);

  console.log('\n--- Streaming ---');
  await client.beta.threads.messages.create(thread.id, {
    role: 'user',
    content: 'Summarize our conversation in one sentence.',
  });
  const stream = client.beta.threads.runs
    .stream(thread.id, { assistant_id: assistant.id })
    .on('textDelta', (delta) => process.stdout.write(delta.value ?? ''));
  await stream.finalRun();
  console.log();
}

main();
