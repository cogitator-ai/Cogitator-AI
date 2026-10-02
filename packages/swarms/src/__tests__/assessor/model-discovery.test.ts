import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ModelDiscovery } from '../../assessor/model-discovery';

function createOllamaTagsResponse(models: { name: string; size?: number }[]) {
  return {
    models: models.map((m) => ({
      name: m.name,
      modified_at: '2025-01-01T00:00:00Z',
      size: m.size ?? 4_000_000_000,
      digest: 'abc123',
      details: {},
    })),
  };
}

describe('ModelDiscovery', () => {
  let discovery: ModelDiscovery;

  beforeEach(() => {
    discovery = new ModelDiscovery({
      ollamaUrl: 'http://localhost:11434',
      enabledProviders: ['ollama', 'openai', 'anthropic', 'google'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('discoverOllama — capability inference (longest-match-wins)', () => {
    it('llama3.1:8b should match llama3.1 (tools+json), not llama3', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3.1:8b' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models).toHaveLength(1);
      expect(models[0].capabilities.supportsTools).toBe(true);
      expect(models[0].capabilities.supportsJson).toBe(true);
    });

    it('llama3:latest should not advertise tool calling', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].capabilities.supportsTools).toBeUndefined();
      expect(models[0].capabilities.supportsJson).toBe(true);
    });

    it('qwen3:8b should match qwen3 (tools+json) with a 40K window', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'qwen3:8b' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].capabilities.supportsTools).toBe(true);
      expect(models[0].capabilities.supportsVision).toBeUndefined();
      expect(models[0].contextWindow).toBe(40960);
    });

    it('qwen3.5:9b should match qwen3.5 (vision+tools) with a 256K window', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'qwen3.5:9b' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].capabilities.supportsTools).toBe(true);
      expect(models[0].capabilities.supportsVision).toBe(true);
      expect(models[0].contextWindow).toBe(262144);
    });

    it('phi4:latest should match phi4 (tools+json), not phi3 (json only)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'phi4:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models).toHaveLength(1);
      expect(models[0].capabilities.supportsTools).toBe(true);
      expect(models[0].capabilities.supportsJson).toBe(true);
    });

    it('qwen2.5:latest should match qwen2.5 (tools+json), not qwen or qwen2', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'qwen2.5:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models).toHaveLength(1);
      expect(models[0].capabilities.supportsTools).toBe(true);
      expect(models[0].capabilities.supportsJson).toBe(true);
    });

    it('llava:latest should infer vision capability', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llava:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].capabilities.supportsVision).toBe(true);
      expect(models[0].capabilities.supportsJson).toBe(true);
    });

    it('llama3.2-vision:latest should match llama3.2-vision (vision+tools)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(createOllamaTagsResponse([{ name: 'llama3.2-vision:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].capabilities.supportsVision).toBe(true);
      expect(models[0].capabilities.supportsTools).toBe(true);
    });

    it('unknown model should still get supportsStreaming', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(createOllamaTagsResponse([{ name: 'totally-unknown-model:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].capabilities.supportsStreaming).toBe(true);
      expect(models[0].capabilities.supportsTools).toBeUndefined();
      expect(models[0].capabilities.supportsVision).toBeUndefined();
    });
  });

  describe('discoverOllama — context window inference', () => {
    it('llama3.1:latest should return 128000, not 8192', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3.1:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].contextWindow).toBe(128000);
    });

    it('llama3:latest should return 8192', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].contextWindow).toBe(8192);
    });

    it('qwen2.5:latest should return 128000', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'qwen2.5:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].contextWindow).toBe(128000);
    });

    it('phi4:latest should return 16384', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'phi4:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].contextWindow).toBe(16384);
    });

    it('unknown model should fall back to 4096', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(createOllamaTagsResponse([{ name: 'totally-unknown-model:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].contextWindow).toBe(4096);
    });

    it('llama3.2:1b should prefer exact tag match over base name', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3.2:1b' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].contextWindow).toBe(128000);
    });
  });

  describe('discoverOllama — model transformation', () => {
    it('should set provider to ollama', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].provider).toBe('ollama');
      expect(models[0].isLocal).toBe(true);
      expect(models[0].isAvailable).toBe(true);
    });

    it('should set pricing to 0 for local models', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'mistral:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].pricing).toEqual({ input: 0, output: 0 });
    });

    it('should format display name — strip :latest, capitalize parts', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3.1:latest' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].displayName).toBe('Llama3.1');
    });

    it('should keep non-latest tag in display name', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3.1:8b' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].displayName).toBe('Llama3.1 (8b)');
    });

    it('should preserve original model name as id', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'Qwen2.5:14b' }])),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models[0].id).toBe('Qwen2.5:14b');
    });

    it('should handle multiple models in a single response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(
              createOllamaTagsResponse([
                { name: 'llama3.1:8b' },
                { name: 'phi4:latest' },
                { name: 'qwen2.5:latest' },
                { name: 'llava:latest' },
              ])
            ),
        })
      );

      const models = await discovery.discoverOllama();

      expect(models).toHaveLength(4);
      expect(models[0].id).toBe('llama3.1:8b');
      expect(models[1].id).toBe('phi4:latest');
      expect(models[2].id).toBe('qwen2.5:latest');
      expect(models[3].id).toBe('llava:latest');
    });
  });

  describe('discoverOllama — error handling', () => {
    it('should return empty array when fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

      const models = await discovery.discoverOllama();

      expect(models).toEqual([]);
    });

    it('should return empty array when response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      const models = await discovery.discoverOllama();

      expect(models).toEqual([]);
    });
  });

  describe('getCloudModels', () => {
    it.each([
      ['openai', 'gpt-6-astra', 'GPT-6 Astra'],
      ['openai', 'gpt-6.1-sol', 'GPT-6.1 Sol'],
      ['openai', 'gpt-6-luna', 'GPT-6 Luna'],
      ['anthropic', 'claude-opus-5-5', 'Claude Opus 5.5'],
      ['anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5'],
      ['anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5'],
      ['google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
      ['google', 'gemini-3.8-flash', 'Gemini 3.8 Flash'],
      ['google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
    ] as const)('should include %s model %s as "%s"', (provider, id, displayName) => {
      const model = discovery.getCloudModels([provider]).find((m) => m.id === id);
      expect(model).toBeDefined();
      expect(model!.displayName).toBe(displayName);
    });

    it('should not list retired or non-existent cloud models', () => {
      const ids = discovery.getCloudModels().map((m) => m.id);
      for (const retired of [
        'claude-opus-4-5-20250229',
        'claude-sonnet-4-20250514',
        'claude-3-5-haiku-20241022',
        'gemini-2.0-flash',
        'gemini-2.5-flash',
        'gpt-4o',
      ]) {
        expect(ids).not.toContain(retired);
      }
    });

    it('should only return models for enabled providers', () => {
      const restricted = new ModelDiscovery({
        enabledProviders: ['openai'],
      });

      const all = restricted.getCloudModels();

      expect(all.every((m) => m.provider === 'openai')).toBe(true);
    });

    it('should filter by requested provider subset', () => {
      const models = discovery.getCloudModels(['google']);

      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.provider === 'google')).toBe(true);
    });

    it('all cloud models should be non-local and available', () => {
      const models = discovery.getCloudModels();

      for (const m of models) {
        expect(m.isLocal).toBe(false);
        expect(m.isAvailable).toBe(true);
      }
    });

    it('all cloud models should have vision, tools, json, and streaming', () => {
      const models = discovery.getCloudModels();

      for (const m of models) {
        expect(m.capabilities.supportsVision).toBe(true);
        expect(m.capabilities.supportsTools).toBe(true);
        expect(m.capabilities.supportsJson).toBe(true);
        expect(m.capabilities.supportsStreaming).toBe(true);
      }
    });
  });

  describe('discoverAll', () => {
    it('should combine ollama and cloud models', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3:latest' }])),
        })
      );

      const models = await discovery.discoverAll();

      const ollamaModels = models.filter((m) => m.provider === 'ollama');
      const cloudModels = models.filter((m) => m.provider !== 'ollama');

      expect(ollamaModels).toHaveLength(1);
      expect(cloudModels.length).toBeGreaterThan(0);
    });

    it('should cache results within TTL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(createOllamaTagsResponse([{ name: 'llama3:latest' }])),
      });
      vi.stubGlobal('fetch', fetchMock);

      await discovery.discoverAll();
      await discovery.discoverAll();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should skip ollama when not in enabledProviders', async () => {
      const noOllama = new ModelDiscovery({
        enabledProviders: ['openai'],
      });

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const models = await noOllama.discoverAll();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(models.every((m) => m.provider === 'openai')).toBe(true);
    });
  });
});
