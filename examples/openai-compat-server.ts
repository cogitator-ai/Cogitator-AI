/**
 * OpenAI-Compatible Server Example
 *
 * Demonstrates running Cogitator as an OpenAI-compatible REST API server.
 * This allows using OpenAI SDKs to interact with Cogitator agents.
 */

import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import {
  createOpenAIServer,
  createOpenAIAdapter,
  InMemoryThreadStorage,
} from '@cogitator-ai/openai-compat';
import { z } from 'zod';
import OpenAI from 'openai';

const searchWeb = tool({
  name: 'search_web',
  description: 'Search the web for information',
  parameters: z.object({
    query: z.string().describe('Search query'),
    maxResults: z.number().default(5).describe('Maximum results to return'),
  }),
  execute: async ({ query, maxResults }) => {
    return {
      results: [
        { title: `Result 1 for: ${query}`, url: 'https://example.com/1' },
        { title: `Result 2 for: ${query}`, url: 'https://example.com/2' },
      ].slice(0, maxResults),
    };
  },
});

const calculate = tool({
  name: 'calculate',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string().describe('Math expression'),
  }),
  execute: async ({ expression }) => {
    const result = Function(`'use strict'; return (${expression})`)();
    return { expression, result };
  },
});

const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
    providers: { ollama: { baseUrl: 'http://localhost:11434' } },
  },
});

const assistant = new Agent({
  name: 'assistant',
  model: 'qwen2.5:7b',
  instructions: 'You are a helpful assistant with access to web search and calculation tools.',
  tools: [searchWeb, calculate],
});

const agents = new Map([[assistant.id, assistant]]);

async function runServer() {
  console.log('=== OpenAI-Compatible Server ===\n');

  const server = await createOpenAIServer({
    cogitator: cog,
    agents,
    port: 4000,
    host: '0.0.0.0',
  });

  console.log('Server running at http://localhost:4000');
  console.log('Use with OpenAI SDK:\n');
  console.log('  const client = new OpenAI({');
  console.log("    baseURL: 'http://localhost:4000/v1',");
  console.log("    apiKey: 'not-needed'");
  console.log('  });\n');

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.close();
    await cog.close();
    process.exit(0);
  });
}

async function runClient() {
  console.log('\n=== OpenAI SDK Client ===\n');

  const adapter = createOpenAIAdapter({
    cogitator: cog,
    agents,
    storage: new InMemoryThreadStorage(),
  });

  const assistantObj = await adapter.createAssistant({
    model: assistant.model,
    name: 'My Assistant',
    instructions: assistant.instructions,
  });
  console.log('Created assistant:', assistantObj.id);

  const thread = await adapter.createThread();
  console.log('Created thread:', thread.id);

  await adapter.addMessage(thread.id, {
    role: 'user',
    content: 'What is 42 * 13? Then search for "TypeScript best practices".',
  });

  const run = await adapter.createRun(thread.id, {
    assistant_id: assistantObj.id,
  });
  console.log('Created run:', run.id, 'Status:', run.status);

  let currentRun = run;
  while (currentRun.status === 'queued' || currentRun.status === 'in_progress') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    currentRun = adapter.getRun(thread.id, run.id)!;
    process.stdout.write('.');
  }
  console.log('\nRun completed with status:', currentRun.status);

  const messages = await adapter.listMessages(thread.id);
  const lastMessage = messages[0];
  if (lastMessage.content[0].type === 'text') {
    console.log('\nAssistant response:');
    console.log(lastMessage.content[0].text.value);
  }

  await cog.close();
}

async function runWithStreaming() {
  console.log('\n=== Streaming Example ===\n');

  const adapter = createOpenAIAdapter({
    cogitator: cog,
    agents,
    storage: new InMemoryThreadStorage(),
  });

  const assistantObj = await adapter.createAssistant({
    model: assistant.model,
    name: 'Streaming Assistant',
    instructions: 'You are helpful.',
  });

  const thread = await adapter.createThread();

  await adapter.addMessage(thread.id, {
    role: 'user',
    content: 'Write a short poem about AI.',
  });

  const run = await adapter.createRun(thread.id, {
    assistant_id: assistantObj.id,
    stream: true,
  });

  const emitter = adapter.getStreamEmitter(run.id);
  if (emitter) {
    emitter.on('event', (type, data) => {
      if (type === 'thread.message.delta') {
        const delta = data as { delta: { content: Array<{ text: { value: string } }> } };
        process.stdout.write(delta.delta?.content?.[0]?.text?.value ?? '');
      }
    });

    emitter.on('end', () => {
      console.log('\n\nStream completed.');
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
  await cog.close();
}

async function runWithOpenAISDK() {
  console.log('\n=== Using Official OpenAI SDK ===\n');

  console.log('Start the server first with: npx tsx examples/openai-compat-server.ts --server\n');

  const client = new OpenAI({
    baseURL: 'http://localhost:4000/v1',
    apiKey: 'not-needed',
  });

  try {
    const assistants = await client.beta.assistants.list();
    console.log('Available assistants:', assistants.data.length);

    const thread = await client.beta.threads.create();
    console.log('Created thread:', thread.id);

    await client.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: 'Hello! What can you help me with?',
    });

    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: assistants.data[0].id,
    });

    let currentRun = run;
    while (['queued', 'in_progress'].includes(currentRun.status)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      currentRun = await client.beta.threads.runs.retrieve(thread.id, run.id);
    }

    const messages = await client.beta.threads.messages.list(thread.id);
    const lastMsg = messages.data[0];
    if (lastMsg.content[0].type === 'text') {
      console.log('\nResponse:', lastMsg.content[0].text.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      console.log('Server not running. Start it with --server flag.');
    } else {
      throw error;
    }
  }
}

async function main() {
  const mode = process.argv[2] ?? '--client';

  switch (mode) {
    case '--server':
      await runServer();
      break;
    case '--client':
      await runClient();
      break;
    case '--stream':
      await runWithStreaming();
      break;
    case '--openai':
      await runWithOpenAISDK();
      break;
    default:
      console.log('Usage:');
      console.log('  npx tsx examples/openai-compat-server.ts --server  # Run server');
      console.log('  npx tsx examples/openai-compat-server.ts --client  # Run adapter demo');
      console.log('  npx tsx examples/openai-compat-server.ts --stream  # Run streaming demo');
      console.log('  npx tsx examples/openai-compat-server.ts --openai  # Use OpenAI SDK');
  }
}

main().catch(console.error);
