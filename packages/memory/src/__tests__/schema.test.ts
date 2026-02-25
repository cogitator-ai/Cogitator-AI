import { describe, it, expect } from 'vitest';
import {
  MemoryProviderSchema,
  InMemoryConfigSchema,
  RedisConfigSchema,
  PostgresConfigSchema,
  SQLiteConfigSchema,
  MongoDBConfigSchema,
  QdrantConfigSchema,
  MemoryAdapterConfigSchema,
  EmbeddingProviderSchema,
  EmbeddingServiceConfigSchema,
  ContextBuilderConfigSchema,
  OpenAIEmbeddingConfigSchema,
} from '../schema';

describe('MemoryProviderSchema', () => {
  it.each(['memory', 'redis', 'postgres', 'sqlite', 'mongodb', 'qdrant'] as const)(
    'accepts "%s"',
    (provider) => {
      expect(MemoryProviderSchema.parse(provider)).toBe(provider);
    }
  );

  it('rejects invalid provider', () => {
    expect(() => MemoryProviderSchema.parse('dynamodb')).toThrow();
  });

  it('rejects non-string', () => {
    expect(() => MemoryProviderSchema.parse(42)).toThrow();
  });
});

describe('InMemoryConfigSchema', () => {
  it('accepts valid config', () => {
    const config = { provider: 'memory' as const };
    expect(InMemoryConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts optional maxEntries', () => {
    const config = { provider: 'memory' as const, maxEntries: 1000 };
    expect(InMemoryConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects non-positive maxEntries', () => {
    expect(() => InMemoryConfigSchema.parse({ provider: 'memory', maxEntries: 0 })).toThrow();
    expect(() => InMemoryConfigSchema.parse({ provider: 'memory', maxEntries: -1 })).toThrow();
  });

  it('rejects wrong provider', () => {
    expect(() => InMemoryConfigSchema.parse({ provider: 'redis' })).toThrow();
  });
});

describe('RedisConfigSchema', () => {
  it('accepts minimal config', () => {
    const config = { provider: 'redis' as const };
    expect(RedisConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts url-based config', () => {
    const config = { provider: 'redis' as const, url: 'redis://localhost:6379' };
    expect(RedisConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts host/port config', () => {
    const config = { provider: 'redis' as const, host: '127.0.0.1', port: 6380 };
    expect(RedisConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts cluster config', () => {
    const config = {
      provider: 'redis' as const,
      cluster: {
        nodes: [
          { host: '10.0.0.1', port: 6379 },
          { host: '10.0.0.2', port: 6379 },
        ],
        scaleReads: 'slave' as const,
      },
    };
    expect(RedisConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts all optional fields', () => {
    const config = {
      provider: 'redis' as const,
      url: 'redis://localhost',
      keyPrefix: 'cogitator:',
      ttl: 3600,
      password: 'secret',
    };
    expect(RedisConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects non-positive port', () => {
    expect(() => RedisConfigSchema.parse({ provider: 'redis', port: 0 })).toThrow();
  });

  it('rejects non-positive ttl', () => {
    expect(() => RedisConfigSchema.parse({ provider: 'redis', ttl: -10 })).toThrow();
  });

  it('rejects invalid scaleReads value', () => {
    expect(() =>
      RedisConfigSchema.parse({
        provider: 'redis',
        cluster: { nodes: [{ host: 'a', port: 1 }], scaleReads: 'random' },
      })
    ).toThrow();
  });
});

describe('PostgresConfigSchema', () => {
  it('accepts valid config', () => {
    const config = { provider: 'postgres' as const, connectionString: 'postgresql://localhost/db' };
    expect(PostgresConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts optional schema and poolSize', () => {
    const config = {
      provider: 'postgres' as const,
      connectionString: 'postgresql://localhost/db',
      schema: 'public',
      poolSize: 10,
    };
    expect(PostgresConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects missing connectionString', () => {
    expect(() => PostgresConfigSchema.parse({ provider: 'postgres' })).toThrow();
  });

  it('rejects non-positive poolSize', () => {
    expect(() =>
      PostgresConfigSchema.parse({
        provider: 'postgres',
        connectionString: 'pg://localhost',
        poolSize: 0,
      })
    ).toThrow();
  });
});

describe('SQLiteConfigSchema', () => {
  it('accepts valid config', () => {
    const config = { provider: 'sqlite' as const, path: './data.db' };
    expect(SQLiteConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts optional walMode', () => {
    const config = { provider: 'sqlite' as const, path: '/tmp/test.db', walMode: true };
    expect(SQLiteConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects missing path', () => {
    expect(() => SQLiteConfigSchema.parse({ provider: 'sqlite' })).toThrow();
  });
});

describe('MongoDBConfigSchema', () => {
  it('accepts valid config', () => {
    const config = { provider: 'mongodb' as const, uri: 'mongodb://localhost:27017' };
    expect(MongoDBConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts optional database and collectionPrefix', () => {
    const config = {
      provider: 'mongodb' as const,
      uri: 'mongodb://localhost',
      database: 'cogitator',
      collectionPrefix: 'mem_',
    };
    expect(MongoDBConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects missing uri', () => {
    expect(() => MongoDBConfigSchema.parse({ provider: 'mongodb' })).toThrow();
  });
});

describe('QdrantConfigSchema', () => {
  it('accepts valid config', () => {
    const config = { provider: 'qdrant' as const, dimensions: 1536 };
    expect(QdrantConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts all optional fields', () => {
    const config = {
      provider: 'qdrant' as const,
      url: 'http://localhost:6333',
      apiKey: 'abc123',
      collection: 'embeddings',
      dimensions: 768,
    };
    expect(QdrantConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects missing dimensions', () => {
    expect(() => QdrantConfigSchema.parse({ provider: 'qdrant' })).toThrow();
  });

  it('rejects non-positive dimensions', () => {
    expect(() => QdrantConfigSchema.parse({ provider: 'qdrant', dimensions: 0 })).toThrow();
    expect(() => QdrantConfigSchema.parse({ provider: 'qdrant', dimensions: -128 })).toThrow();
  });
});

describe('MemoryAdapterConfigSchema', () => {
  it('discriminates by provider field', () => {
    expect(MemoryAdapterConfigSchema.parse({ provider: 'memory' })).toEqual({ provider: 'memory' });
    expect(
      MemoryAdapterConfigSchema.parse({ provider: 'redis', url: 'redis://localhost' })
    ).toEqual({ provider: 'redis', url: 'redis://localhost' });
    expect(
      MemoryAdapterConfigSchema.parse({ provider: 'postgres', connectionString: 'pg://localhost' })
    ).toEqual({ provider: 'postgres', connectionString: 'pg://localhost' });
    expect(MemoryAdapterConfigSchema.parse({ provider: 'sqlite', path: './db' })).toEqual({
      provider: 'sqlite',
      path: './db',
    });
    expect(
      MemoryAdapterConfigSchema.parse({ provider: 'mongodb', uri: 'mongodb://localhost' })
    ).toEqual({ provider: 'mongodb', uri: 'mongodb://localhost' });
  });

  it('rejects unknown provider', () => {
    expect(() => MemoryAdapterConfigSchema.parse({ provider: 'dynamodb' })).toThrow();
  });

  it('rejects config missing required fields for provider', () => {
    expect(() => MemoryAdapterConfigSchema.parse({ provider: 'postgres' })).toThrow();
    expect(() => MemoryAdapterConfigSchema.parse({ provider: 'sqlite' })).toThrow();
    expect(() => MemoryAdapterConfigSchema.parse({ provider: 'mongodb' })).toThrow();
  });
});

describe('EmbeddingProviderSchema', () => {
  it.each(['openai', 'ollama', 'google'] as const)('accepts "%s"', (provider) => {
    expect(EmbeddingProviderSchema.parse(provider)).toBe(provider);
  });

  it('rejects invalid provider', () => {
    expect(() => EmbeddingProviderSchema.parse('cohere')).toThrow();
  });
});

describe('EmbeddingServiceConfigSchema', () => {
  it('accepts openai config', () => {
    const config = { provider: 'openai' as const, apiKey: 'sk-test' };
    expect(EmbeddingServiceConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts openai config with all options', () => {
    const config = {
      provider: 'openai' as const,
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
      baseUrl: 'https://api.openai.com/v1',
      dimensions: 3072,
    };
    expect(EmbeddingServiceConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects openai config without apiKey', () => {
    expect(() => EmbeddingServiceConfigSchema.parse({ provider: 'openai' })).toThrow();
  });

  it('rejects openai config with invalid baseUrl', () => {
    expect(() =>
      OpenAIEmbeddingConfigSchema.parse({
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'not-a-url',
      })
    ).toThrow();
  });

  it('accepts ollama config', () => {
    const config = { provider: 'ollama' as const };
    expect(EmbeddingServiceConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts ollama config with options', () => {
    const config = {
      provider: 'ollama' as const,
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
    };
    expect(EmbeddingServiceConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts google config', () => {
    const config = { provider: 'google' as const, apiKey: 'AIza-test' };
    expect(EmbeddingServiceConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts google config with all options', () => {
    const config = {
      provider: 'google' as const,
      apiKey: 'AIza-test',
      model: 'text-embedding-004',
      dimensions: 768,
    };
    expect(EmbeddingServiceConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects google config without apiKey', () => {
    expect(() => EmbeddingServiceConfigSchema.parse({ provider: 'google' })).toThrow();
  });

  it('rejects unknown provider', () => {
    expect(() =>
      EmbeddingServiceConfigSchema.parse({ provider: 'cohere', apiKey: 'test' })
    ).toThrow();
  });
});

describe('ContextBuilderConfigSchema', () => {
  it('accepts valid config', () => {
    const config = { maxTokens: 4096, strategy: 'recent' as const };
    expect(ContextBuilderConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts all optional fields', () => {
    const config = {
      maxTokens: 8192,
      reserveTokens: 512,
      strategy: 'hybrid' as const,
      includeSystemPrompt: true,
      includeFacts: false,
      includeSemanticContext: true,
    };
    expect(ContextBuilderConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts all strategy values', () => {
    for (const strategy of ['recent', 'relevant', 'hybrid'] as const) {
      expect(ContextBuilderConfigSchema.parse({ maxTokens: 1000, strategy })).toBeDefined();
    }
  });

  it('rejects missing maxTokens', () => {
    expect(() => ContextBuilderConfigSchema.parse({ strategy: 'recent' })).toThrow();
  });

  it('rejects missing strategy', () => {
    expect(() => ContextBuilderConfigSchema.parse({ maxTokens: 4096 })).toThrow();
  });

  it('rejects non-positive maxTokens', () => {
    expect(() => ContextBuilderConfigSchema.parse({ maxTokens: 0, strategy: 'recent' })).toThrow();
    expect(() =>
      ContextBuilderConfigSchema.parse({ maxTokens: -100, strategy: 'recent' })
    ).toThrow();
  });

  it('rejects non-positive reserveTokens', () => {
    expect(() =>
      ContextBuilderConfigSchema.parse({ maxTokens: 4096, strategy: 'recent', reserveTokens: 0 })
    ).toThrow();
  });

  it('rejects invalid strategy', () => {
    expect(() =>
      ContextBuilderConfigSchema.parse({ maxTokens: 4096, strategy: 'random' })
    ).toThrow();
  });
});
