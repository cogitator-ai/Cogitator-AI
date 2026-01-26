/**
 * Memory Persistence Example
 *
 * Demonstrates conversation memory with Redis and PostgreSQL adapters.
 * The agent remembers previous conversations across sessions.
 */

import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const takeNote = tool({
  name: 'take_note',
  description: 'Save a note for later reference',
  parameters: z.object({
    content: z.string().describe('Note content to save'),
  }),
  execute: async ({ content }) => {
    return { saved: true, note: content };
  },
});

const assistant = new Agent({
  name: 'memory-assistant',
  model: 'qwen2.5:7b',
  instructions: `You are a helpful assistant with persistent memory.
    You can remember facts about the user across conversations.
    When the user tells you something about themselves, acknowledge it.
    If asked about previous conversations, recall what you remember.`,
  tools: [takeNote],
});

async function withInMemory() {
  console.log('=== In-Memory Storage ===\n');

  const cog = new Cogitator({
    llm: {
      defaultProvider: 'ollama',
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    },
    memory: {
      adapter: 'memory',
      contextBuilder: { maxTokens: 4000, strategy: 'recent' },
    },
  });

  const threadId = 'user-123-session';

  const result1 = await cog.run(assistant, {
    input: 'Hi! My name is Alice and I love TypeScript.',
    threadId,
  });
  console.log('Turn 1:', result1.output, '\n');

  const result2 = await cog.run(assistant, {
    input: 'What did I just tell you about myself?',
    threadId,
  });
  console.log('Turn 2:', result2.output, '\n');

  const result3 = await cog.run(assistant, {
    input: 'What is my name?',
    threadId,
  });
  console.log('Turn 3:', result3.output, '\n');

  console.log(`Total messages in thread: ${result3.messages.length}`);

  await cog.close();
}

async function withRedis() {
  console.log('\n=== Redis Storage ===\n');

  const cog = new Cogitator({
    llm: {
      defaultProvider: 'ollama',
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    },
    memory: {
      adapter: 'redis',
      redis: {
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
        keyPrefix: 'cogitator:example:',
        ttl: 86400,
      },
      contextBuilder: { maxTokens: 4000, strategy: 'recent' },
    },
  });

  const threadId = 'persistent-thread-456';

  const result1 = await cog.run(assistant, {
    input: 'Remember this: the secret code is ALPHA-7.',
    threadId,
  });
  console.log('Saved:', result1.output, '\n');

  await cog.close();

  const cog2 = new Cogitator({
    llm: {
      defaultProvider: 'ollama',
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    },
    memory: {
      adapter: 'redis',
      redis: {
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
        keyPrefix: 'cogitator:example:',
      },
      contextBuilder: { maxTokens: 4000, strategy: 'recent' },
    },
  });

  const result2 = await cog2.run(assistant, {
    input: 'What was the secret code I told you?',
    threadId,
  });
  console.log('Recalled:', result2.output, '\n');

  await cog2.close();
}

async function withPostgres() {
  console.log('\n=== PostgreSQL Storage ===\n');

  const connectionString = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/cogitator';

  const cog = new Cogitator({
    llm: {
      defaultProvider: 'ollama',
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    },
    memory: {
      adapter: 'postgres',
      postgres: {
        connectionString,
        tableName: 'cogitator_memory',
      },
      contextBuilder: {
        maxTokens: 4000,
        strategy: 'summarize',
      },
    },
  });

  const threadId = 'postgres-thread-789';

  const result = await cog.run(assistant, {
    input: 'I prefer tabs over spaces. Remember that.',
    threadId,
  });
  console.log('Stored in PostgreSQL:', result.output, '\n');

  await cog.close();
}

async function withErrorHandling() {
  console.log('\n=== Error Handling ===\n');

  const cog = new Cogitator({
    llm: {
      defaultProvider: 'ollama',
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    },
    memory: {
      adapter: 'redis',
      redis: { url: 'redis://localhost:6379' },
    },
  });

  const result = await cog.run(assistant, {
    input: 'Hello!',
    threadId: 'error-test-thread',
    onMemoryError: (error, operation) => {
      console.log(`Memory ${operation} error: ${error.message}`);
    },
  });

  console.log('Response:', result.output);

  await cog.close();
}

async function main() {
  console.log('Memory Persistence Examples\n');
  console.log('This example shows how to persist agent memory.\n');

  await withInMemory();

  const hasRedis = process.env.REDIS_URL || process.argv.includes('--redis');
  if (hasRedis) {
    await withRedis();
  } else {
    console.log('\nSkipping Redis example (set REDIS_URL or pass --redis)\n');
  }

  const hasPostgres = process.env.DATABASE_URL || process.argv.includes('--postgres');
  if (hasPostgres) {
    await withPostgres();
  } else {
    console.log('Skipping PostgreSQL example (set DATABASE_URL or pass --postgres)\n');
  }

  await withErrorHandling();
}

main().catch(console.error);
