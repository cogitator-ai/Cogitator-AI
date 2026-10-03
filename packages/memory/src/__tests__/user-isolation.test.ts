import { describe, it, expect } from 'vitest';
import type { EmbeddingService, Fact, FactAdapter, MemoryResult } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { InMemoryEmbeddingAdapter } from '../adapters/memory-embedding';
import { ContextBuilder } from '../context-builder';
import { GraphContextBuilder } from '../knowledge-graph/graph-context-builder';
import { SQLiteGraphAdapter } from '../knowledge-graph/sqlite-graph-adapter';

const embeddings: EmbeddingService = {
  model: 'fake',
  dimensions: 3,
  embed: async () => [1, 0, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
};

async function userEmbeddings(): Promise<InMemoryEmbeddingAdapter> {
  const adapter = new InMemoryEmbeddingAdapter();
  const add = (sourceId: string, content: string, metadata?: Record<string, unknown>) =>
    adapter.addEmbedding({ sourceId, sourceType: 'fact', vector: [1, 0, 0], content, metadata });
  await add('alice', 'alice pays with a corporate card', { agentId: 'support', userId: 'alice' });
  await add('bob', 'bob lives in Lisbon', { agentId: 'support', userId: 'bob' });
  await add('handbook', 'refunds take five days', { agentId: 'support' });
  return adapter;
}

function factsOf(facts: Array<Pick<Fact, 'content' | 'metadata'>>): FactAdapter {
  const all: Fact[] = facts.map((fact, i) => ({
    id: `f${i}`,
    agentId: 'support',
    category: 'profile',
    confidence: 1,
    source: 'user',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fact,
  }));
  const unused = async (): Promise<MemoryResult<never>> => ({ success: false, error: 'unused' });
  return {
    getFacts: async (agentId) => ({
      success: true,
      data: all.filter((f) => f.agentId === agentId),
    }),
    addFact: unused,
    updateFact: unused,
    deleteFact: unused,
    searchFacts: unused,
  };
}

async function builderFor(deps: Partial<ConstructorParameters<typeof ContextBuilder>[1]>) {
  const memoryAdapter = new InMemoryAdapter();
  await memoryAdapter.createThread('support', {}, 't1');
  return new ContextBuilder(
    {
      maxTokens: 4000,
      strategy: 'recent',
      includeFacts: true,
      includeSemanticContext: true,
      includeGraphContext: true,
    },
    { memoryAdapter, ...deps }
  );
}

describe('memory isolation between users of one agent', () => {
  it('searches only the embeddings of the user and those of no user', async () => {
    const adapter = await userEmbeddings();

    const semantic = await adapter.search({ vector: [1, 0, 0], filter: { userId: 'alice' } });
    const keyword = await adapter.keywordSearch({ query: 'bob', filter: { userId: 'alice' } });

    expect(semantic.success && semantic.data.map((r) => r.sourceId).sort()).toEqual([
      'alice',
      'handbook',
    ]);
    expect(keyword.success && keyword.data).toEqual([]);
  });

  it("finds a user's memory even when other users' memories crowd the index", async () => {
    const adapter = new InMemoryEmbeddingAdapter();
    for (let i = 0; i < 40; i++) {
      await adapter.addEmbedding({
        sourceId: `other-${i}`,
        sourceType: 'fact',
        vector: [1, 0, 0],
        content: `other user note ${i}`,
        metadata: { userId: `user-${i}` },
      });
    }
    await adapter.addEmbedding({
      sourceId: 'mine',
      sourceType: 'fact',
      vector: [0.9, 0.1, 0],
      content: 'my own note',
      metadata: { userId: 'alice' },
    });
    const builder = await builderFor({ embeddingAdapter: adapter, embeddingService: embeddings });

    const context = await builder.build({
      threadId: 't1',
      agentId: 'support',
      userId: 'alice',
      currentInput: 'what did I note?',
    });

    expect(context.semanticResults.map((r) => r.sourceId)).toEqual(['mine']);
  });

  it('puts only the user’s own and shared memories into their context', async () => {
    const builder = await builderFor({
      embeddingAdapter: await userEmbeddings(),
      embeddingService: embeddings,
      factAdapter: factsOf([
        { content: 'Alice prefers email', metadata: { userId: 'alice' } },
        { content: 'Bob prefers phone calls', metadata: { userId: 'bob' } },
        { content: 'Support hours are 9 to 5' },
      ]),
    });

    const alice = await builder.build({
      threadId: 't1',
      agentId: 'support',
      userId: 'alice',
      currentInput: 'how do I pay?',
    });
    const system = String(alice.messages[0].content);

    expect(alice.facts.map((f) => f.content).sort()).toEqual([
      'Alice prefers email',
      'Support hours are 9 to 5',
    ]);
    expect(alice.semanticResults.map((r) => r.sourceId).sort()).toEqual(['alice', 'handbook']);
    expect(system).toContain('corporate card');
    expect(system).not.toContain('Bob');
    expect(system).not.toContain('Lisbon');
  });

  it('keeps user-owned memories out of a context built for no user', async () => {
    const builder = await builderFor({
      embeddingAdapter: await userEmbeddings(),
      embeddingService: embeddings,
      factAdapter: factsOf([
        { content: 'Alice prefers email', metadata: { userId: 'alice' } },
        { content: 'Support hours are 9 to 5' },
      ]),
    });

    const anonymous = await builder.build({
      threadId: 't1',
      agentId: 'support',
      currentInput: 'refunds?',
    });

    expect(anonymous.facts.map((f) => f.content)).toEqual(['Support hours are 9 to 5']);
    expect(anonymous.semanticResults.map((r) => r.sourceId)).toEqual(['handbook']);
  });

  it("leaves other users' knowledge graph nodes and their edges out", async () => {
    const graph = new SQLiteGraphAdapter({ path: ':memory:' });
    await graph.initialize();
    const node = (name: string, userId?: string) =>
      graph.addNode({
        agentId: 'support',
        type: 'person',
        name,
        aliases: [],
        properties: {},
        confidence: 1,
        source: 'user',
        ...(userId && { metadata: { userId } }),
      });
    const acme = await node('Acme');
    const alice = await node('Alice', 'alice');
    const bob = await node('Bob', 'bob');
    if (!acme.success || !alice.success || !bob.success) throw new Error('graph setup failed');
    for (const person of [alice.data, bob.data]) {
      await graph.addEdge({
        agentId: 'support',
        sourceNodeId: person.id,
        targetNodeId: acme.data.id,
        type: 'works_at',
        weight: 1,
        bidirectional: false,
        properties: {},
        confidence: 1,
        source: 'user',
      });
    }
    const builder = new GraphContextBuilder(graph);

    const context = await builder.buildContext('support', 'Acme Alice Bob', { userId: 'alice' });

    expect(context.nodes.map((n) => n.name).sort()).toEqual(['Acme', 'Alice']);
    expect(context.edges.map((e) => e.sourceNodeId)).toEqual([alice.data.id]);
    expect(context.formattedContext).not.toContain('Bob');
    await graph.close();
  });
});
