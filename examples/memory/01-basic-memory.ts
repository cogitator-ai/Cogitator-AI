import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { InMemoryAdapter } from '@cogitator-ai/memory';

async function main() {
  header('01 — Basic Memory: Threads & Multi-Turn Conversations');

  section('1. InMemoryAdapter — direct usage');

  const memory = new InMemoryAdapter();
  await memory.connect();

  const thread = await memory.createThread('agent-01', { topic: 'greetings' });
  console.log('Created thread:', thread.data!.id);

  await memory.addEntry({
    threadId: thread.data!.id,
    message: { role: 'user', content: 'Hello, my name is Alice.' },
    tokenCount: 8,
  });

  await memory.addEntry({
    threadId: thread.data!.id,
    message: { role: 'assistant', content: 'Nice to meet you, Alice!' },
    tokenCount: 7,
  });

  await memory.addEntry({
    threadId: thread.data!.id,
    message: { role: 'user', content: 'I work as a data scientist at Acme Corp.' },
    tokenCount: 11,
  });

  const entries = await memory.getEntries({ threadId: thread.data!.id });
  console.log(`Thread has ${entries.data!.length} entries:`);
  for (const entry of entries.data!) {
    console.log(`  [${entry.message.role}] ${entry.message.content}`);
  }

  console.log('\nAdapter stats:', memory.stats);

  section('2. Thread management');

  const thread2 = await memory.createThread('agent-01', { topic: 'coding' });
  await memory.addEntry({
    threadId: thread2.data!.id,
    message: { role: 'user', content: 'How do I sort an array in TypeScript?' },
    tokenCount: 10,
  });

  console.log('Stats after 2 threads:', memory.stats);

  await memory.updateThread(thread.data!.id, { topic: 'greetings', resolved: true });
  const updated = await memory.getThread(thread.data!.id);
  console.log('Updated thread metadata:', updated.data!.metadata);

  await memory.clearThread(thread2.data!.id);
  const cleared = await memory.getEntries({ threadId: thread2.data!.id });
  console.log('Thread 2 entries after clear:', cleared.data!.length);

  await memory.disconnect();

  section('3. Cogitator with memory — multi-turn conversation');

  const threadId = 'demo-memory-thread';

  const cog = createCogitator({
    memory: {
      adapter: 'memory',
      contextBuilder: { maxTokens: 4000, strategy: 'recent' },
    },
  });

  const agent = new Agent({
    name: 'memory-bot',
    model: DEFAULT_MODEL,
    instructions:
      'You are a helpful assistant with memory. You remember everything the user tells you across turns. Be concise — 1-2 sentences max.',
    temperature: 0.3,
  });

  const turns = [
    'My name is Alex and I live in Berlin.',
    'I have two cats named Luna and Mochi.',
    'What are my cats names and where do I live?',
  ];

  for (const input of turns) {
    console.log(`\nUser: ${input}`);
    const result = await cog.run(agent, { input, threadId });
    console.log(`Assistant: ${result.output}`);
  }

  section('4. Verify memory contents');

  const adapter = cog.memory!;
  const stored = await adapter.getEntries({ threadId });
  console.log(`Stored ${stored.data!.length} entries in thread "${threadId}":`);
  for (const entry of stored.data!) {
    const text =
      typeof entry.message.content === 'string' ? entry.message.content : '[multipart content]';
    console.log(`  [${entry.message.role}] ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
  }

  await cog.close();
  console.log('\nDone.');
}

main();
