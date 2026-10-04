import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIEmbeddingService } from '../embedding/openai';
import { OllamaEmbeddingService } from '../embedding/ollama';
import { createEmbeddingService } from '../embedding/factory';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OpenAIEmbeddingService', () => {
  let service: OpenAIEmbeddingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new OpenAIEmbeddingService({
      apiKey: 'test-api-key',
    });
  });

  describe('constructor', () => {
    it('uses default model', () => {
      expect(service.model).toBe('text-embedding-3-small');
      expect(service.dimensions).toBe(1536);
    });

    it('sets large dimensions for large model', () => {
      const largeService = new OpenAIEmbeddingService({
        apiKey: 'test-api-key',
        model: 'text-embedding-3-large',
      });

      expect(largeService.dimensions).toBe(3072);
    });

    it('uses custom base URL', async () => {
      const customService = new OpenAIEmbeddingService({
        apiKey: 'test-api-key',
        baseUrl: 'https://custom.api.com/v1',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: [0.1, 0.2] }] }),
      });

      await customService.embed('test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.api.com/v1/embeddings',
        expect.any(Object)
      );
    });
  });

  describe('dimensions', () => {
    const vectorOf = (size: number) => Array.from({ length: size }, () => 0.01);
    const answer = (...sizes: number[]) =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: sizes.map((size, index) => ({ embedding: vectorOf(size), index })),
          }),
      });
    const sentBody = () => JSON.parse(String(mockFetch.mock.calls.at(-1)?.[1]?.body)) as unknown;

    it('sends dimensions for a gateway id of a text-embedding-3 model', async () => {
      const gateway = new OpenAIEmbeddingService({
        apiKey: 'test-api-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/text-embedding-3-small',
        dimensions: 512,
      });
      answer(512);

      const vector = await gateway.embed('pgvector column size');

      expect(sentBody()).toMatchObject({ model: 'openai/text-embedding-3-small', dimensions: 512 });
      expect(vector).toHaveLength(gateway.dimensions);
    });

    it('sends dimensions in batches too', async () => {
      const gateway = new OpenAIEmbeddingService({
        apiKey: 'test-api-key',
        model: 'openai/text-embedding-3-large',
        dimensions: 256,
      });
      answer(256, 256);

      await gateway.embedBatch(['a', 'b']);

      expect(sentBody()).toMatchObject({ dimensions: 256 });
    });

    it('reports the native size of a gateway model id', () => {
      const large = new OpenAIEmbeddingService({
        apiKey: 'test-api-key',
        model: 'openai/text-embedding-3-large',
      });

      expect(large.dimensions).toBe(3072);
    });

    it('does not send dimensions to a model that cannot shorten its output', async () => {
      const ada = new OpenAIEmbeddingService({
        apiKey: 'test-api-key',
        model: 'text-embedding-ada-002',
        dimensions: 1536,
      });
      answer(1536);

      await ada.embed('fixed size');

      expect(sentBody()).not.toHaveProperty('dimensions');
    });

    it('fails instead of returning vectors of another size than it reports', async () => {
      const ada = new OpenAIEmbeddingService({
        apiKey: 'test-api-key',
        model: 'text-embedding-ada-002',
        dimensions: 512,
      });
      answer(1536);
      await expect(ada.embed('wrong size')).rejects.toThrow(
        /returned 1536-dimensional vectors.*512/
      );

      answer(512, 1536);
      await expect(ada.embedBatch(['a', 'b'])).rejects.toThrow(/returned 1536-dimensional/);
    });
  });

  describe('embed', () => {
    it('returns embedding vector', async () => {
      const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: mockEmbedding }] }),
      });

      const result = await service.embed('Hello world');

      expect(result).toEqual(mockEmbedding);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
          },
        })
      );
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('API rate limit exceeded'),
      });

      await expect(service.embed('test')).rejects.toThrow('OpenAI embedding failed');
    });
  });

  describe('embedBatch', () => {
    it('returns multiple embeddings sorted by index', async () => {
      const mockData = [
        { embedding: [0.1, 0.2], index: 1 },
        { embedding: [0.3, 0.4], index: 0 },
        { embedding: [0.5, 0.6], index: 2 },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockData }),
      });

      const result = await service.embedBatch(['one', 'two', 'three']);

      expect(result).toEqual([
        [0.3, 0.4],
        [0.1, 0.2],
        [0.5, 0.6],
      ]);
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Invalid request'),
      });

      await expect(service.embedBatch(['test'])).rejects.toThrow('OpenAI embedding failed');
    });
  });
});

describe('OllamaEmbeddingService', () => {
  let service: OllamaEmbeddingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new OllamaEmbeddingService();
  });

  describe('constructor', () => {
    it('uses default model and dimensions', () => {
      expect(service.model).toBe('nomic-embed-text');
      expect(service.dimensions).toBe(768);
    });

    it('sets dimensions for known models', () => {
      const models: Record<string, number> = {
        'nomic-embed-text': 768,
        'mxbai-embed-large': 1024,
        'all-minilm': 384,
        'snowflake-arctic-embed': 1024,
      };

      for (const [model, dimensions] of Object.entries(models)) {
        const s = new OllamaEmbeddingService({ model });
        expect(s.dimensions).toBe(dimensions);
      }
    });

    it('defaults to 768 for unknown models', () => {
      const s = new OllamaEmbeddingService({ model: 'unknown-model' });
      expect(s.dimensions).toBe(768);
    });

    it('uses custom base URL', async () => {
      const customService = new OllamaEmbeddingService({
        baseUrl: 'http://custom:11434',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ embeddings: [[0.1, 0.2]] }),
      });

      await customService.embed('test');

      expect(mockFetch).toHaveBeenCalledWith('http://custom:11434/api/embed', expect.any(Object));
    });
  });

  describe('embed', () => {
    it('returns embedding vector', async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ embeddings: [mockEmbedding] }),
      });

      const result = await service.embed('Hello');

      expect(result).toEqual(mockEmbedding);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/embed',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Model not found'),
      });

      await expect(service.embed('test')).rejects.toThrow('Ollama embedding failed');
    });
  });

  describe('embedBatch', () => {
    it('returns multiple embeddings', async () => {
      const mockEmbeddings = [
        [0.1, 0.2],
        [0.3, 0.4],
        [0.5, 0.6],
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ embeddings: mockEmbeddings }),
      });

      const result = await service.embedBatch(['one', 'two', 'three']);

      expect(result).toEqual(mockEmbeddings);
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Connection refused'),
      });

      await expect(service.embedBatch(['test'])).rejects.toThrow('Ollama embedding failed');
    });
  });
});

describe('createEmbeddingService', () => {
  it('creates OpenAI service', () => {
    const service = createEmbeddingService({
      provider: 'openai',
      apiKey: 'test-key',
    });

    expect(service).toBeInstanceOf(OpenAIEmbeddingService);
  });

  it('creates Ollama service', () => {
    const service = createEmbeddingService({
      provider: 'ollama',
    });

    expect(service).toBeInstanceOf(OllamaEmbeddingService);
  });

  it('throws for unknown provider', () => {
    expect(() =>
      createEmbeddingService({
        provider: 'unknown' as 'openai',
        apiKey: 'test',
      })
    ).toThrow('Unknown embedding provider');
  });
});
