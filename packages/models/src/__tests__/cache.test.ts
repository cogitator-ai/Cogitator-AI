import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelCache } from '../cache';
import type { ModelInfo } from '../types';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

const mockModel: ModelInfo = {
  id: 'gpt-4',
  provider: 'openai',
  displayName: 'GPT-4',
  pricing: { input: 30, output: 60 },
  contextWindow: 128000,
  capabilities: { supportsTools: true },
};

describe('ModelCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('memory storage', () => {
    it('stores and retrieves models', async () => {
      const cache = new ModelCache({ storage: 'memory' });
      await cache.set([mockModel]);

      const result = await cache.get();

      expect(result).toHaveLength(1);
      expect(result?.[0].id).toBe('gpt-4');
    });

    it('returns null for empty cache', async () => {
      const cache = new ModelCache({ storage: 'memory' });

      const result = await cache.get();

      expect(result).toBeNull();
    });

    it('returns null for stale cache', async () => {
      const cache = new ModelCache({ storage: 'memory', ttl: 1000 });
      await cache.set([mockModel]);

      vi.advanceTimersByTime(2000);

      const result = await cache.get();

      expect(result).toBeNull();
    });

    it('getStale returns models even if expired', async () => {
      const cache = new ModelCache({ storage: 'memory', ttl: 1000 });
      await cache.set([mockModel]);

      vi.advanceTimersByTime(2000);

      const result = await cache.getStale();

      expect(result).toHaveLength(1);
    });

    it('clears cache', async () => {
      const cache = new ModelCache({ storage: 'memory' });
      await cache.set([mockModel]);
      await cache.clear();

      const result = await cache.get();

      expect(result).toBeNull();
    });
  });

  describe('file storage', () => {
    it('reads from file cache', async () => {
      const { readFile } = await import('fs/promises');
      const mockEntry = {
        models: [mockModel],
        timestamp: Date.now(),
        version: '1.0.0',
      };
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockEntry));

      const cache = new ModelCache({ storage: 'file' });
      const result = await cache.get();

      expect(result).toHaveLength(1);
    });

    it('returns null for empty file', async () => {
      const { readFile } = await import('fs/promises');
      vi.mocked(readFile).mockResolvedValueOnce('');

      const cache = new ModelCache({ storage: 'file' });
      const result = await cache.get();

      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      const { readFile } = await import('fs/promises');
      vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

      const cache = new ModelCache({ storage: 'file' });
      const result = await cache.get();

      expect(result).toBeNull();
    });

    it('returns null for version mismatch', async () => {
      const { readFile } = await import('fs/promises');
      const mockEntry = {
        models: [mockModel],
        timestamp: Date.now(),
        version: '0.9.0',
      };
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockEntry));

      const cache = new ModelCache({ storage: 'file' });
      const result = await cache.get();

      expect(result).toBeNull();
    });

    it('writes to file cache', async () => {
      const { writeFile, mkdir } = await import('fs/promises');

      const cache = new ModelCache({ storage: 'file' });
      await cache.set([mockModel]);

      expect(mkdir).toHaveBeenCalled();
      expect(writeFile).toHaveBeenCalled();
    });

    it('handles write errors gracefully', async () => {
      const { writeFile } = await import('fs/promises');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('EACCES'));

      const cache = new ModelCache({ storage: 'file' });
      await cache.set([mockModel]);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('isStale', () => {
    it('returns true for expired entries', () => {
      const cache = new ModelCache({ ttl: 1000 });
      const entry = {
        models: [mockModel],
        timestamp: Date.now() - 2000,
        version: '1.0.0',
      };

      expect(cache.isStale(entry)).toBe(true);
    });

    it('returns false for fresh entries', () => {
      const cache = new ModelCache({ ttl: 1000 });
      const entry = {
        models: [mockModel],
        timestamp: Date.now(),
        version: '1.0.0',
      };

      expect(cache.isStale(entry)).toBe(false);
    });

    it('returns true for version mismatch', () => {
      const cache = new ModelCache({ ttl: 1000 });
      const entry = {
        models: [mockModel],
        timestamp: Date.now(),
        version: '0.0.1',
      };

      expect(cache.isStale(entry)).toBe(true);
    });
  });
});
