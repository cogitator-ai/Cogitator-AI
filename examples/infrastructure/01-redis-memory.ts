import { createCogitator, DEFAULT_MODEL, header, section, requireEnv } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { RedisAdapter } from '@cogitator-ai/memory';

async function main() {
  header('01 — Redis Memory: Persistent Conversations');

  const redisUrl = requireEnv('REDIS_URL');

  section('1. Direct RedisAdapter usage');

  const redis = new RedisAdapter({
    provider: 'redis',
    url: redisUrl,
    keyPrefix: 'example:',
    ttl: 3600,
  });

  const connectResult = await redis.connect();
  if (!connectResult.success) {
    console.error('Failed to connect to Redis:', connectResult.error);
    process.exit(1);
  }
  console.log('Connected to Redis');

  const threadId = 'persistent-chat-thread';

  const existing = await redis.getThread(threadId);
  if (existing.data) {
    console.log('Found existing thread from previous run!');
    const entries = await redis.getEntries({ threadId });
    console.log(`Thread has ${entries.data!.length} entries from before`);
    for (const entry of entries.data!) {
      const text =
        typeof entry.message.content === 'string' ? entry.message.content : '[multipart]';
      console.log(`  [${entry.message.role}] ${text.slice(0, 80)}`);
    }
  } else {
    console.log('No existing thread found, creating new one');
    await redis.createThread('redis-demo', { topic: 'persistence test' }, threadId);
  }

  await redis.addEntry({
    threadId,
    message: { role: 'user', content: `Ping at ${new Date().toISOString()}` },
    tokenCount: 10,
  });
  await redis.addEntry({
    threadId,
    message: { role: 'assistant', content: 'Pong!' },
    tokenCount: 3,
  });

  const allEntries = await redis.getEntries({ threadId });
  console.log(`Thread now has ${allEntries.data!.length} total entries`);

  section('2. Querying with limits');

  const lastTwo = await redis.getEntries({ threadId, limit: 2 });
  console.log('Last 2 entries:');
  for (const entry of lastTwo.data!) {
    const text = typeof entry.message.content === 'string' ? entry.message.content : '[multipart]';
    console.log(`  [${entry.message.role}] ${text}`);
  }

  section('3. Thread metadata');

  await redis.updateThread(threadId, {
    lastAccess: new Date().toISOString(),
    runCount: ((existing.data?.metadata?.runCount as number) ?? 0) + 1,
  });
  const updated = await redis.getThread(threadId);
  console.log('Thread metadata:', updated.data!.metadata);

  await redis.disconnect();

  section('4. Cogitator with Redis memory');

  const cog = createCogitator({
    memory: {
      adapter: 'redis',
      redis: { url: redisUrl, keyPrefix: 'cogbot:', ttl: 7200 },
      contextBuilder: { maxTokens: 4000, strategy: 'recent' },
    },
  });

  const agent = new Agent({
    name: 'redis-chatbot',
    model: DEFAULT_MODEL,
    instructions:
      'You are a helpful assistant with persistent memory. You remember everything across sessions. Be concise — 1-2 sentences.',
    temperature: 0.3,
  });

  const cogThreadId = 'redis-cogitator-demo';

  const conversations = [
    'My name is Jordan and I work at a startup called NovaTech.',
    'We build AI-powered supply chain tools.',
    "What's my name and what does my company do?",
  ];

  for (const input of conversations) {
    console.log(`\nUser: ${input}`);
    const result = await cog.run(agent, { input, threadId: cogThreadId });
    console.log(`Assistant: ${result.output}`);
  }

  section('5. Verify persistence');

  const adapter = cog.memory!;
  const stored = await adapter.getEntries({ threadId: cogThreadId });
  console.log(`Stored ${stored.data!.length} entries in thread "${cogThreadId}"`);
  console.log('(Run this example again to see Redis persistence in action)');

  await cog.close();
  console.log('\nDone.');
}

main();
