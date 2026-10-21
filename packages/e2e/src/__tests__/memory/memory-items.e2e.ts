import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { fileKeyOf, MongoDBAdapter, PostgresAdapter, RedisAdapter } from '@cogitator-ai/memory';
import {
  memoryFileAdapterConformanceCases,
  memoryItemAdapterConformanceCases,
} from '@cogitator-ai/test-utils';
import type {
  Evidence,
  MemoryAdapter,
  MemoryFileAdapter,
  MemoryItemAdapter,
  MemoryResult,
} from '@cogitator-ai/types';

const postgresUrl = process.env.TEST_POSTGRES_URL;
const redisUrl =
  process.env.TEST_REDIS === 'true'
    ? (process.env.TEST_REDIS_URL ?? 'redis://localhost:6379')
    : undefined;
const mongoUrl = process.env.TEST_MONGODB_URL;

const tag = randomUUID().replace(/-/g, '').slice(0, 8);

type ItemStore = MemoryAdapter & MemoryItemAdapter & MemoryFileAdapter;

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

async function connected<T extends ItemStore>(adapter: T): Promise<T> {
  unwrap(await adapter.connect());
  return adapter;
}

interface Target {
  name: string;
  url: string | undefined;
  create(): Promise<ItemStore>;
  /** Removes everything the cases stored */
  cleanUp(): Promise<void>;
}

async function dropSchemas(...schemas: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}

const targets: Target[] = [
  {
    name: 'PostgresAdapter',
    url: postgresUrl,
    create: () =>
      connected(
        new PostgresAdapter({
          provider: 'postgres',
          connectionString: postgresUrl!,
          schema: `items_conformance_${tag}`,
        })
      ),
    cleanUp: () => dropSchemas(`items_conformance_${tag}`),
  },
  {
    name: 'RedisAdapter',
    url: redisUrl,
    create: () =>
      connected(
        new RedisAdapter({ provider: 'redis', url: redisUrl!, keyPrefix: `items:${tag}:` })
      ),
    async cleanUp() {
      const redis = new Redis(redisUrl!);
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `items:${tag}:*`, 'COUNT', 500);
        if (keys.length > 0) await redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
      redis.disconnect();
    },
  },
  {
    name: 'MongoDBAdapter',
    url: mongoUrl,
    create: () =>
      connected(
        new MongoDBAdapter({ provider: 'mongodb', uri: mongoUrl!, database: `items_${tag}` })
      ),
    async cleanUp() {
      const client = new MongoClient(mongoUrl!);
      await client.connect();
      await client.db(`items_${tag}`).dropDatabase();
      await client.close();
    },
  },
];

for (const target of targets) {
  (target.url ? describe : describe.skip)(`Memory: ${target.name} memory items conformance`, () => {
    afterAll(() => target.cleanUp());

    for (const c of memoryItemAdapterConformanceCases({
      create: target.create,
      release: async (adapter) => {
        await adapter.disconnect();
      },
    })) {
      (c.skip ? it.skip : it)(c.name, { timeout: 30_000 }, () => c.run());
    }
  });

  (target.url ? describe : describe.skip)(`Memory: ${target.name} memory files conformance`, () => {
    for (const c of memoryFileAdapterConformanceCases({
      create: target.create,
      release: async (adapter) => {
        await adapter.disconnect();
      },
    })) {
      (c.skip ? it.skip : it)(c.name, { timeout: 30_000 }, () => c.run());
    }
  });
}

const created = new Date('2025-03-01T10:00:00.123Z');
const touched = new Date('2025-04-01T10:00:00.000Z');
const future = new Date('2099-01-01T00:00:00.000Z');
const past = new Date('2025-05-01T00:00:00.000Z');
const evidence: Evidence[] = [{ entryId: 'entry_1', quote: 'I only drink lapsang' }];

/** Lays `schema` out as version 2 left it: threads and entries as trees, facts in their table */
async function createVersion2Schema(client: pg.Client, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`
    CREATE TABLE ${schema}.threads (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      active_leaf_id TEXT
    )
  `);
  await client.query(`CREATE SEQUENCE ${schema}.entries_seq`);
  await client.query(`
    CREATE TABLE ${schema}.entries (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${schema}.threads(id) ON DELETE CASCADE,
      message JSONB NOT NULL, tool_calls JSONB, tool_results JSONB,
      token_count INTEGER NOT NULL, metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), seq BIGINT DEFAULT nextval('${schema}.entries_seq'),
      type TEXT, parent_id TEXT, event JSONB, format_version INTEGER
    )
  `);
  await client.query(`
    CREATE TABLE ${schema}.facts (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL,
      category TEXT NOT NULL, confidence REAL DEFAULT 1.0, source TEXT NOT NULL,
      metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ, evidence JSONB
    )
  `);
  await client.query(`CREATE INDEX idx_facts_agent_id ON ${schema}.facts(agent_id, category)`);
  await client.query(`
    CREATE TABLE ${schema}.cogitator_schema_migrations (
      component TEXT PRIMARY KEY, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    `INSERT INTO ${schema}.cogitator_schema_migrations (component, version) VALUES ('memory', 2)`
  );
}

interface LegacyFact {
  id: string;
  content: string;
  category: string;
  confidence: number;
  source: string;
  metadata: Record<string, unknown>;
  expiresAt: Date | null;
  evidence: Evidence[] | null;
}

const legacyFacts = (agentId: string): (LegacyFact & { agentId: string })[] => [
  {
    agentId,
    id: 'fact_tea',
    content: 'Drinks only lapsang tea',
    category: 'preference',
    confidence: 0.9,
    source: 'user',
    metadata: { userId: 'alice', origin: 'chat' },
    expiresAt: null,
    evidence,
  },
  {
    agentId,
    id: 'fact_office',
    content: 'Works from the Porto office',
    category: 'profile',
    confidence: 0.6,
    source: 'inferred',
    metadata: {},
    expiresAt: future,
    evidence: null,
  },
  {
    agentId,
    id: 'fact_trip',
    content: 'Travels to Lisbon in April',
    category: 'plans',
    confidence: 1,
    source: 'system',
    metadata: {},
    expiresAt: past,
    evidence: null,
  },
];

async function insertLegacyFacts(client: pg.Client, schema: string, agentId: string) {
  for (const fact of legacyFacts(agentId)) {
    await client.query(
      `INSERT INTO ${schema}.facts
       (id, agent_id, content, category, confidence, source, metadata, created_at, updated_at,
        expires_at, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb)`,
      [
        fact.id,
        fact.agentId,
        fact.content,
        fact.category,
        fact.confidence,
        fact.source,
        JSON.stringify(fact.metadata),
        created,
        touched,
        fact.expiresAt,
        fact.evidence === null ? null : JSON.stringify(fact.evidence),
      ]
    );
  }
}

async function tablesOf(client: pg.Client, schema: string): Promise<Record<string, boolean>> {
  const found = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS facts, to_regclass($2) IS NOT NULL AS legacy,
            to_regclass($3) IS NOT NULL AS items`,
    [`${schema}.facts`, `${schema}.facts_legacy`, `${schema}.memory_items`]
  );
  return found.rows[0] as Record<string, boolean>;
}

async function countOf(client: pg.Client, table: string): Promise<number> {
  const found = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
  return found.rows[0]?.n as number;
}

(postgresUrl ? describe : describe.skip)('Memory: Postgres facts moved into memory items', () => {
  const schema = `items_v2_${tag}`;
  const racedSchema = `items_v2_race_${tag}`;
  const agentId = `agent-${tag}`;
  const config = { provider: 'postgres' as const, connectionString: postgresUrl!, schema };
  let client: pg.Client;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    await createVersion2Schema(client, schema);
    await insertLegacyFacts(client, schema, agentId);
    adapter = await connected(new PostgresAdapter(config));
  });

  afterAll(async () => {
    await adapter?.disconnect();
    await client?.end();
    await dropSchemas(schema, racedSchema);
  });

  it('moves every fact into an item with its id and keeps the old table as facts_legacy', async () => {
    expect(await tablesOf(client, schema)).toEqual({ facts: false, legacy: true, items: true });
    expect(await countOf(client, `${schema}.facts_legacy`)).toBe(3);
    const version = await client.query(
      `SELECT version FROM ${schema}.cogitator_schema_migrations WHERE component = 'memory'`
    );
    expect(version.rows[0]?.version).toBe(4);

    const tea = unwrap(await adapter.getItem('fact_tea'));
    expect(tea).toEqual({
      id: 'fact_tea',
      kind: 'fact',
      content: 'Drinks only lapsang tea',
      attribute: 'preference',
      slot: 'fact:fact_tea',
      status: 'active',
      trust: 'user',
      confidence: 0.9,
      scope: { agentId, userId: 'alice' },
      evidence,
      verified: true,
      saidAt: created,
      sessionAt: created,
      validFrom: created,
      recordedAt: created,
      metadata: { userId: 'alice', origin: 'chat', category: 'preference' },
    });
    expect(unwrap(await adapter.getItem('fact_office'))).toMatchObject({
      trust: 'model',
      verified: false,
      evidence: [],
      scope: { agentId },
      expiredAt: future,
    });
    expect(unwrap(await adapter.getItem('fact_trip'))).toMatchObject({
      trust: 'system',
      expiredAt: past,
    });
    const ofAlice = unwrap(
      await adapter.findItems({
        agentId,
        scope: { agentId, userId: 'alice' },
        includeExpired: true,
      })
    );
    expect(ofAlice.map((found) => found.id)).toEqual(['fact_tea']);
  });

  it('serves the moved facts through the Fact API under their old ids', async () => {
    const facts = unwrap(await adapter.getFacts(agentId));
    expect(facts).toEqual([
      {
        id: 'fact_tea',
        agentId,
        content: 'Drinks only lapsang tea',
        category: 'preference',
        confidence: 0.9,
        source: 'user',
        metadata: { userId: 'alice', origin: 'chat' },
        createdAt: created,
        updatedAt: created,
        evidence,
      },
      {
        id: 'fact_office',
        agentId,
        content: 'Works from the Porto office',
        category: 'profile',
        confidence: 0.6,
        source: 'inferred',
        metadata: {},
        createdAt: created,
        updatedAt: created,
        expiresAt: future,
      },
    ]);
    expect(unwrap(await adapter.getFacts(agentId, 'profile')).map((f) => f.id)).toEqual([
      'fact_office',
    ]);
    expect(unwrap(await adapter.searchFacts(agentId, 'LAPSANG')).map((f) => f.id)).toEqual([
      'fact_tea',
    ]);
  });

  it('updates a moved fact under its old id and keeps what it said before', async () => {
    const updated = unwrap(
      await adapter.updateFact('fact_tea', { content: 'Drinks only jasmine tea', confidence: 0.7 })
    );
    expect(updated).toMatchObject({
      id: 'fact_tea',
      content: 'Drinks only jasmine tea',
      confidence: 0.7,
      category: 'preference',
      source: 'user',
      createdAt: created,
      evidence,
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.getTime());

    const history = unwrap(
      await adapter.findItems({ agentId, slots: ['fact:fact_tea'], includeExpired: true })
    );
    expect(history.map((item) => [item.content, item.status])).toEqual([
      ['Drinks only lapsang tea', 'superseded'],
      ['Drinks only jasmine tea', 'active'],
    ]);
    expect(history[0]?.supersededBy).toBe(history[1]?.id);

    const facts = unwrap(await adapter.getFacts(agentId));
    expect(facts.map((f) => [f.id, f.content])).toEqual([
      ['fact_tea', 'Drinks only jasmine tea'],
      ['fact_office', 'Works from the Porto office'],
    ]);
  });

  it('deletes a moved fact with its whole history', async () => {
    unwrap(await adapter.deleteFact('fact_tea'));

    expect(unwrap(await adapter.getFacts(agentId)).map((f) => f.id)).toEqual(['fact_office']);
    expect(
      unwrap(await adapter.findItems({ agentId, slots: ['fact:fact_tea'], includeExpired: true }))
    ).toEqual([]);
    expect(await countOf(client, `${schema}.facts_legacy`)).toBe(3);
  });

  it('moves nothing twice when the migration runs again', async () => {
    await client.query(`CREATE TABLE ${schema}.facts (LIKE ${schema}.facts_legacy)`);
    await client.query(
      `INSERT INTO ${schema}.facts (id, agent_id, content, category, confidence, source)
       VALUES ('fact_late', $1, 'Joined in 2019', 'history', 1, 'user')`,
      [agentId]
    );
    await client.query(
      `UPDATE ${schema}.cogitator_schema_migrations SET version = 2 WHERE component = 'memory'`
    );
    const before = await countOf(client, `${schema}.memory_items`);

    const again = await connected(new PostgresAdapter(config));
    try {
      expect(await tablesOf(client, schema)).toEqual({ facts: false, legacy: true, items: true });
      expect(await countOf(client, `${schema}.facts_legacy`)).toBe(4);
      expect(await countOf(client, `${schema}.memory_items`)).toBe(before + 1);
      expect(unwrap(await again.getFacts(agentId)).map((f) => f.id)).toEqual([
        'fact_late',
        'fact_office',
      ]);
    } finally {
      await again.disconnect();
    }
  });

  it('moves the facts once when processes connect at the same time', async () => {
    await createVersion2Schema(client, racedSchema);
    await insertLegacyFacts(client, racedSchema, agentId);

    const adapters = await Promise.all(
      Array.from({ length: 4 }, () =>
        connected(new PostgresAdapter({ ...config, schema: racedSchema }))
      )
    );
    try {
      expect(await tablesOf(client, racedSchema)).toEqual({
        facts: false,
        legacy: true,
        items: true,
      });
      expect(await countOf(client, `${racedSchema}.memory_items`)).toBe(3);
      for (const raced of adapters) {
        expect(unwrap(await raced.getFacts(agentId)).map((f) => f.id)).toEqual([
          'fact_tea',
          'fact_office',
        ]);
      }
    } finally {
      await Promise.all(adapters.map((raced) => raced.disconnect()));
    }
  });
});

(postgresUrl ? describe : describe.skip)('Memory: Postgres facts over memory items', () => {
  const schema = `items_facts_${tag}`;
  const agentId = `agent-${tag}`;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = await connected(
      new PostgresAdapter({ provider: 'postgres', connectionString: postgresUrl!, schema })
    );
  });

  afterAll(async () => {
    await adapter?.disconnect();
    await dropSchemas(schema);
  });

  it('finds a fact from any source once added, until it expires', async () => {
    const inferred = unwrap(
      await adapter.addFact({
        agentId,
        content: 'Prefers aisle seats',
        category: 'travel',
        confidence: 0.4,
        source: 'inferred',
      })
    );
    const expiring = unwrap(
      await adapter.addFact({
        agentId,
        content: 'Is in Porto this week',
        category: 'travel',
        confidence: 0.8,
        source: 'user',
        expiresAt: new Date(Date.now() + 60_000),
      })
    );
    const gone = unwrap(
      await adapter.addFact({
        agentId,
        content: 'Was in Lisbon last week',
        category: 'travel',
        confidence: 1,
        source: 'system',
        expiresAt: new Date(Date.now() - 60_000),
      })
    );

    const facts = unwrap(await adapter.getFacts(agentId, 'travel'));
    expect(facts.map((f) => f.id)).toEqual([expiring.id, inferred.id]);
    expect(facts.map((f) => f.id)).not.toContain(gone.id);
    expect(unwrap(await adapter.getItem(inferred.id))).toMatchObject({
      status: 'active',
      trust: 'model',
      slot: `fact:${inferred.id}`,
    });
  });

  it('corrects a fact in place when its statement stays the same', async () => {
    const fact = unwrap(
      await adapter.addFact({
        agentId,
        content: 'Owns a bicycle',
        category: 'things',
        confidence: 0.9,
        source: 'user',
        metadata: { userId: 'bob' },
      })
    );

    const updated = unwrap(
      await adapter.updateFact(fact.id, { confidence: 0.3, category: 'assets', evidence })
    );

    expect(updated).toMatchObject({
      id: fact.id,
      confidence: 0.3,
      category: 'assets',
      evidence,
      metadata: { userId: 'bob' },
    });
    const items = unwrap(
      await adapter.findItems({ agentId, slots: [`fact:${fact.id}`], includeExpired: true })
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ verified: true, scope: { agentId, userId: 'bob' } });
  });

  it('keeps the expiry of a fact whose statement changes', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const fact = unwrap(
      await adapter.addFact({
        agentId,
        content: 'Is on call',
        category: 'status',
        confidence: 1,
        source: 'system',
        expiresAt,
      })
    );

    const updated = unwrap(await adapter.updateFact(fact.id, { content: 'Is off call' }));

    expect(updated.expiresAt).toEqual(expiresAt);
    const status = unwrap(await adapter.getFacts(agentId, 'status'));
    expect(status.map((f) => [f.id, f.content])).toEqual([[fact.id, 'Is off call']]);
  });

  it('fails to update a fact that is not there and deletes it quietly', async () => {
    const missing = await adapter.updateFact('fact_missing', { content: 'x' });
    expect(missing.success).toBe(false);
    expect(missing.success || missing.error).toContain('not found');
    expect((await adapter.deleteFact('fact_missing')).success).toBe(true);
  });
});

(mongoUrl ? describe : describe.skip)('Memory: MongoDBAdapter memory files left behind', () => {
  const database = `files_orphan_${tag}`;

  afterAll(async () => {
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    await client.db(database).dropDatabase();
    await client.close();
  });

  it('takes again a place a writer took long ago and never published', async () => {
    const adapter = new MongoDBAdapter({ provider: 'mongodb', uri: mongoUrl!, database });
    const connectedNow = await adapter.connect();
    if (!connectedNow.success) throw new Error(connectedNow.error);
    const scope = { agentId: 'orphans', userId: 'u1' };
    const path = '/memories/notes.md';
    const client = new MongoClient(mongoUrl!);
    await client.connect();
    const places = client
      .db(database)
      .collection<{ _id: string; batchId: string; at: Date }>('memory_file_places');
    await places.insertOne({
      _id: `${fileKeyOf(scope, path)}#1`,
      batchId: 'batch_of_a_dead_writer',
      at: new Date(Date.now() - 120_000),
    });
    await places.insertOne({
      _id: `${fileKeyOf(scope, '/memories/fresh.md')}#1`,
      batchId: 'batch_still_writing',
      at: new Date(),
    });

    const version = (filePath: string) => ({
      id: `v_${randomUUID()}`,
      scope,
      path: filePath,
      sequence: 1,
      content: 'text',
      sha256: 'a'.repeat(64),
      previousId: null,
      author: 'model' as const,
      createdAt: new Date(),
    });
    const taken = await adapter.putFileVersions([version(path)]);
    const fresh = await adapter.putFileVersions([version('/memories/fresh.md')]);

    await client.close();
    await adapter.disconnect();
    expect(taken.success).toBe(true);
    expect(!fresh.success && fresh.error).toBe('memory-file-conflict');
  });
});
