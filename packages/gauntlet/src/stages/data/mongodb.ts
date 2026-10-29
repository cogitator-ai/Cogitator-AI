import { MongoDBAdapter, createMemoryAdapter, unwrap } from '@cogitator-ai/memory';
import type { MongoDBAdapterConfig } from '@cogitator-ai/types';
import { MongoClient, type Document } from 'mongodb';
import type { StageDefinition } from '../../runner/types.js';
import { exerciseThreadStore } from './thread-store.js';
import { uniqueSuffix } from './support.js';

/** The index keys of a collection, by index name. */
async function indexKeys(
  client: MongoClient,
  database: string,
  collection: string
): Promise<Record<string, Document>> {
  const indexes = await client.db(database).collection(collection).indexes();
  return Object.fromEntries(indexes.map((index) => [index.name ?? '', index.key]));
}

/** A thread document as the driver reads it, without the adapter's mapping. */
interface RawThread {
  _id: string;
  metadata?: Record<string, unknown>;
}

/** An entry document as the driver reads it, without the adapter's mapping. */
interface RawEntry {
  _id: string;
  threadId: string;
  message: Record<string, unknown>;
  createdAt: unknown;
  toolResults?: unknown;
}

function sameKeys(actual: Document | undefined, expected: Document): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Thread listing by agent and by recency, both paged by `updatedAt` then `_id`. */
const THREAD_INDEXES: Record<string, Document> = {
  agentId_1_updatedAt_1__id_1: { agentId: 1, updatedAt: 1, _id: 1 },
  updatedAt_1__id_1: { updatedAt: 1, _id: 1 },
};

/** Entries in thread order (`seq` breaks ties of one timestamp) and the branch tree by parent. */
const ENTRY_INDEXES: Record<string, Document> = {
  threadId_1_createdAt_1_seq_1: { threadId: 1, createdAt: 1, seq: 1 },
  threadId_1_parentId_1: { threadId: 1, parentId: 1 },
};

/** `collection.index` for every expected index that is absent or has other keys. */
function missingIndexes(
  collection: string,
  actual: Record<string, Document>,
  expected: Record<string, Document>
): string[] {
  return Object.entries(expected)
    .filter(([name, keys]) => !sameKeys(actual[name], keys))
    .map(([name]) => `${collection}.${name}`);
}

/**
 * MongoDB as the thread store: built from config the way users do, in a database of its own
 * that is dropped when the run ends, and inspected with the driver directly.
 */
export const memoryMongodbStage: StageDefinition = {
  id: 'memory-mongodb',
  title: 'Memory: MongoDB threads',
  description:
    'The MongoDB adapter builds its indexes, keeps ordered threads with tool calls, stores no null for a field left out, survives a reconnect and a failed connect, and the runtime builds it from config.',
  packages: ['@cogitator-ai/core', '@cogitator-ai/memory', '@cogitator-ai/types'],
  requires: [{ kind: 'service', name: 'mongodb' }],
  timeoutMs: 60_000,
  async run(ctx) {
    const uri = ctx.services.mongodb;
    const database = `gauntlet_data_${uniqueSuffix()}`;
    const collectionPrefix = 'gauntlet_';
    const config: MongoDBAdapterConfig = { provider: 'mongodb', uri, database, collectionPrefix };

    const raw = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
    await raw.connect();
    ctx.onCleanup(async () => {
      await raw.db(database).dropDatabase();
      await raw.close();
    });
    const entries = raw.db(database).collection<RawEntry>(`${collectionPrefix}entries`);
    const threads = raw.db(database).collection<RawThread>(`${collectionPrefix}threads`);

    const adapter = await createMemoryAdapter(config);
    ctx.onCleanup(async () => {
      await adapter.disconnect();
    });

    await ctx.check('connects and builds its indexes', async (evidence) => {
      unwrap(await adapter.connect());
      unwrap(await adapter.connect());
      const threadIndexes = await indexKeys(raw, database, `${collectionPrefix}threads`);
      const entryIndexes = await indexKeys(raw, database, `${collectionPrefix}entries`);
      evidence('database', database);
      evidence('threadIndexes', threadIndexes);
      evidence('entryIndexes', entryIndexes);
      const missing = [
        ...missingIndexes('threads', threadIndexes, THREAD_INDEXES),
        ...missingIndexes('entries', entryIndexes, ENTRY_INDEXES),
      ];
      if (missing.length)
        throw new Error(`Indexes missing or with other keys: ${missing.join(', ')}`);
    });

    await exerciseThreadStore(ctx, 'mongodb', adapter);

    const agentId = `gauntlet-mongo-${uniqueSuffix()}`;
    const written = await ctx.check(
      'mongodb: documents keep the entry shape and store no null for a field left out',
      async (evidence) => {
        const thread = unwrap(
          await adapter.createThread(agentId, { source: 'gauntlet', campaign: undefined })
        );
        const question = unwrap(
          await adapter.addEntry({
            threadId: thread.id,
            message: { role: 'user', content: 'Is the Quillon open on Mondays?', name: undefined },
            toolCalls: undefined,
            tokenCount: 8,
          })
        );
        const lookup = unwrap(
          await adapter.addEntry({
            threadId: thread.id,
            message: { role: 'assistant', content: '' },
            toolCalls: [{ id: 'call_hours', name: 'opening_hours', arguments: { day: 'monday' } }],
            toolResults: [{ callId: 'call_hours', name: 'opening_hours', result: null }],
            tokenCount: 4,
            metadata: { step: 1 },
          })
        );

        const storedThread = await threads.findOne({ _id: thread.id });
        const storedQuestion = await entries.findOne({ _id: question.id });
        const storedLookup = await entries.findOne({ _id: lookup.id });
        evidence('threadMetadata', storedThread?.metadata);
        evidence('questionFields', storedQuestion ? Object.keys(storedQuestion) : null);
        evidence('questionMessage', storedQuestion?.message);
        evidence('lookupResults', storedLookup?.toolResults);

        if (!storedThread || !storedQuestion || !storedLookup) {
          throw new Error('A written thread or entry is not in its collection under its id');
        }
        if (Object.keys(storedThread.metadata ?? {}).join() !== 'source') {
          throw new Error(`Thread metadata was stored as ${JSON.stringify(storedThread.metadata)}`);
        }
        const nulls = ['toolCalls', 'toolResults', 'metadata'].filter(
          (field) => field in storedQuestion
        );
        if (nulls.length > 0 || 'name' in storedQuestion.message) {
          throw new Error(
            `Fields left undefined were stored as null: ${[...nulls, ...('name' in storedQuestion.message ? ['message.name'] : [])].join(', ')}`
          );
        }
        if (!(storedQuestion.createdAt instanceof Date) || storedQuestion.threadId !== thread.id) {
          throw new Error(
            `createdAt is stored as ${typeof storedQuestion.createdAt}, threadId as ${storedQuestion.threadId}`
          );
        }

        const readQuestion = unwrap(await adapter.getEntry(question.id));
        const readLookup = unwrap(await adapter.getEntry(lookup.id));
        if (!readQuestion) throw new Error('getEntry does not find the question');
        if (readQuestion.toolCalls !== undefined || readQuestion.metadata !== undefined) {
          throw new Error(`The question read back as ${JSON.stringify(readQuestion)}`);
        }
        if ('name' in readQuestion.message) {
          throw new Error('The question message read back with a name it never had');
        }
        const result = readLookup?.toolResults?.[0];
        if (result?.result !== null || 'error' in result) {
          throw new Error(`The tool result read back as ${JSON.stringify(result)}`);
        }
        if (readLookup?.metadata?.step !== 1) {
          throw new Error(`Entry metadata read back as ${JSON.stringify(readLookup?.metadata)}`);
        }
        return { threadId: thread.id, entryIds: [question.id, lookup.id] };
      }
    );

    await ctx.check(
      'mongodb: a new adapter reads the thread back after a reconnect',
      async (evidence) => {
        unwrap(await adapter.disconnect());
        const reopened = new MongoDBAdapter(config);
        unwrap(await reopened.connect());
        try {
          const read = unwrap(await reopened.getEntries({ threadId: written.threadId }));
          const thread = unwrap(await reopened.getThread(written.threadId));
          evidence(
            'entries',
            read.map((entry) => entry.id)
          );
          evidence('agentId', thread?.agentId);
          if (read.map((entry) => entry.id).join() !== written.entryIds.join()) {
            throw new Error(`The reopened store holds ${read.length} entries, expected 2 in order`);
          }
          if (thread?.agentId !== agentId) throw new Error('The reopened store lost the thread');
          unwrap(await reopened.deleteThread(written.threadId));
        } finally {
          await reopened.disconnect();
        }
        unwrap(await adapter.connect());
        const after = unwrap(await adapter.getThread(written.threadId));
        if (after) throw new Error('The first adapter, reconnected, still sees the deleted thread');
      }
    );

    await ctx.check(
      'mongodb: a failed connect reports the error and the next connect tries again',
      async (evidence) => {
        const port = await ctx.freePort();
        const down = await createMemoryAdapter({
          provider: 'mongodb',
          uri: `mongodb://127.0.0.1:${port}/?serverSelectionTimeoutMS=500`,
          database,
        });
        const first = await down.connect();
        const second = await down.connect();
        const read = await down.getThread('thread_missing');
        evidence('first', first.success ? 'connected' : first.error);
        evidence('second', second.success ? 'connected' : second.error);
        await down.disconnect();
        if (first.success) throw new Error(`Connected to a closed port ${port}`);
        if (second.success) {
          throw new Error(
            'The second connect reported success after the first failed, but the adapter has no database'
          );
        }
        if (read.success) throw new Error('A read on the unconnected adapter succeeded');
      }
    );

    await ctx.check(
      'runtime: memory.adapter "mongodb" builds and connects the store from config',
      async (evidence) => {
        const runtimePrefix = 'runtime_';
        const cogitator = ctx.createCogitator({
          memory: {
            adapter: 'mongodb',
            mongodb: { uri, database, collectionPrefix: runtimePrefix },
          },
        });
        const store = await cogitator.getMemory();
        if (!store)
          throw new Error('getMemory() returned no adapter, the MongoDB memory did not connect');
        const thread = unwrap(await store.createThread('runtime-agent'));
        unwrap(
          await store.addEntry({
            threadId: thread.id,
            message: { role: 'user', content: 'Saved through the runtime.' },
            tokenCount: 4,
          })
        );
        const count = await raw
          .db(database)
          .collection(`${runtimePrefix}entries`)
          .countDocuments({ threadId: thread.id });
        const indexes = await indexKeys(raw, database, `${runtimePrefix}entries`);
        evidence('provider', store.provider);
        evidence('storedEntries', count);
        evidence('indexes', Object.keys(indexes));
        if (store.provider !== 'mongodb')
          throw new Error(`The runtime built a ${store.provider} store`);
        if (count !== 1) throw new Error(`The runtime store wrote ${count} entries to MongoDB`);
        const missing = missingIndexes('entries', indexes, ENTRY_INDEXES);
        if (missing.length) {
          throw new Error(`The runtime store did not build its indexes: ${missing.join(', ')}`);
        }
      }
    );
  },
};
