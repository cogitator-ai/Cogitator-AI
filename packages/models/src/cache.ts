import { z } from 'zod';
import type { ModelInfo, CacheOptions } from './types';
import { ModelInfoSchema } from './types';

/** Bumped whenever the cached model shape changes, so older cache files are refetched. */
export const CACHE_VERSION = '2.0.0';
const CacheEntrySchema = z.object({
  models: z.array(ModelInfoSchema),
  timestamp: z.number().finite(),
  version: z.literal(CACHE_VERSION),
});

type CacheEntry = z.infer<typeof CacheEntrySchema>;

export class ModelCache {
  private memoryCache: CacheEntry | null = null;
  private options: Omit<Required<CacheOptions>, 'filePath'> & { filePath?: string };

  constructor(options: Partial<CacheOptions> = {}) {
    this.options = {
      ttl: options.ttl ?? 24 * 60 * 60 * 1000,
      storage: options.storage ?? 'memory',
      filePath: options.filePath,
    };
  }

  async get(): Promise<ModelInfo[] | null> {
    const entry = await this.getEntry();

    if (!entry) return null;

    if (this.isStale(entry)) {
      return null;
    }

    return entry.models;
  }

  async getStale(): Promise<ModelInfo[] | null> {
    const entry = await this.getEntry();
    return entry?.models ?? null;
  }

  async set(models: ModelInfo[]): Promise<void> {
    const entry: CacheEntry = {
      models,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    };

    this.memoryCache = entry;

    if (this.options.storage === 'file') {
      await this.writeToFile(entry);
    }
  }

  async clear(): Promise<void> {
    this.memoryCache = null;

    const file = await this.file();
    if (file) {
      try {
        await file.fs.unlink(file.path);
      } catch {}
    }
  }

  isStale(entry: CacheEntry): boolean {
    const age = Date.now() - entry.timestamp;
    return age > this.options.ttl || entry.version !== CACHE_VERSION;
  }

  private async getEntry(): Promise<CacheEntry | null> {
    if (this.memoryCache) {
      return this.memoryCache;
    }

    if (this.options.storage === 'file') {
      const fileEntry = await this.readFromFile();
      if (fileEntry) {
        this.memoryCache = fileEntry;
        return fileEntry;
      }
    }

    return null;
  }

  /**
   * The cache file and the file system to reach it, or null without file
   * storage or where there is no file system (edge runtimes), which leaves
   * the cache in memory.
   */
  private async file(): Promise<{ fs: typeof import('fs/promises'); path: string } | null> {
    if (this.options.storage !== 'file') return null;
    try {
      const fs = await import('fs/promises');
      if (this.options.filePath) return { fs, path: this.options.filePath };
      const [{ join }, { homedir }] = await Promise.all([import('path'), import('os')]);
      return { fs, path: join(homedir(), '.cogitator', 'models-cache.json') };
    } catch {
      return null;
    }
  }

  private async readFromFile(): Promise<CacheEntry | null> {
    const file = await this.file();
    if (!file) return null;
    try {
      const content = await file.fs.readFile(file.path, 'utf-8');
      if (!content.trim()) return null;

      const result = CacheEntrySchema.safeParse(JSON.parse(content));

      if (!result.success) {
        return null;
      }

      return result.data;
    } catch {
      return null;
    }
  }

  private async writeToFile(entry: CacheEntry): Promise<void> {
    const file = await this.file();
    if (!file) return;
    try {
      const { dirname } = await import('path');
      await file.fs.mkdir(dirname(file.path), { recursive: true });
      await file.fs.writeFile(file.path, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (error) {
      console.warn('Failed to write model cache to file:', error);
    }
  }
}
