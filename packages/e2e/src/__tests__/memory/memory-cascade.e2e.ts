import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { MemoryFiles, MemoryItems } from '@cogitator-ai/memory';
import type {
  LLMBackend,
  MemoryAdapter,
  MemoryConfig,
  MemoryFileAdapter,
  MemoryItemAdapter,
  NewMemoryItem,
} from '@cogitator-ai/types';

const postgresUrl = process.env.TEST_POSTGRES_URL;
const redisUrl =
  process.env.TEST_REDIS === 'true'
    ? (process.env.TEST_REDIS_URL ?? 'redis://localhost:6379')
    : undefined;
const mongoUrl = process.env.TEST_MONGODB_URL;
const tag = randomUUID().replace(/-/g, '').slice(0, 8);

const stub: LLMBackend = {
  provider: 'openai',
  async chat() {
    return {
      id: 'r',
      content: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
  async *chatStream() {
    yield { id: 's', delta: {}, finishReason: 'stop' };
  },
};

const targets: {
  name: string;
  url: string | undefined;
  memory: Partial<MemoryConfig>;
  cleanUp: () => Promise<void>;
}[] = [
  {
    name: 'Postgres',
    url: postgresUrl,
    memory: {
      adapter: 'postgres',
      postgres: { connectionString: postgresUrl!, schema: `cascade_${tag}` },
    },
    async cleanUp() {
      const client = new pg.Client({ connectionString: postgresUrl });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS cascade_${tag} CASCADE`);
      await client.end();
    },
  },
  {
    name: 'Redis',
    url: redisUrl,
    memory: { adapter: 'redis', redis: { url: redisUrl!, keyPrefix: `cascade:${tag}:` } },
    async cleanUp() {
      const redis = new Redis(redisUrl!);
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `cascade:${tag}:*`, 'COUNT', 500);
        if (keys.length > 0) await redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
      redis.disconnect();
    },
  },
  {
    name: 'MongoDB',
    url: mongoUrl,
    memory: { adapter: 'mongodb', mongodb: { uri: mongoUrl!, database: `cascade_${tag}` } },
    async cleanUp() {
      const client = new MongoClient(mongoUrl!);
      await client.connect();
      await client.db(`cascade_${tag}`).dropDatabase();
      await client.close();
    },
  },
];

for (const target of targets) {
  (target.url ? describe : describe.skip)(`Memory: lineage cascades on ${target.name}`, () => {
    const cog = new Cogitator({
      llm: { backends: { stub } },
      memory: target.memory as MemoryConfig,
    });
    const agent = new Agent({ name: `cascade-${tag}`, model: 'stub/m', instructions: 'x' });

    afterAll(async () => {
      await cog.close();
      await target.cleanUp();
    });

    async function stores() {
      const memory = (await cog.getMemory()) as MemoryAdapter &
        MemoryItemAdapter &
        MemoryFileAdapter;
      return {
        memory,
        items: new MemoryItems({ adapter: memory }),
        files: new MemoryFiles({ adapter: memory }),
      };
    }

    const fact = (content: string, entryId: string, userId: string): NewMemoryItem => ({
      kind: 'fact',
      content,
      subject: 'the user',
      trust: 'user',
      confidence: 0.9,
      scope: { agentId: agent.name, userId },
      evidence: [{ entryId, quote: content }],
      verified: true,
      status: 'active',
      saidAt: new Date(),
      sessionAt: new Date(),
    });

    async function said(threadId: string, userId: string, contents: string[]) {
      const { memory } = await stores();
      const created = await memory.createThread(agent.id, { userId }, threadId);
      expect(created.success).toBe(true);
      const ids: string[] = [];
      for (const [at, content] of contents.entries()) {
        const added = await memory.addEntry({
          threadId,
          message: { role: at % 2 === 0 ? 'user' : 'assistant', content },
          tokenCount: 5,
        });
        if (!added.success) throw new Error(added.error);
        ids.push(added.data.id);
      }
      return ids;
    }

    it('forgets and redacts entries with the items that stand on them', async () => {
      const { memory, items } = await stores();
      const [card, , city, , passport] = await said(`t1-${tag}`, 'ana', [
        'My card is 4111.',
        'Noted.',
        'I live in Porto.',
        'Ok.',
        'My passport is X91.',
      ]);
      const [cardItem, cityItem, passportItem] = await items.write([
        fact('The card is 4111.', card!, 'ana'),
        fact('The user lives in Porto.', city!, 'ana'),
        fact('The passport is X91.', passport!, 'ana'),
      ]);

      const forgot = await cog.forget({ entryIds: [card!] }, { agents: [agent] });
      expect(forgot.entries.deleted).toEqual([card]);
      expect(forgot.items.purged).toEqual([cardItem!.id]);
      expect(await items.get(cityItem!.id)).not.toBeNull();
      const gone = await memory.getEntry(card!);
      expect(gone.success && gone.data).toBeNull();

      const redacted = await cog.redactEntries([passport!], { agents: [agent], reason: 'asked' });
      expect(redacted.entries.redacted).toEqual([passport]);
      expect(redacted.items.purged).toEqual([passportItem!.id]);
      const entry = await memory.getEntry(passport!);
      expect(entry.success && entry.data?.message.content).toBe('[redacted]');
      const path = await memory.getPath!({ threadId: `t1-${tag}` });
      expect(path.success && path.data.map((one) => one.id)).toContain(passport);
    });

    it('rewinds a thread, leaving stale what stood only on the branch it left', async () => {
      const { items } = await stores();
      const [first, , later] = await said(`t2-${tag}`, 'ana', [
        'I live in Porto.',
        'Ok.',
        'I moved to Braga.',
      ]);
      const [braga] = await items.write([fact('The user lives in Braga.', later!, 'ana')]);

      const report = await cog.rewind(`t2-${tag}`, first!, { agents: [agent] });

      expect(report.items.stale).toEqual([braga!.id]);
      expect((await items.get(braga!.id))?.status).toBe('stale');
    });

    it('forgets a user across threads and stores, leaving other users alone', async () => {
      const { memory, items, files } = await stores();
      const [anaEntry] = await said(`t3-${tag}`, 'zoe', ['My code is 8812.', 'Noted.']);
      const [bobEntry] = await said(`t4-${tag}`, 'max', ['My bike is green.', 'Nice.']);
      await items.write([
        fact('The code is 8812.', anaEntry!, 'zoe'),
        fact('The bike is green.', bobEntry!, 'max'),
      ]);
      await files.create(
        { scope: { agentId: agent.name, userId: 'zoe' } },
        '/memories/notes.md',
        'code 8812'
      );

      const report = await cog.forget({ userId: 'zoe' }, { agents: [agent] });

      expect(report.threads).toEqual([`t3-${tag}`]);
      expect(await items.query({ scope: { agentId: agent.name, userId: 'zoe' } })).toEqual([]);
      expect(await items.query({ scope: { agentId: agent.name, userId: 'max' } })).toHaveLength(1);
      const note = await files.read(
        { scope: { agentId: agent.name, userId: 'zoe' } },
        '/memories/notes.md'
      );
      expect(note?.content).toBe('[redacted]');
      const kept = await memory.getThread(`t4-${tag}`);
      expect(kept.success && kept.data?.id).toBe(`t4-${tag}`);
    });
  });
}
