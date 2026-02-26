import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vectorSearch } from '../tools/vector-search';

vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockEnd = vi.fn().mockResolvedValue(undefined);

  class Client {
    query = mockQuery;
    connect = mockConnect;
    end = mockEnd;
  }

  return {
    default: { Client },
    Client,
  };
});

describe('vector-search tool', () => {
  const originalEnv = { ...process.env };
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('has correct metadata', () => {
    expect(vectorSearch.name).toBe('vector_search');
    expect(vectorSearch.description).toContain('semantic search');
    expect(vectorSearch.category).toBe('database');
    expect(vectorSearch.tags).toContain('vector');
    expect(vectorSearch.tags).toContain('embedding');
  });

  describe('provider detection', () => {
    it('returns error when no embedding provider detected', async () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.OLLAMA_BASE_URL;
      delete process.env.OLLAMA_HOST;
      process.env.DATABASE_URL = 'postgres://localhost/db';

      const result = await vectorSearch.execute({ query: 'test query' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('No embedding provider');
    });

    it('detects OpenAI provider from API key', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      process.env.DATABASE_URL = 'postgres://localhost/db';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array(1536).fill(0.1) }],
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({ query: 'test' });

      expect((result as { provider: string }).provider).toBe('openai');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key',
          }),
        })
      );
    });

    it('detects Ollama provider from OLLAMA_BASE_URL', async () => {
      delete process.env.OPENAI_API_KEY;
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
      process.env.DATABASE_URL = 'postgres://localhost/db';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            embedding: Array(768).fill(0.1),
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({ query: 'test' });

      expect((result as { provider: string }).provider).toBe('ollama');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/embeddings',
        expect.any(Object)
      );
    });

    it('detects Google provider from API key', async () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OLLAMA_BASE_URL;
      process.env.GOOGLE_API_KEY = 'google-test-key';
      process.env.DATABASE_URL = 'postgres://localhost/db';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            embedding: { values: Array(768).fill(0.1) },
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({ query: 'test' });

      expect((result as { provider: string }).provider).toBe('google');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('generativelanguage.googleapis.com'),
        expect.any(Object)
      );
    });

    it('allows explicit provider override', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.GOOGLE_API_KEY = 'google-key';
      process.env.DATABASE_URL = 'postgres://localhost/db';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            embedding: { values: Array(768).fill(0.1) },
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({
        query: 'test',
        embeddingProvider: 'google',
      });

      expect((result as { provider: string }).provider).toBe('google');
    });
  });

  describe('database connection', () => {
    it('returns error when no database connection', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      delete process.env.DATABASE_URL;

      const result = await vectorSearch.execute({ query: 'test' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('No database connection');
    });

    it('uses DATABASE_URL env var', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.DATABASE_URL = 'postgres://user:pass@localhost/db';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array(1536).fill(0.1) }],
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await vectorSearch.execute({ query: 'test' });

      expect(mockInstance.connect).toHaveBeenCalled();
    });

    it('uses provided connectionString', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array(1536).fill(0.1) }],
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await vectorSearch.execute({
        query: 'test',
        connectionString: 'postgres://custom:conn@host/db',
      });

      expect(mockInstance.connect).toHaveBeenCalled();
    });
  });

  describe('OpenAI embeddings', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      process.env.DATABASE_URL = 'postgres://localhost/db';
    });

    it('uses default model text-embedding-3-small', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array(1536).fill(0.1) }],
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({ query: 'test' });

      expect((result as { model: string }).model).toBe('text-embedding-3-small');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.model).toBe('text-embedding-3-small');
    });

    it('allows custom embedding model', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array(3072).fill(0.1) }],
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({
        query: 'test',
        embeddingModel: 'text-embedding-3-large',
      });

      expect((result as { model: string }).model).toBe('text-embedding-3-large');
    });

    it('handles OpenAI API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Invalid API key'),
      });

      const result = await vectorSearch.execute({ query: 'test' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('OpenAI embedding error');
    });
  });

  describe('Ollama embeddings', () => {
    beforeEach(() => {
      delete process.env.OPENAI_API_KEY;
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
      process.env.DATABASE_URL = 'postgres://localhost/db';
    });

    it('uses default model nomic-embed-text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            embedding: Array(768).fill(0.1),
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({ query: 'test' });

      expect((result as { model: string }).model).toBe('nomic-embed-text');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.model).toBe('nomic-embed-text');
      expect(fetchBody.prompt).toBe('test');
    });

    it('handles Ollama API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Model not found'),
      });

      const result = await vectorSearch.execute({ query: 'test' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Ollama embedding error');
    });
  });

  describe('Google embeddings', () => {
    beforeEach(() => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OLLAMA_BASE_URL;
      process.env.GOOGLE_API_KEY = 'google-test-key';
      process.env.DATABASE_URL = 'postgres://localhost/db';
    });

    it('uses default model text-embedding-004', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            embedding: { values: Array(768).fill(0.1) },
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({ query: 'test' });

      expect((result as { model: string }).model).toBe('text-embedding-004');
    });

    it('constructs correct Google API URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            embedding: { values: Array(768).fill(0.1) },
          }),
      });

      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await vectorSearch.execute({ query: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('text-embedding-004:embedContent'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('key=google-test-key'),
        expect.any(Object)
      );
    });

    it('handles Google API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Invalid API key'),
      });

      const result = await vectorSearch.execute({ query: 'test' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Google embedding error');
    });
  });

  describe('pgvector search', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.DATABASE_URL = 'postgres://localhost/db';

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array(1536).fill(0.1) }],
          }),
      });
    });

    it('searches default collection "documents"', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: '1', content: 'test doc', metadata: {}, similarity: 0.9 }],
      });

      await vectorSearch.execute({ query: 'test' });

      const queryCall = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(queryCall).toContain('FROM documents');
    });

    it('uses custom collection name', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await vectorSearch.execute({
        query: 'test',
        collection: 'my_vectors',
      });

      const queryCall = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(queryCall).toContain('FROM my_vectors');
    });

    it('applies topK limit', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await vectorSearch.execute({
        query: 'test',
        topK: 10,
      });

      const queryParams = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(queryParams).toContain(10);
    });

    it('applies similarity threshold', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await vectorSearch.execute({
        query: 'test',
        threshold: 0.8,
      });

      const queryCall = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(queryCall).toContain('>= 0.8');
    });

    it('applies metadata filter', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await vectorSearch.execute({
        query: 'test',
        filter: { category: 'science' },
      });

      const queryCall = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(queryCall).toContain('metadata @>');
    });

    it('returns formatted search results', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          {
            id: 'doc-1',
            content: 'First document content',
            metadata: { source: 'web' },
            similarity: 0.95,
          },
          {
            id: 'doc-2',
            content: 'Second document',
            metadata: { source: 'pdf' },
            similarity: 0.85,
          },
        ],
      });

      const result = await vectorSearch.execute({ query: 'search query' });

      expect(result).toMatchObject({
        query: 'search query',
        provider: 'openai',
        model: 'text-embedding-3-small',
        results: [
          {
            id: 'doc-1',
            content: 'First document content',
            metadata: { source: 'web' },
            similarity: 0.95,
          },
          {
            id: 'doc-2',
            content: 'Second document',
            metadata: { source: 'pdf' },
            similarity: 0.85,
          },
        ],
      });
    });

    it('handles database errors', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('relation "documents" does not exist')
      );

      const result = await vectorSearch.execute({ query: 'test' });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('does not exist');
      expect((result as { query: string }).query).toBe('test');
    });

    it('cleans up connection after search', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await vectorSearch.execute({ query: 'test' });

      expect(mockInstance.end).toHaveBeenCalled();
    });

    it('cleans up connection on error', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

      await vectorSearch.execute({ query: 'test' });

      expect(mockInstance.end).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.DATABASE_URL = 'postgres://localhost/db';

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array(1536).fill(0.1) }],
          }),
      });
    });

    it('handles empty search results', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({ query: 'very obscure query' });

      expect((result as { results: unknown[] }).results).toHaveLength(0);
    });

    it('handles null content in results', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: '1', content: null, metadata: null, similarity: 0.9 }],
      });

      const result = await vectorSearch.execute({ query: 'test' });

      expect((result as { results: Array<{ content: string }> }).results[0].content).toBe('');
      expect((result as { results: Array<{ metadata: object }> }).results[0].metadata).toEqual({});
    });

    it('converts similarity to number', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ id: '1', content: 'test', metadata: {}, similarity: '0.9' }],
      });

      const result = await vectorSearch.execute({ query: 'test' });

      expect(
        typeof (result as { results: Array<{ similarity: number }> }).results[0].similarity
      ).toBe('number');
    });
  });

  describe('SQL injection via collection name', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.DATABASE_URL = 'postgres://localhost/db';

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: Array(1536).fill(0.1) }],
          }),
      });
    });

    it('rejects collection names with SQL injection', async () => {
      const result = await vectorSearch.execute({
        query: 'test',
        collection: 'users; DROP TABLE--',
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Invalid collection name');
    });

    it('rejects collection names starting with numbers', async () => {
      const result = await vectorSearch.execute({
        query: 'test',
        collection: '123_table',
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Invalid collection name');
    });

    it('accepts valid collection names with underscores', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({
        query: 'test',
        collection: 'my_collection',
      });

      expect(result).not.toHaveProperty('error');
      const queryCall = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(queryCall).toContain('FROM my_collection');
    });

    it('accepts valid collection names with dots', async () => {
      const { Client } = await import('pg');
      const mockInstance = new Client();
      (mockInstance.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await vectorSearch.execute({
        query: 'test',
        collection: 'embeddings.data',
      });

      expect(result).not.toHaveProperty('error');
      const queryCall = (mockInstance.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(queryCall).toContain('FROM embeddings.data');
    });

    it('rejects collection names with spaces', async () => {
      const result = await vectorSearch.execute({
        query: 'test',
        collection: 'my table',
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Invalid collection name');
    });

    it('rejects collection names with parentheses', async () => {
      const result = await vectorSearch.execute({
        query: 'test',
        collection: 'users()',
      });

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Invalid collection name');
    });
  });
});
