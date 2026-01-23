import type {
  Tool,
  ToolContext,
  CachedTool,
  CacheEntry,
  ToolCacheStorage,
  WithCacheOptions,
  RedisClientLike,
} from '@cogitator-ai/types';
import { parseDuration, generateCacheKey, paramsToQueryString } from './cache-key';
import { InMemoryToolCacheStorage } from './storage/memory';
import { RedisToolCacheStorage } from './storage/redis';

export function withCache<TParams, TResult>(
  tool: Tool<TParams, TResult>,
  config: WithCacheOptions
): CachedTool<TParams, TResult> {
  const ttlMs = parseDuration(config.ttl);
  const similarity = config.similarity ?? 0.95;
  const prefix = config.keyPrefix ?? 'toolcache';

  const storage: ToolCacheStorage =
    config.storage === 'redis'
      ? new RedisToolCacheStorage({
          client: config.redisClient!,
          keyPrefix: prefix,
          maxSize: config.maxSize,
        })
      : new InMemoryToolCacheStorage(config.maxSize);

  const cachedExecute = async (params: TParams, context: ToolContext): Promise<TResult> => {
    const cacheKey = generateCacheKey({
      toolName: tool.name,
      params,
      prefix,
    });

    const exactMatch = await storage.get(cacheKey);
    if (exactMatch) {
      storage.recordHit();
      config.onHit?.(cacheKey, params);
      return exactMatch.result as TResult;
    }

    if (config.strategy === 'semantic' && config.embeddingService && storage.findSimilar) {
      try {
        const queryStr = paramsToQueryString(params);
        const queryEmbedding = await config.embeddingService.embed(queryStr);

        const similar = await storage.findSimilar(queryEmbedding, similarity, 1);
        if (similar.length > 0) {
          storage.recordHit();
          config.onHit?.(similar[0].key, params);
          await storage.get(similar[0].key);
          return similar[0].result as TResult;
        }
      } catch {}
    }

    storage.recordMiss();
    config.onMiss?.(cacheKey, params);

    const result = await tool.execute(params, context);

    const now = Date.now();
    const entry: CacheEntry<TResult> = {
      key: cacheKey,
      result,
      createdAt: now,
      expiresAt: now + ttlMs,
      hits: 0,
      lastAccessedAt: now,
    };

    if (config.strategy === 'semantic' && config.embeddingService) {
      try {
        const queryStr = paramsToQueryString(params);
        entry.embedding = await config.embeddingService.embed(queryStr);
      } catch {}
    }

    await storage.set(cacheKey, entry);

    return result;
  };

  const cachedTool: CachedTool<TParams, TResult> = {
    ...tool,
    execute: cachedExecute,
    cache: {
      stats: () => storage.getStats(),

      clear: async () => {
        await storage.clear();
      },

      invalidate: async (params: TParams): Promise<boolean> => {
        const key = generateCacheKey({
          toolName: tool.name,
          params,
          prefix,
        });
        const existed = await storage.has(key);
        if (existed) {
          await storage.delete(key);
          config.onEvict?.(key);
        }
        return existed;
      },

      warmup: async (entries: Array<{ params: TParams; result: TResult }>) => {
        const now = Date.now();

        for (const { params, result } of entries) {
          const key = generateCacheKey({
            toolName: tool.name,
            params,
            prefix,
          });

          const entry: CacheEntry<TResult> = {
            key,
            result,
            createdAt: now,
            expiresAt: now + ttlMs,
            hits: 0,
            lastAccessedAt: now,
          };

          if (config.strategy === 'semantic' && config.embeddingService) {
            try {
              const queryStr = paramsToQueryString(params);
              entry.embedding = await config.embeddingService.embed(queryStr);
            } catch {}
          }

          await storage.set(key, entry);
        }
      },
    },
  };

  return cachedTool;
}

export function createToolCacheStorage(
  type: 'memory' | 'redis',
  options: {
    maxSize?: number;
    redisClient?: RedisClientLike;
    keyPrefix?: string;
  } = {}
): ToolCacheStorage {
  if (type === 'redis') {
    if (!options.redisClient) {
      throw new Error('redisClient required for redis storage');
    }
    return new RedisToolCacheStorage({
      client: options.redisClient,
      keyPrefix: options.keyPrefix,
      maxSize: options.maxSize,
    });
  }

  return new InMemoryToolCacheStorage(options.maxSize);
}
