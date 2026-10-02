import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RedisAdapter,
  SQLiteAdapter,
  SessionManager,
  ContextBuilder,
  OllamaEmbeddingService,
} from '@cogitator-ai/memory';
import { Cogitator } from '@cogitator-ai/core';
import type { MemoryAdapter, Message } from '@cogitator-ai/types';
import { createTestAgent, getOllamaUrl, getTestModel, isOllamaRunning } from '../../helpers/setup';

const describeRedis = process.env.TEST_REDIS === 'true' ? describe : describe.skip;
const describeRedisOllama =
  process.env.TEST_REDIS === 'true' && process.env.TEST_OLLAMA === 'true'
    ? describe
    : describe.skip;
const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

const user = (content: string): Message => ({ role: 'user', content });

async function exerciseAdapter(adapter: MemoryAdapter, threadId: string) {
  await adapter.createThread('agent-e2e', { purpose: 'e2e' }, threadId);
  for (const content of ['one', 'two', 'three', 'four', 'five']) {
    const added = await adapter.addEntry({ threadId, message: user(content), tokenCount: 1 });
    expect(added.success).toBe(true);
  }

  const all = await adapter.getEntries({ threadId });
  expect(all.success && all.data.map((e) => e.message.content)).toEqual([
    'one',
    'two',
    'three',
    'four',
    'five',
  ]);

  const recent = await adapter.getEntries({ threadId, limit: 2 });
  expect(recent.success && recent.data.map((e) => e.message.content)).toEqual(['four', 'five']);

  const recreated = await adapter.createThread('agent-e2e', { purpose: 'again' }, threadId);
  expect(recreated.success).toBe(true);
  const afterRecreate = await adapter.getEntries({ threadId });
  expect(afterRecreate.success && afterRecreate.data).toHaveLength(5);

  const sessions = new SessionManager(adapter);
  const session = await sessions.getOrCreate({
    userId: `user-${threadId}`,
    channelType: 'terminal',
    channelId: 'tty',
    agentId: 'agent-e2e',
  });
  const listed = await sessions.list({ agentId: 'agent-e2e' });
  expect(listed.map((s) => s.id)).toContain(session.id);
  await sessions.delete(session.id);
  expect((await sessions.list()).map((s) => s.id)).not.toContain(session.id);

  await adapter.deleteThread(threadId);
  const gone = await adapter.getThread(threadId);
  expect(gone.success && gone.data).toBeNull();
}

describe('Memory: SQLite adapter', () => {
  it('keeps order, upserts threads and lists sessions', async () => {
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' });
    expect((await adapter.connect()).success).toBe(true);
    try {
      await exerciseAdapter(adapter, `sqlite-${Date.now()}`);
    } finally {
      await adapter.disconnect();
    }
  });
});

describeRedis('Memory: Redis adapter', () => {
  let adapter: RedisAdapter;

  beforeAll(async () => {
    adapter = new RedisAdapter({
      provider: 'redis',
      host: 'localhost',
      port: 6379,
      keyPrefix: `cogitator-e2e-${Date.now()}:`,
      ttl: 600,
    });
    const connected = await adapter.connect();
    if (!connected.success) throw new Error(connected.error);
  });

  afterAll(async () => {
    await adapter.disconnect();
  });

  it('keeps order, upserts threads and lists sessions', async () => {
    await exerciseAdapter(adapter, `redis-${Date.now()}`);
  });
});

describeRedisOllama('Memory: agent with Redis memory', () => {
  let cogitator: Cogitator;
  const keyPrefix = `cogitator-agent-e2e-${Date.now()}:`;

  beforeAll(async () => {
    if (!(await isOllamaRunning())) throw new Error('Ollama not running');
    cogitator = new Cogitator({
      llm: { defaultModel: `ollama/${getTestModel()}` },
      memory: {
        adapter: 'redis',
        redis: { url: 'redis://localhost:6379', keyPrefix },
      },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('persists conversation turns in order', { timeout: 120_000 }, async () => {
    const agent = createTestAgent({ name: 'redis-memory-agent', instructions: 'Reply briefly.' });
    const threadId = `redis-thread-${Date.now()}`;

    await cogitator.run(agent, { input: 'My name is Ada.', threadId });
    await cogitator.run(agent, { input: 'What is my name?', threadId });

    const adapter = new RedisAdapter({
      provider: 'redis',
      host: 'localhost',
      port: 6379,
      keyPrefix,
    });
    await adapter.connect();
    const entries = await adapter.getEntries({ threadId });
    await adapter.disconnect();

    expect(entries.success).toBe(true);
    if (!entries.success) return;
    const roles = entries.data.map((e) => e.message.role);
    expect(roles.slice(0, 2)).toEqual(['user', 'assistant']);
    expect(entries.data[0].message.content).toBe('My name is Ada.');
    expect(entries.data.at(-2)?.message.content).toBe('What is my name?');
  });
});

describeOllama('Memory: relevant context with Ollama embeddings', () => {
  it('builds relevant-strategy context from real embeddings', { timeout: 120_000 }, async () => {
    if (!(await isOllamaRunning())) throw new Error('Ollama not running');
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' });
    await adapter.connect();
    await adapter.createThread('agent', {}, 'thread');
    const history = [
      'I adopted a cat named Whiskers last year.',
      'The quarterly tax report is due on Friday.',
      'My cat Whiskers loves sleeping on the keyboard.',
      'Remember to renew the car insurance.',
    ];
    for (const content of history) {
      await adapter.addEntry({ threadId: 'thread', message: user(content), tokenCount: 20 });
    }

    const builder = new ContextBuilder(
      { maxTokens: 200, reserveTokens: 160, strategy: 'relevant', includeSystemPrompt: false },
      {
        memoryAdapter: adapter,
        embeddingService: new OllamaEmbeddingService({
          model: getTestModel(),
          baseUrl: getOllamaUrl(),
        }),
      }
    );

    const context = await builder.build({
      threadId: 'thread',
      agentId: 'agent',
      currentInput: 'Tell me about my cat Whiskers',
    });

    expect(context.messages).toHaveLength(2);
    const included = context.messages.map((m) => m.content as string);
    expect(history.filter((h) => included.includes(h))).toEqual(included);
    expect(context.truncated).toBe(true);
    await adapter.disconnect();
  });
});
