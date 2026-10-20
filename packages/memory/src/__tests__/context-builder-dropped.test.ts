import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Embedding,
  EmbeddingAdapter,
  EmbeddingService,
  Fact,
  FactAdapter,
  GraphContext,
  GraphNode,
  Message,
} from '@cogitator-ai/types';
import { ContextBuilder } from '../context-builder';
import { InMemoryAdapter } from '../adapters/memory';
import type { GraphContextBuilder } from '../knowledge-graph/graph-context-builder';
import { countEntryTokens, countMessageTokens, countTokens } from '../token-counter';

const embeddings: EmbeddingService = {
  dimensions: 3,
  model: 'fake',
  embed: async () => [1, 0, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
};

function fact(id: string, content: string, metadata?: Record<string, unknown>): Fact {
  const now = new Date();
  return {
    id,
    agentId: 'agent1',
    content,
    category: 'note',
    confidence: 1,
    source: 'user',
    createdAt: now,
    updatedAt: now,
    ...(metadata && { metadata }),
  };
}

function hit(id: string, content: string, metadata?: Record<string, unknown>) {
  const result: Embedding & { score: number } = {
    id,
    sourceId: id,
    sourceType: 'document',
    vector: [1, 0, 0],
    content,
    createdAt: new Date(),
    score: 0.9,
    ...(metadata && { metadata }),
  };
  return result;
}

function node(id: string): GraphNode {
  const now = new Date();
  return {
    id,
    agentId: 'agent1',
    type: 'concept',
    name: id,
    aliases: [],
    properties: {},
    confidence: 1,
    source: 'extracted',
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
  };
}

describe('ContextBuilder budget and what it leaves out', () => {
  let adapter: InMemoryAdapter;
  let threadId: string;

  beforeEach(async () => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();
    const thread = await adapter.createThread('agent1');
    if (!thread.success) throw new Error('no thread');
    threadId = thread.data.id;
  });

  async function addMessages(count: number, content = (i: number) => `message number ${i}`) {
    for (let i = 0; i < count; i++) {
      const message: Message = { role: i % 2 === 0 ? 'user' : 'assistant', content: content(i) };
      await adapter.addEntry({ threadId, message, tokenCount: countMessageTokens(message) });
    }
  }

  it('needs a budget from its config or from build()', async () => {
    const builder = new ContextBuilder({ strategy: 'recent' }, { memoryAdapter: adapter });

    await expect(builder.build({ threadId, agentId: 'agent1' })).rejects.toThrow(/no token budget/);
  });

  it('refuses a budget that is not a positive number', async () => {
    expect(
      () => new ContextBuilder({ strategy: 'recent', maxTokens: 0 }, { memoryAdapter: adapter })
    ).toThrow(/positive number/);
    const builder = new ContextBuilder({ strategy: 'recent' }, { memoryAdapter: adapter });

    await expect(
      builder.build({ threadId, agentId: 'agent1', maxTokens: Number.NaN })
    ).rejects.toThrow(/positive number/);
  });

  it('takes the budget build() is given over its own', async () => {
    await addMessages(60, (i) => `entry ${i} ${'padding words here '.repeat(10)}`);
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 300 },
      { memoryAdapter: adapter }
    );

    const small = await builder.build({ threadId, agentId: 'agent1' });
    const large = await builder.build({ threadId, agentId: 'agent1', maxTokens: 100_000 });

    expect(small.metadata.includedMessageCount).toBeLessThan(60);
    expect(large.metadata.includedMessageCount).toBe(60);
    expect(large.truncated).toBe(false);
  });

  it('reserves a tenth of the budget build() is given', async () => {
    await addMessages(1, () => 'x'.repeat(4000));
    const builder = new ContextBuilder({ strategy: 'recent' }, { memoryAdapter: adapter });
    const entryTokens = countMessageTokens({ role: 'user', content: 'x'.repeat(4000) });

    const tight = await builder.build({
      threadId,
      agentId: 'agent1',
      maxTokens: Math.ceil(entryTokens / 0.95),
    });
    const roomy = await builder.build({
      threadId,
      agentId: 'agent1',
      maxTokens: Math.ceil(entryTokens / 0.85),
    });

    expect(tight.metadata.includedMessageCount).toBe(0);
    expect(roomy.metadata.includedMessageCount).toBe(1);
  });

  it('lists the history entries left out, oldest first, with their tokens', async () => {
    await addMessages(40, (i) => `entry ${i} ${'padding words here '.repeat(10)}`);
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 500 },
      { memoryAdapter: adapter }
    );

    const result = await builder.build({ threadId, agentId: 'agent1' });
    const all = await adapter.getEntries({ threadId });
    if (!all.success) throw new Error('no entries');

    const kept = result.metadata.includedMessageCount;
    expect(kept).toBeGreaterThan(0);
    expect(result.dropped.entries).toEqual(all.data.slice(0, 40 - kept));
    expect(result.dropped.tokenCount).toBe(
      result.dropped.entries.reduce((sum, entry) => sum + countEntryTokens(entry), 0)
    );
    expect(result.truncated).toBe(true);
  });

  it('leaves nothing out when everything fits', async () => {
    await addMessages(3);
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 4000 },
      { memoryAdapter: adapter }
    );

    const result = await builder.build({ threadId, agentId: 'agent1' });

    expect(result.dropped).toEqual({
      entries: [],
      facts: [],
      semanticResults: [],
      graphNodes: [],
      tokenCount: 0,
    });
    expect(result.truncated).toBe(false);
  });

  it('lists the entries a relevant selection left out', async () => {
    await addMessages(30, (i) => `entry ${i} ${'padding words here '.repeat(10)}`);
    const builder = new ContextBuilder(
      { strategy: 'relevant', maxTokens: 600 },
      { memoryAdapter: adapter, embeddingService: embeddings }
    );

    const result = await builder.build({ threadId, agentId: 'agent1', currentInput: 'entry' });

    const keptCount = result.metadata.includedMessageCount;
    expect(keptCount).toBeGreaterThan(0);
    expect(result.dropped.entries).toHaveLength(30 - keptCount);
    const kept = new Set(result.messages.map((m) => m.content));
    for (const entry of result.dropped.entries) {
      expect(kept.has(entry.message.content)).toBe(false);
    }
  });

  it('lists the facts that did not fit, but not those of other users', async () => {
    const long = (n: number) => `fact ${n}: ${'remember this detail '.repeat(30)}`;
    const facts = [
      fact('f1', long(1)),
      fact('f2', long(2)),
      fact('f3', long(3)),
      fact('f4', 'belongs to someone else', { userId: 'other' }),
    ];
    const factAdapter = {
      getFacts: vi.fn(async () => ({ success: true as const, data: facts })),
    } as unknown as FactAdapter;
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 2000, includeFacts: true },
      { memoryAdapter: adapter, factAdapter }
    );

    const result = await builder.build({ threadId, agentId: 'agent1', userId: 'me' });

    expect(result.facts.map((f) => f.id)).toEqual(['f1']);
    expect(result.dropped.facts.map((f) => f.id)).toEqual(['f2', 'f3']);
    expect(result.dropped.tokenCount).toBe(
      countTokens(`- ${long(2)}`) + countTokens(`- ${long(3)}`)
    );
  });

  it('lists the search results that did not fit', async () => {
    const long = (n: number) => `document ${n}: ${'relevant passage text '.repeat(30)}`;
    const embeddingAdapter: EmbeddingAdapter = {
      addEmbedding: vi.fn(),
      search: vi.fn(async () => ({
        success: true as const,
        data: [hit('e1', long(1)), hit('e2', long(2)), hit('e3', 'private', { userId: 'other' })],
      })),
      deleteEmbedding: vi.fn(),
      deleteBySource: vi.fn(),
    };
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 2000, includeSemanticContext: true },
      { memoryAdapter: adapter, embeddingAdapter, embeddingService: embeddings }
    );

    const result = await builder.build({
      threadId,
      agentId: 'agent1',
      userId: 'me',
      currentInput: 'find it',
    });

    expect(result.semanticResults.map((r) => r.id)).toEqual(['e1']);
    expect(result.dropped.semanticResults.map((r) => r.id)).toEqual(['e2']);
  });

  it('lists the graph nodes cut to fit the budget', async () => {
    const nodes = ['a', 'b', 'c', 'd'].map(node);
    const full: GraphContext = { nodes, edges: [], formattedContext: 'all four', tokenCount: 1000 };
    const cut: GraphContext = {
      nodes: nodes.slice(0, 1),
      edges: [],
      formattedContext: 'one',
      tokenCount: 100,
    };
    const graph = {
      buildContext: vi.fn(async (_agent: string, _input: string, options: { maxNodes?: number }) =>
        options.maxNodes === undefined ? full : cut
      ),
    } as unknown as GraphContextBuilder;
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 2000, includeGraphContext: true },
      { memoryAdapter: adapter, graphContextBuilder: graph }
    );

    const result = await builder.build({ threadId, agentId: 'agent1', currentInput: 'who' });

    expect(result.graphContext?.nodes.map((n) => n.id)).toEqual(['a']);
    expect(result.dropped.graphNodes.map((n) => n.id)).toEqual(['b', 'c', 'd']);
    expect(result.dropped.tokenCount).toBe(900);
  });
});
