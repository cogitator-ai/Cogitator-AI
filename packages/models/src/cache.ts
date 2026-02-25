import type { ModelInfo, CacheOptions } from './types';
import { writeFile, readFile, mkdir, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';

interface CacheEntry {
  models: ModelInfo[];
  timestamp: number;
  version: string;
}

const CACHE_VERSION = '1.0.0';
const DEFAULT_CACHE_PATH = join(homedir(), '.cogitator', 'models-cache.json');

export class ModelCache {
  private memoryCache: CacheEntry | null = null;
  private options: Required<CacheOptions>;

  constructor(options: Partial<CacheOptions> = {}) {
    this.options = {
      ttl: options.ttl ?? 24 * 60 * 60 * 1000,
      storage: options.storage ?? 'memory',
      filePath: options.filePath ?? DEFAULT_CACHE_PATH,
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

    if (this.options.storage === 'file') {
      try {
        await unlink(this.options.filePath);
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

  private async readFromFile(): Promise<CacheEntry | null> {
    try {
      const content = await readFile(this.options.filePath, 'utf-8');
      if (!content.trim()) return null;

      const entry = JSON.parse(content) as CacheEntry;

      if (!entry.models || !entry.timestamp || entry.version !== CACHE_VERSION) {
        return null;
      }

      return entry;
    } catch {
      return null;
    }
  }

  private async writeToFile(entry: CacheEntry): Promise<void> {
    try {
      await mkdir(dirname(this.options.filePath), { recursive: true });
      await writeFile(this.options.filePath, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (error) {
      console.warn('Failed to write model cache to file:', error);
    }
  }
}
