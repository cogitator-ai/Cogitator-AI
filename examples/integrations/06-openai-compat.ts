import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import OpenAI from 'openai';
import { z } from 'zod';

const PORT = 8080;

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

async function main() {
  header('06 — OpenAI-Compatible Server');

  const cog = createCogitator();

  new Agent({
    name: 'assistant',
    model: DEFAULT_MODEL,
    instructions: 'You are a helpful assistant. Use tools when appropriate. Be concise.',
    tools: [calculator],
    temperature: 0.3,
  });

  const server = createOpenAIServer(cog, {
    port: PORT,
    tools: [calculator],
    logging: false,
  });

  // let the internal setupServer() async chain complete before calling listen()
  await new Promise((r) => setTimeout(r, 100));
  await server.start();

  console.log();
  console.log('Test with curl:');
  console.log();
  console.log(`  curl http://localhost:${PORT}/health`);
  console.log(`  curl http://localhost:${PORT}/v1/models`);
  console.log();
  console.log('Or use the OpenAI SDK (demo below):');
  console.log();

  await demoOpenAIClient();

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.stop();
    await cog.close();
    process.exit(0);
  });
}

async function demoOpenAIClient() {
  const client = new OpenAI({
    baseURL: `http://localhost:${PORT}/v1`,
    apiKey: 'not-needed',
  });

  const assistant = await client.beta.assistants.create({
    name: 'math-helper',
    model: 'cogitator',
    instructions: 'You are a math helper. Be concise.',
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

  console.log('\nServer still running — press Ctrl+C to stop');
}

main();
