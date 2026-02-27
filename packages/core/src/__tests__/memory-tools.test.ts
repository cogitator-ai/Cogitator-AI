import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryTools } from '../tools/memory-tools';
import type { MemoryToolsConfig } from '../tools/memory-tools';

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

const stubContext = {} as Parameters<ReturnType<typeof createMemoryTools>[0]['execute']>[1];

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
      const remember = tools.find((t) => t.name === 'remember')!;

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
      const remember = tools.find((t) => t.name === 'remember')!;

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
      const remember = tools.find((t) => t.name === 'remember')!;

      await remember.execute(
        { fact: 'John', isCoreFact: true, coreFactKey: 'user_name' },
        stubContext
      );

      expect(mocks.mockCoreFacts.set).toHaveBeenCalledWith('user_name', 'John');
      expect(mocks.mockGraph.addNode).toHaveBeenCalled();
    });

    it('does not save core fact when coreFacts store not provided', async () => {
      const tools = createMemoryTools(createConfig(mocks, { coreFacts: undefined }));
      const remember = tools.find((t) => t.name === 'remember')!;

      const result = await remember.execute(
        { fact: 'John', isCoreFact: true, coreFactKey: 'user_name' },
        stubContext
      );

      expect(result).toEqual({ saved: true, id: 'n1' });
    });

    it('stores category in properties', async () => {
      const tools = createMemoryTools(createConfig(mocks));
      const remember = tools.find((t) => t.name === 'remember')!;

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
      const recall = tools.find((t) => t.name === 'recall')!;

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
      const recall = tools.find((t) => t.name === 'recall')!;

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
      const recall = tools.find((t) => t.name === 'recall')!;

      const result = (await recall.execute({ query: 'anything' }, stubContext)) as {
        results: unknown[];
        coreFacts: Record<string, string>;
      };

      expect(result.coreFacts).toEqual({ user_name: 'John', favorite_color: 'blue' });
    });

    it('returns empty coreFacts when store not provided', async () => {
      const tools = createMemoryTools(createConfig(mocks, { coreFacts: undefined }));
      const recall = tools.find((t) => t.name === 'recall')!;

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
      const forget = tools.find((t) => t.name === 'forget')!;

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

    it('returns zero when no nodes match', async () => {
      const tools = createMemoryTools(createConfig(mocks));
      const forget = tools.find((t) => t.name === 'forget')!;

      const result = (await forget.execute({ query: 'nonexistent' }, stubContext)) as {
        deleted: number;
        items: string[];
      };

      expect(mocks.mockGraph.deleteNode).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: 0, items: [] });
    });
  });
});
