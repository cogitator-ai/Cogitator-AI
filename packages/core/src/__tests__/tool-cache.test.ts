import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool';
import {
  withCache,
  InMemoryToolCacheStorage,
  generateCacheKey,
  paramsToQueryString,
  cosineSimilarity,
  parseDuration,
  stableStringify,
} from '../cache/index';
import type { ToolContext, EmbeddingService } from '@cogitator-ai/types';

const mockContext: ToolContext = {
  agentId: 'test-agent',
  runId: 'test-run',
  signal: new AbortController().signal,
};

describe('Tool Cache', () => {
  describe('parseDuration', () => {
    it('parses milliseconds', () => {
      expect(parseDuration('100ms')).toBe(100);
      expect(parseDuration('1000ms')).toBe(1000);
    });

    it('parses seconds', () => {
      expect(parseDuration('1s')).toBe(1000);
      expect(parseDuration('30s')).toBe(30000);
    });

    it('parses minutes', () => {
      expect(parseDuration('1m')).toBe(60000);
      expect(parseDuration('5m')).toBe(300000);
    });

    it('parses hours', () => {
      expect(parseDuration('1h')).toBe(3600000);
      expect(parseDuration('24h')).toBe(86400000);
    });

    it('parses days', () => {
      expect(parseDuration('1d')).toBe(86400000);
      expect(parseDuration('7d')).toBe(604800000);
    });

    it('parses weeks', () => {
      expect(parseDuration('1w')).toBe(604800000);
    });

    it('throws on invalid format', () => {
      expect(() => parseDuration('invalid')).toThrow('Invalid duration format');
      expect(() => parseDuration('10')).toThrow('Invalid duration format');
    });
  });

  describe('stableStringify', () => {
    it('produces consistent output for same objects', () => {
      const obj1 = { b: 2, a: 1 };
      const obj2 = { a: 1, b: 2 };
      expect(stableStringify(obj1)).toBe(stableStringify(obj2));
    });

    it('handles nested objects', () => {
      const obj = { z: { b: 2, a: 1 }, y: 0 };
      expect(stableStringify(obj)).toBe('{"y":0,"z":{"a":1,"b":2}}');
    });

    it('handles arrays', () => {
      expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    });

    it('handles primitives', () => {
      expect(stableStringify('hello')).toBe('"hello"');
      expect(stableStringify(42)).toBe('42');
      expect(stableStringify(null)).toBe('null');
    });
  });

  describe('generateCacheKey', () => {
    it('generates consistent keys for same inputs', () => {
      const key1 = generateCacheKey({
        toolName: 'test',
        params: { query: 'hello' },
      });
      const key2 = generateCacheKey({
        toolName: 'test',
        params: { query: 'hello' },
      });
      expect(key1).toBe(key2);
    });

    it('generates different keys for different params', () => {
      const key1 = generateCacheKey({
        toolName: 'test',
        params: { query: 'hello' },
      });
      const key2 = generateCacheKey({
        toolName: 'test',
        params: { query: 'world' },
      });
      expect(key1).not.toBe(key2);
    });

    it('uses prefix', () => {
      const key = generateCacheKey({
        toolName: 'test',
        params: {},
        prefix: 'myprefix',
      });
      expect(key.startsWith('myprefix:')).toBe(true);
    });
  });

  describe('paramsToQueryString', () => {
    it('returns string params as-is', () => {
      expect(paramsToQueryString('hello')).toBe('hello');
    });

    it('extracts query field', () => {
      expect(paramsToQueryString({ query: 'test query' })).toBe('test query');
    });

    it('extracts text field', () => {
      expect(paramsToQueryString({ text: 'some text' })).toBe('some text');
    });

    it('extracts input field', () => {
      expect(paramsToQueryString({ input: 'user input' })).toBe('user input');
    });

    it('falls back to JSON for unknown structure', () => {
      expect(paramsToQueryString({ foo: 'bar' })).toBe('{"foo":"bar"}');
    });
  });

  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      const v = [1, 2, 3];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    it('returns -1 for opposite vectors', () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    });

    it('handles zero vectors', () => {
      expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    });

    it('returns 0 for different length vectors', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });
  });

  describe('InMemoryToolCacheStorage', () => {
    let storage: InMemoryToolCacheStorage;

    beforeEach(() => {
      storage = new InMemoryToolCacheStorage(3);
    });

    it('stores and retrieves entries', async () => {
      const entry = {
        key: 'test-key',
        result: { data: 'test' },
        createdAt: Date.now(),
        expiresAt: Date.now() + 10000,
        hits: 0,
        lastAccessedAt: Date.now(),
      };
      await storage.set('test-key', entry);
      const retrieved = await storage.get('test-key');
      expect(retrieved?.result).toEqual({ data: 'test' });
    });

    it('returns null for missing entries', async () => {
      expect(await storage.get('nonexistent')).toBeNull();
    });

    it('expires old entries', async () => {
      const entry = {
        key: 'test-key',
        result: 'data',
        createdAt: Date.now() - 10000,
        expiresAt: Date.now() - 1000,
        hits: 0,
        lastAccessedAt: Date.now() - 10000,
      };
      await storage.set('test-key', entry);
      expect(await storage.get('test-key')).toBeNull();
    });

    it('evicts oldest entries when at capacity', async () => {
      const now = Date.now();
      await storage.set('k1', {
        key: 'k1',
        result: 1,
        createdAt: now,
        expiresAt: now + 60000,
        hits: 0,
        lastAccessedAt: now - 3000,
      });
      await storage.set('k2', {
        key: 'k2',
        result: 2,
        createdAt: now,
        expiresAt: now + 60000,
        hits: 0,
        lastAccessedAt: now - 2000,
      });
      await storage.set('k3', {
        key: 'k3',
        result: 3,
        createdAt: now,
        expiresAt: now + 60000,
        hits: 0,
        lastAccessedAt: now - 1000,
      });

      await storage.set('k4', {
        key: 'k4',
        result: 4,
        createdAt: now,
        expiresAt: now + 60000,
        hits: 0,
        lastAccessedAt: now,
      });

      expect(await storage.has('k1')).toBe(false);
      expect(await storage.has('k4')).toBe(true);
    });

    it('tracks stats', async () => {
      const now = Date.now();
      await storage.set('k1', {
        key: 'k1',
        result: 1,
        createdAt: now,
        expiresAt: now + 60000,
        hits: 0,
        lastAccessedAt: now,
      });

      storage.recordHit();
      storage.recordMiss();
      storage.recordMiss();

      const stats = storage.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(1 / 3);
    });

    it('finds similar entries', async () => {
      const now = Date.now();
      await storage.set('k1', {
        key: 'k1',
        result: 'result1',
        embedding: [1, 0, 0],
        createdAt: now,
        expiresAt: now + 60000,
        hits: 0,
        lastAccessedAt: now,
      });
      await storage.set('k2', {
        key: 'k2',
        result: 'result2',
        embedding: [0.9, 0.1, 0],
        createdAt: now,
        expiresAt: now + 60000,
        hits: 0,
        lastAccessedAt: now,
      });

      const similar = await storage.findSimilar([1, 0, 0], 0.9, 10);
      expect(similar.length).toBe(2);
      expect(similar[0].key).toBe('k1');
      expect(similar[0].score).toBeCloseTo(1);
    });
  });

  describe('withCache', () => {
    it('caches exact match results', async () => {
      let callCount = 0;
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({ input: z.string() }),
        execute: async ({ input }) => {
          callCount++;
          return { result: input.toUpperCase() };
        },
      });

      const cachedTool = withCache(testTool, {
        strategy: 'exact',
        ttl: '1h',
        maxSize: 100,
        storage: 'memory',
      });

      const result1 = await cachedTool.execute({ input: 'hello' }, mockContext);
      const result2 = await cachedTool.execute({ input: 'hello' }, mockContext);

      expect(result1).toEqual({ result: 'HELLO' });
      expect(result2).toEqual({ result: 'HELLO' });
      expect(callCount).toBe(1);
    });

    it('does not cache different params', async () => {
      let callCount = 0;
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({ input: z.string() }),
        execute: async ({ input }) => {
          callCount++;
          return { result: input.toUpperCase() };
        },
      });

      const cachedTool = withCache(testTool, {
        strategy: 'exact',
        ttl: '1h',
        maxSize: 100,
        storage: 'memory',
      });

      await cachedTool.execute({ input: 'hello' }, mockContext);
      await cachedTool.execute({ input: 'world' }, mockContext);

      expect(callCount).toBe(2);
    });

    it('tracks cache stats', async () => {
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({ x: z.number() }),
        execute: async ({ x }) => x * 2,
      });

      const cachedTool = withCache(testTool, {
        strategy: 'exact',
        ttl: '1h',
        maxSize: 100,
        storage: 'memory',
      });

      await cachedTool.execute({ x: 1 }, mockContext);
      await cachedTool.execute({ x: 1 }, mockContext);
      await cachedTool.execute({ x: 2 }, mockContext);

      const stats = cachedTool.cache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
    });

    it('supports invalidate', async () => {
      let callCount = 0;
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({ x: z.number() }),
        execute: async ({ x }) => {
          callCount++;
          return x * 2;
        },
      });

      const cachedTool = withCache(testTool, {
        strategy: 'exact',
        ttl: '1h',
        maxSize: 100,
        storage: 'memory',
      });

      await cachedTool.execute({ x: 1 }, mockContext);
      expect(callCount).toBe(1);

      await cachedTool.cache.invalidate({ x: 1 });

      await cachedTool.execute({ x: 1 }, mockContext);
      expect(callCount).toBe(2);
    });

    it('supports warmup', async () => {
      let callCount = 0;
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({ x: z.number() }),
        execute: async ({ x }) => {
          callCount++;
          return x * 2;
        },
      });

      const cachedTool = withCache(testTool, {
        strategy: 'exact',
        ttl: '1h',
        maxSize: 100,
        storage: 'memory',
      });

      await cachedTool.cache.warmup([
        { params: { x: 1 }, result: 2 },
        { params: { x: 2 }, result: 4 },
      ]);

      const r1 = await cachedTool.execute({ x: 1 }, mockContext);
      const r2 = await cachedTool.execute({ x: 2 }, mockContext);

      expect(r1).toBe(2);
      expect(r2).toBe(4);
      expect(callCount).toBe(0);
    });

    it('calls onHit and onMiss callbacks', async () => {
      const onHit = vi.fn();
      const onMiss = vi.fn();

      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({ x: z.number() }),
        execute: async ({ x }) => x * 2,
      });

      const cachedTool = withCache(testTool, {
        strategy: 'exact',
        ttl: '1h',
        maxSize: 100,
        storage: 'memory',
        onHit,
        onMiss,
      });

      await cachedTool.execute({ x: 1 }, mockContext);
      expect(onMiss).toHaveBeenCalledTimes(1);
      expect(onHit).toHaveBeenCalledTimes(0);

      await cachedTool.execute({ x: 1 }, mockContext);
      expect(onHit).toHaveBeenCalledTimes(1);
    });

    it('supports semantic caching with embedding service', async () => {
      let callCount = 0;

      const mockEmbeddingService: EmbeddingService = {
        embed: async (text: string) => {
          if (text.includes('hello')) return [1, 0, 0];
          if (text.includes('hi')) return [0.98, 0.02, 0];
          return [0, 0, 1];
        },
        embedBatch: async (texts: string[]) =>
          Promise.all(texts.map((t) => mockEmbeddingService.embed(t))),
        dimensions: 3,
        model: 'test-model',
      };

      const testTool = tool({
        name: 'greet',
        description: 'Greet',
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          callCount++;
          return `Response to: ${query}`;
        },
      });

      const cachedTool = withCache(testTool, {
        strategy: 'semantic',
        similarity: 0.95,
        ttl: '1h',
        maxSize: 100,
        storage: 'memory',
        embeddingService: mockEmbeddingService,
      });

      await cachedTool.execute({ query: 'hello world' }, mockContext);
      expect(callCount).toBe(1);

      const result = await cachedTool.execute({ query: 'hi there' }, mockContext);
      expect(callCount).toBe(1);
      expect(result).toBe('Response to: hello world');
    });
  });
});
