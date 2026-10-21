import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryTools } from '../tools/memory-tools';
import type { MemoryToolsConfig } from '../tools/memory-tools';
import { createToolContext } from './helpers/tool-context';
import { InMemoryAdapter, MemoryItems } from '@cogitator-ai/memory';

/** The memory tools by name; createMemoryTools returns them as a typed tuple. */
function byName(tools: ReturnType<typeof createMemoryTools>) {
  const [remember, recall, forget] = tools;
  return { remember, recall, forget };
}

function createMocks() {
  const mockGraph = {
    addNode: vi.fn().mockResolvedValue({
      success: true,
      data: {
        id: 'n1',
        name: 'Test fact',
        agentId: 'a1',
        type: 'concept',
        aliases: [],
        properties: {},
        confidence: 1,
        source: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        accessCount: 0,
      },
    }),
    queryNodes: vi.fn().mockResolvedValue({ success: true, data: [] }),
    searchNodesSemantic: vi.fn().mockResolvedValue({ success: true, data: [] }),
    deleteNode: vi.fn().mockResolvedValue({ success: true }),
  };

  const mockCoreFacts = {
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    getAll: vi.fn().mockResolvedValue({}),
  };

  const mockEmbeddingFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

  return { mockGraph, mockCoreFacts, mockEmbeddingFn };
}

function createConfig(
  mocks: ReturnType<typeof createMocks>,
  overrides?: Partial<MemoryToolsConfig>
): MemoryToolsConfig {
  return {
    graphAdapter: mocks.mockGraph as unknown as MemoryToolsConfig['graphAdapter'],
    coreFacts: mocks.mockCoreFacts as unknown as MemoryToolsConfig['coreFacts'],
    embeddingFn: mocks.mockEmbeddingFn,
    agentId: 'a1',
    ...overrides,
  };
}

const stubContext = createToolContext();

describe('createMemoryTools', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('returns 3 tools: remember, recall, forget', () => {
    const tools = createMemoryTools(createConfig(mocks));
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['remember', 'recall', 'forget']);
  });

  describe('remember', () => {
    it('saves fact to graph with embedding', async () => {
      const tools = createMemoryTools(createConfig(mocks));
      const remember = byName(tools).remember;

      const result = await remember.execute(
        { fact: 'My birthday is March 15', category: 'personal' },
        stubContext
      );

      expect(mocks.mockEmbeddingFn).toHaveBeenCalledWith('My birthday is March 15');
      expect(mocks.mockGraph.addNode).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'a1',
          name: 'My birthday is March 15',
          type: 'concept',
          embedding: [0.1, 0.2, 0.3],
          source: 'user',
        })
      );
      expect(result).toEqual({ saved: true, id: 'n1' });
    });

    it('saves fact without embedding when embeddingFn not provided', async () => {
      const tools = createMemoryTools(createConfig(mocks, { embeddingFn: undefined }));
      const remember = byName(tools).remember;

      const result = await remember.execute({ fact: 'Some fact' }, stubContext);

      expect(mocks.mockGraph.addNode).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Some fact',
          embedding: undefined,
        })
      );
      expect(result).toEqual({ saved: true, id: 'n1' });
    });

    it('saves core fact when isCoreFact + coreFactKey provided', async () => {
      const tools = createMemoryTools(createConfig(mocks));
      const remember = byName(tools).remember;

      await remember.execute(
        { fact: 'John', isCoreFact: true, coreFactKey: 'user_name' },
        stubContext
      );

      expect(mocks.mockCoreFacts.set).toHaveBeenCalledWith('user_name', 'John');
      expect(mocks.mockGraph.addNode).toHaveBeenCalled();
    });

    it('rejects core facts without a key before writing memory', async () => {
      const tools = createMemoryTools(createConfig(mocks));
      const remember = byName(tools).remember;

      const result = await remember.execute({ fact: 'John', isCoreFact: true }, stubContext);

      expect(result).toEqual({
        saved: false,
        error: 'coreFactKey is required when isCoreFact is true',
      });
      expect(mocks.mockGraph.addNode).not.toHaveBeenCalled();
      expect(mocks.mockCoreFacts.set).not.toHaveBeenCalled();
    });

    it('returns failure when graph persistence fails', async () => {
      mocks.mockGraph.addNode.mockResolvedValueOnce({
        success: false,
        error: 'graph unavailable',
      });
      const tools = createMemoryTools(createConfig(mocks));
      const remember = byName(tools).remember;

      const result = await remember.execute(
        { fact: 'John', isCoreFact: true, coreFactKey: 'user_name' },
        stubContext
      );

      expect(result).toEqual({ saved: false, error: 'graph unavailable' });
      expect(mocks.mockCoreFacts.set).not.toHaveBeenCalled();
    });

    it('does not save core fact when coreFacts store not provided', async () => {
      const tools = createMemoryTools(createConfig(mocks, { coreFacts: undefined }));
      const remember = byName(tools).remember;

      const result = await remember.execute(
        { fact: 'John', isCoreFact: true, coreFactKey: 'user_name' },
        stubContext
      );

      expect(result).toEqual({ saved: true, id: 'n1' });
    });

    it('stores category in properties', async () => {
      const tools = createMemoryTools(createConfig(mocks));
      const remember = byName(tools).remember;

      await remember.execute({ fact: 'Likes pizza', category: 'preferences' }, stubContext);

      expect(mocks.mockGraph.addNode).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: { category: 'preferences' },
        })
      );
    });
  });

  describe('recall', () => {
    it('performs semantic search when embeddingFn available', async () => {
      mocks.mockGraph.searchNodesSemantic.mockResolvedValueOnce({
        success: true,
        data: [
          {
            id: 'n1',
            name: 'Birthday is March 15',
            description: undefined,
            score: 0.95,
          },
        ],
      });

      const tools = createMemoryTools(createConfig(mocks));
      const recall = byName(tools).recall;

      const result = (await recall.execute({ query: 'birthday' }, stubContext)) as {
        results: Array<{ fact: string; type: string; confidence: number }>;
        coreFacts: Record<string, string>;
      };

      expect(mocks.mockEmbeddingFn).toHaveBeenCalledWith('birthday');
      expect(mocks.mockGraph.searchNodesSemantic).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'a1',
          vector: [0.1, 0.2, 0.3],
        })
      );
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        fact: 'Birthday is March 15',
        type: 'semantic',
        confidence: 0.95,
      });
    });

    it('falls back to text search when embeddingFn not available', async () => {
      mocks.mockGraph.queryNodes.mockResolvedValueOnce({
        success: true,
        data: [{ id: 'n2', name: 'Old birthday note' }],
      });

      const tools = createMemoryTools(createConfig(mocks, { embeddingFn: undefined }));
      const recall = byName(tools).recall;

      const result = (await recall.execute({ query: 'birthday' }, stubContext)) as {
        results: Array<{ fact: string; type: string; confidence: number }>;
        coreFacts: Record<string, string>;
      };

      expect(mocks.mockGraph.queryNodes).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'a1',
          namePattern: 'birthday',
        })
      );
      expect(result.results).toHaveLength(1);
      expect(result.results[0].type).toBe('text');
    });

    it('includes core facts in results', async () => {
      mocks.mockCoreFacts.getAll.mockResolvedValueOnce({
        user_name: 'John',
        favorite_color: 'blue',
      });

      const tools = createMemoryTools(createConfig(mocks));
      const recall = byName(tools).recall;

      const result = (await recall.execute({ query: 'anything' }, stubContext)) as {
        results: unknown[];
        coreFacts: Record<string, string>;
      };

      expect(result.coreFacts).toEqual({ user_name: 'John', favorite_color: 'blue' });
    });

    it('returns empty coreFacts when store not provided', async () => {
      const tools = createMemoryTools(createConfig(mocks, { coreFacts: undefined }));
      const recall = byName(tools).recall;

      const result = (await recall.execute({ query: 'test' }, stubContext)) as {
        results: unknown[];
        coreFacts: Record<string, string>;
      };

      expect(result.coreFacts).toEqual({});
    });
  });

  describe('forget', () => {
    it('deletes matched nodes from graph', async () => {
      mocks.mockGraph.queryNodes.mockResolvedValueOnce({
        success: true,
        data: [
          { id: 'n1', name: 'old fact A' },
          { id: 'n2', name: 'old fact B' },
        ],
      });

      const tools = createMemoryTools(createConfig(mocks));
      const forget = byName(tools).forget;

      const result = (await forget.execute({ query: 'old fact' }, stubContext)) as {
        deleted: number;
        items: string[];
      };

      expect(mocks.mockGraph.queryNodes).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'a1',
          namePattern: 'old fact',
        })
      );
      expect(mocks.mockGraph.deleteNode).toHaveBeenCalledTimes(2);
      expect(mocks.mockGraph.deleteNode).toHaveBeenCalledWith('n1');
      expect(mocks.mockGraph.deleteNode).toHaveBeenCalledWith('n2');
      expect(result).toEqual({
        deleted: 2,
        items: ['old fact A', 'old fact B'],
      });
    });

    it('reports delete failures without counting them as deleted', async () => {
      mocks.mockGraph.queryNodes.mockResolvedValueOnce({
        success: true,
        data: [
          { id: 'n1', name: 'old fact A' },
          { id: 'n2', name: 'old fact B' },
        ],
      });
      mocks.mockGraph.deleteNode
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'delete failed' });

      const tools = createMemoryTools(createConfig(mocks));
      const forget = byName(tools).forget;

      const result = await forget.execute({ query: 'old fact' }, stubContext);

      expect(result).toEqual({
        deleted: 1,
        items: ['old fact A'],
        failed: [{ id: 'n2', name: 'old fact B', error: 'delete failed' }],
      });
    });

    it('returns zero when no nodes match', async () => {
      const tools = createMemoryTools(createConfig(mocks));
      const forget = byName(tools).forget;

      const result = (await forget.execute({ query: 'nonexistent' }, stubContext)) as {
        deleted: number;
        items: string[];
      };

      expect(mocks.mockGraph.deleteNode).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, items: [] });
    });
  });

  describe('grounded in the conversation', () => {
    async function conversation() {
      const adapter = new InMemoryAdapter({ provider: 'memory' });
      await adapter.createThread('a1', {}, 't1');
      await adapter.addEntry({
        threadId: 't1',
        message: { role: 'user', content: 'Please remember: my sister is called Rita.' },
        tokenCount: 1,
      });
      await adapter.addEntry({
        threadId: 't1',
        message: { role: 'assistant', content: 'Your favourite colour must be blue.' },
        tokenCount: 1,
      });
      return { adapter, items: new MemoryItems({ adapter }) };
    }
    const context = createToolContext({ threadId: 't1', userId: 'u1' });

    it("keeps a fact as the user's when its quote is in a user message", async () => {
      const { adapter, items } = await conversation();
      const { remember } = byName(
        createMemoryTools(createConfig(mocks, { items, memory: adapter }))
      );

      const result = await remember.execute(
        {
          fact: "The user's sister is called Rita",
          quote: 'my sister is called Rita',
          isCoreFact: true,
          coreFactKey: 'sister',
        },
        context
      );

      expect(result).toMatchObject({ saved: true, status: 'active' });
      expect(mocks.mockGraph.addNode).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'user', confidence: 1 })
      );
      expect(mocks.mockCoreFacts.set).toHaveBeenCalledWith(
        'sister',
        "The user's sister is called Rita"
      );
      const [kept] = await items.query({ scope: { agentId: 'a1', userId: 'u1' } });
      expect(kept).toMatchObject({ trust: 'user', verified: true, status: 'active' });
    });

    it('keeps a fact only as a suggestion when the user never said it', async () => {
      const { adapter, items } = await conversation();
      const { remember } = byName(
        createMemoryTools(createConfig(mocks, { items, memory: adapter }))
      );

      const result = await remember.execute(
        {
          fact: "The user's favourite colour is blue",
          quote: 'Your favourite colour must be blue',
          isCoreFact: true,
          coreFactKey: 'colour',
        },
        context
      );

      expect(result).toMatchObject({ saved: true, status: 'suggested', coreFact: false });
      expect(mocks.mockGraph.addNode).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'inferred' })
      );
      expect(mocks.mockCoreFacts.set).not.toHaveBeenCalled();
      expect(await items.query({ scope: { agentId: 'a1', userId: 'u1' } })).toEqual([]);
    });

    it('recalls memory items and lets forgotten ones go', async () => {
      const { adapter, items } = await conversation();
      const tools = byName(createMemoryTools(createConfig(mocks, { items, memory: adapter })));
      await tools.remember.execute(
        { fact: 'Sister: Rita', quote: 'my sister is called Rita' },
        context
      );

      const recalled = await tools.recall.execute({ query: 'rita' }, context);
      expect(recalled.results).toContainEqual(
        expect.objectContaining({ fact: 'Sister: Rita', type: 'memory' })
      );

      const forgotten = await tools.forget.execute({ query: 'rita' }, context);
      expect(forgotten).toMatchObject({ forgotten: ['Sister: Rita'] });
      expect(await items.query({ scope: { agentId: 'a1', userId: 'u1' }, text: 'rita' })).toEqual(
        []
      );
    });
  });

  describe('forget', () => {
    it("lets go only the run's own items that hold the words", async () => {
      const adapter = new InMemoryAdapter({ provider: 'memory' });
      const items = new MemoryItems({ adapter });
      const fact = (content: string, scope: Record<string, string>) => ({
        kind: 'fact' as const,
        content,
        trust: 'system' as const,
        confidence: 1,
        evidence: [],
        saidAt: new Date(),
        sessionAt: new Date(),
        scope: { agentId: 'a1', ...scope },
      });
      await items.write([
        fact('Pricing is per seat', {}),
        fact('My pricing tier is pro', { userId: 'u1' }),
        fact('Bo likes apricots', { userId: 'u1' }),
        fact('Bo pays for pricing', { userId: 'u2' }),
      ]);
      const { forget } = byName(createMemoryTools(createConfig(mocks, { items })));

      const result = await forget.execute(
        { query: 'pricing' },
        createToolContext({ userId: 'u1', threadId: 't1' })
      );

      expect(result).toMatchObject({ forgotten: ['My pricing tier is pro'] });
      const left = await items.query({ scope: { agentId: 'a1', userId: 'u1' } });
      expect(left.map((item) => item.content).sort()).toEqual([
        'Bo likes apricots',
        'Pricing is per seat',
      ]);
      expect(
        (await forget.execute({ query: 'a' }, createToolContext({ userId: 'u1' }))).forgotten
      ).toBeUndefined();
    });
  });
});
