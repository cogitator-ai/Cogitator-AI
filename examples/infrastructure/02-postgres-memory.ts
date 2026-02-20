import { createCogitator, DEFAULT_MODEL, header, section, requireEnv } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { PostgresAdapter } from '@cogitator-ai/memory';

async function main() {
  header('02 — PostgreSQL Memory: Long-Term Persistence');

  const connectionString = requireEnv('DATABASE_URL');

  section('1. Direct PostgresAdapter usage');

  const pg = new PostgresAdapter({
    provider: 'postgres',
    connectionString,
    schema: 'cogitator_example',
    poolSize: 5,
  });

  const connectResult = await pg.connect();
  if (!connectResult.success) {
    console.error('Failed to connect to PostgreSQL:', connectResult.error);
    process.exit(1);
  }
  console.log('Connected to PostgreSQL (schema auto-created)');

  const threadId = 'pg-demo-thread';

  const existing = await pg.getThread(threadId);
  if (existing.data) {
    console.log('Found existing thread from previous run');
    const entries = await pg.getEntries({ threadId });
    console.log(`Thread has ${entries.data!.length} persisted entries`);
  } else {
    await pg.createThread('pg-demo-agent', { topic: 'postgres persistence' }, threadId);
    console.log('Created new thread');
  }

  await pg.addEntry({
    threadId,
    message: { role: 'user', content: `Session started at ${new Date().toISOString()}` },
    tokenCount: 8,
    metadata: { source: 'example' },
  });
  await pg.addEntry({
    threadId,
    message: { role: 'assistant', content: 'Ready to help!' },
    tokenCount: 4,
    metadata: { source: 'example' },
  });

  const entries = await pg.getEntries({ threadId });
  console.log(`Thread now has ${entries.data!.length} entries`);

  section('2. Facts — long-term knowledge');

  await pg.addFact({
    agentId: 'pg-demo-agent',
    content: 'User prefers concise answers under 50 words',
    category: 'preference',
    confidence: 0.95,
    source: 'explicit',
    metadata: { origin: 'example' },
  });

  await pg.addFact({
    agentId: 'pg-demo-agent',
    content: 'User works in the fintech industry',
    category: 'profile',
    confidence: 0.8,
    source: 'inferred',
    metadata: { origin: 'example' },
  });

  const facts = await pg.getFacts('pg-demo-agent');
  console.log(`Stored ${facts.data!.length} facts:`);
  for (const fact of facts.data!) {
    console.log(`  [${fact.category}] ${fact.content} (confidence: ${fact.confidence})`);
  }

  section('3. Fact search');

  const searchResult = await pg.searchFacts('pg-demo-agent', 'fintech');
  console.log(`Search for "fintech" found ${searchResult.data!.length} facts:`);
  for (const fact of searchResult.data!) {
    console.log(`  ${fact.content}`);
  }

  section('4. Querying with time filters');

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recentEntries = await pg.getEntries({ threadId, after: fiveMinutesAgo });
  console.log(`Entries in last 5 minutes: ${recentEntries.data!.length}`);

  const lastEntry = await pg.getEntries({ threadId, limit: 1 });
  console.log('Most recent entry:', lastEntry.data![0]?.message.content);

  section('5. Cogitator with PostgreSQL memory');

  const cog = createCogitator({
    memory: {
      adapter: 'postgres',
      postgres: {
        connectionString,
        schema: 'cogitator_example',
        poolSize: 5,
      },
      contextBuilder: { maxTokens: 4000, strategy: 'recent' },
    },
  });

  const agent = new Agent({
    name: 'pg-chatbot',
    model: DEFAULT_MODEL,
    instructions:
      'You are an assistant with permanent memory stored in PostgreSQL. You remember everything forever. Be concise.',
    temperature: 0.3,
  });

  const pgThreadId = 'pg-cogitator-demo';

  const turns = [
    'Remember this: my project deadline is March 15th for the Q1 launch.',
    'I need to integrate with Stripe and Plaid APIs.',
    'What are my deadlines and which APIs do I need?',
  ];

  for (const input of turns) {
    console.log(`\nUser: ${input}`);
    const result = await cog.run(agent, { input, threadId: pgThreadId });
    console.log(`Assistant: ${result.output}`);
  }

  section('6. Cleanup');

  console.log('Thread and facts are persisted in PostgreSQL.');
  console.log('Run this example again to see data survive across restarts.');

  await pg.disconnect();
  await cog.close();
  console.log('\nDone.');
}

main();
