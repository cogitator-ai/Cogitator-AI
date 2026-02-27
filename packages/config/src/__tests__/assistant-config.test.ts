import { describe, it, expect } from 'vitest';
import { AssistantConfigSchema } from '../schema';

describe('AssistantConfigSchema', () => {
  it('accepts minimal valid config', () => {
    const result = AssistantConfigSchema.parse({
      name: 'jarvis',
      personality: 'You are a helpful assistant.',
      llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
    });

    expect(result.name).toBe('jarvis');
    expect(result.personality).toBe('You are a helpful assistant.');
    expect(result.llm.provider).toBe('google');
    expect(result.llm.model).toBe('google/gemini-2.5-flash');
  });

  it('applies default values for optional fields', () => {
    const result = AssistantConfigSchema.parse({
      name: 'test',
      personality: 'Bot',
      llm: { provider: 'openai', model: 'openai/gpt-4o' },
    });

    expect(result.channels).toEqual({});
    expect(result.capabilities).toEqual({});
    expect(result.memory.adapter).toBe('sqlite');
    expect(result.memory.autoExtract).toBe(true);
    expect(result.memory.knowledgeGraph).toBe(true);
  });

  it('accepts full config with all fields', () => {
    const full = {
      name: 'jarvis',
      personality: 'You are Jarvis.',
      llm: { provider: 'google' as const, model: 'google/gemini-2.5-flash' },
      channels: {
        telegram: { ownerIds: ['123'] },
        discord: { ownerIds: ['456'] },
        slack: {},
      },
      capabilities: {
        webSearch: true,
        fileSystem: { paths: ['/tmp'] },
        github: true,
        deviceTools: false,
        browser: true,
        scheduler: true,
        rag: { paths: ['/docs'] },
      },
      mcpServers: {
        weather: { command: 'weather-mcp', args: ['--port', '3000'] },
      },
      memory: {
        adapter: 'postgres' as const,
        path: '/data/memory.db',
        autoExtract: false,
        knowledgeGraph: false,
        compaction: { threshold: 100 },
      },
      stream: { flushInterval: 500, minChunkSize: 20 },
      rateLimit: { maxPerMinute: 10 },
    };

    const result = AssistantConfigSchema.parse(full);

    expect(result.name).toBe('jarvis');
    expect(result.channels.telegram?.ownerIds).toEqual(['123']);
    expect(result.capabilities.webSearch).toBe(true);
    expect(result.capabilities.fileSystem?.paths).toEqual(['/tmp']);
    expect(result.memory.adapter).toBe('postgres');
    expect(result.memory.autoExtract).toBe(false);
    expect(result.memory.compaction?.threshold).toBe(100);
    expect(result.stream?.flushInterval).toBe(500);
    expect(result.rateLimit?.maxPerMinute).toBe(10);
    expect(result.mcpServers?.weather.command).toBe('weather-mcp');
  });

  it('accepts all valid LLM providers', () => {
    for (const provider of ['google', 'openai', 'anthropic', 'ollama'] as const) {
      const result = AssistantConfigSchema.parse({
        name: 'test',
        personality: 'Bot',
        llm: { provider, model: `${provider}/test-model` },
      });
      expect(result.llm.provider).toBe(provider);
    }
  });

  it('rejects invalid LLM provider', () => {
    expect(() =>
      AssistantConfigSchema.parse({
        name: 'test',
        personality: 'Bot',
        llm: { provider: 'invalid', model: 'invalid/model' },
      })
    ).toThrow();
  });

  it('rejects missing name', () => {
    expect(() =>
      AssistantConfigSchema.parse({
        personality: 'Bot',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
      })
    ).toThrow();
  });

  it('rejects missing personality', () => {
    expect(() =>
      AssistantConfigSchema.parse({
        name: 'test',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
      })
    ).toThrow();
  });

  it('rejects missing llm', () => {
    expect(() =>
      AssistantConfigSchema.parse({
        name: 'test',
        personality: 'Bot',
      })
    ).toThrow();
  });

  it('rejects llm without model', () => {
    expect(() =>
      AssistantConfigSchema.parse({
        name: 'test',
        personality: 'Bot',
        llm: { provider: 'google' },
      })
    ).toThrow();
  });

  it('accepts memory adapter variants', () => {
    for (const adapter of ['sqlite', 'postgres'] as const) {
      const result = AssistantConfigSchema.parse({
        name: 'test',
        personality: 'Bot',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        memory: { adapter },
      });
      expect(result.memory.adapter).toBe(adapter);
    }
  });

  it('rejects invalid memory adapter', () => {
    expect(() =>
      AssistantConfigSchema.parse({
        name: 'test',
        personality: 'Bot',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        memory: { adapter: 'mysql' },
      })
    ).toThrow();
  });

  it('applies stream defaults when partial stream config given', () => {
    const result = AssistantConfigSchema.parse({
      name: 'test',
      personality: 'Bot',
      llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
      stream: {},
    });

    expect(result.stream?.flushInterval).toBe(600);
    expect(result.stream?.minChunkSize).toBe(30);
  });

  it('applies rateLimit default when partial config given', () => {
    const result = AssistantConfigSchema.parse({
      name: 'test',
      personality: 'Bot',
      llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
      rateLimit: {},
    });

    expect(result.rateLimit?.maxPerMinute).toBe(30);
  });
});
