/**
 * Idempotency Store for safe retries
 *
 * Features:
 * - Unique key generation
 * - Operation deduplication
 * - Result caching
 * - TTL-based expiration
 * - Multiple storage backends
 */

import type { IdempotencyStore, IdempotencyRecord } from '@cogitator-ai/types';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';

const DEFAULT_TTL = 24 * 60 * 60 * 1000;

/**
 * Idempotency check result
 */
export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  record?: IdempotencyRecord;
}

/**
 * Generate idempotency key from inputs
 */
export function generateIdempotencyKey(
  workflowId: string,
  nodeId: string,
  input?: unknown
): string {
  const data = JSON.stringify({
    workflowId,
    nodeId,
    input: input ?? null,
  });

  return createHash('sha256').update(data).digest('hex').slice(0, 32);
}

/**
 * Generate idempotency key with custom components
 */
export function generateCustomKey(...components: unknown[]): string {
  const data = JSON.stringify(components);
  return createHash('sha256').update(data).digest('hex').slice(0, 32);
}

/**
 * Abstract idempotency store
 */
export abstract class BaseIdempotencyStore implements IdempotencyStore {
  abstract check(key: string): Promise<IdempotencyCheckResult>;
  abstract store(key: string, result: unknown, error?: Error): Promise<void>;
  abstract get(key: string): Promise<IdempotencyRecord | null>;
  abstract delete(key: string): Promise<boolean>;
  abstract clear(): Promise<void>;
}

/**
 * In-memory idempotency store
 */
export class InMemoryIdempotencyStore extends BaseIdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();
  private ttl: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(options: { ttl?: number; cleanupIntervalMs?: number } = {}) {
    super();
    this.ttl = options.ttl ?? DEFAULT_TTL;

    if (options.cleanupIntervalMs) {
      this.cleanupInterval = setInterval(() => void this.cleanup(), options.cleanupIntervalMs);
    }
  }

  async check(key: string): Promise<IdempotencyCheckResult> {
    const record = this.records.get(key);

    if (!record) {
      return { isDuplicate: false };
    }

    if (record.expiresAt && record.expiresAt < Date.now()) {
      this.records.delete(key);
      return { isDuplicate: false };
    }

    return { isDuplicate: true, record };
  }

  async store(key: string, result: unknown, error?: Error): Promise<void> {
    const now = Date.now();

    const record: IdempotencyRecord = {
      key,
      result,
      error: error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : undefined,
      createdAt: now,
      expiresAt: now + this.ttl,
      status: error ? 'failed' : 'completed',
    };

    this.records.set(key, record);
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const record = this.records.get(key);

    if (!record) return null;

    if (record.expiresAt && record.expiresAt < Date.now()) {
      this.records.delete(key);
      return null;
    }

    return record;
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, record] of this.records) {
      if (record.expiresAt && record.expiresAt < now) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.records.delete(key);
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }
}

/**
 * File-based idempotency store
 */
export class FileIdempotencyStore extends BaseIdempotencyStore {
  private directory: string;
  private ttl: number;
  private initialized = false;

  constructor(directory: string, options: { ttl?: number } = {}) {
    super();
    this.directory = directory;
    this.ttl = options.ttl ?? DEFAULT_TTL;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.directory, { recursive: true });
    } catch {}
    this.initialized = true;
  }

  private getFilePath(key: string): string {
    const subdir = key.slice(0, 2);
    return join(this.directory, subdir, `${key}.json`);
  }

  async check(key: string): Promise<IdempotencyCheckResult> {
    const record = await this.get(key);

    if (!record) {
      return { isDuplicate: false };
    }

    return { isDuplicate: true, record };
  }

  async store(key: string, result: unknown, error?: Error): Promise<void> {
    await this.ensureInitialized();

    const now = Date.now();
    const filePath = this.getFilePath(key);

    const dir = dirname(filePath);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});

    const record: IdempotencyRecord = {
      key,
      result,
      error: error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : undefined,
      createdAt: now,
      expiresAt: now + this.ttl,
      status: error ? 'failed' : 'completed',
    };

    await fs.writeFile(filePath, JSON.stringify(record, null, 2));
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    await this.ensureInitialized();

    try {
      const filePath = this.getFilePath(key);
      const content = await fs.readFile(filePath, 'utf-8');
      const record = JSON.parse(content) as IdempotencyRecord;

      if (record.expiresAt && record.expiresAt < Date.now()) {
        await this.delete(key);
        return null;
      }

      return record;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.getFilePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    await this.ensureInitialized();

    const clearDir = async (dir: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            await clearDir(path);
            await fs.rmdir(path).catch(() => {});
          } else if (entry.name.endsWith('.json')) {
            await fs.unlink(path).catch(() => {});
          }
        }
      } catch {}
    };

    await clearDir(this.directory);
  }
}

/**
 * Idempotent operation wrapper
 */
export async function idempotent<T>(
  store: IdempotencyStore,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const check = await store.check(key);

  if (check.isDuplicate && check.record) {
    if (check.record.status === 'failed' && check.record.error) {
      const error = new Error(check.record.error.message);
      error.name = check.record.error.name;
      throw error;
    }
    return check.record.result as T;
  }

  const result = await fn();
  await store.store(key, result);
  return result;
}

/**
 * Decorator for idempotent methods
 */
export function Idempotent(store: IdempotencyStore, keyGenerator: (...args: unknown[]) => string) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>;

    descriptor.value = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const key = keyGenerator(...args);
      return idempotent(store, key, () => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}

/**
 * Create an in-memory idempotency store
 */
export function createInMemoryIdempotencyStore(options?: {
  ttl?: number;
  cleanupIntervalMs?: number;
}): InMemoryIdempotencyStore {
  return new InMemoryIdempotencyStore(options);
}

/**
 * Create a file-based idempotency store
 */
export function createFileIdempotencyStore(
  directory: string,
  options?: { ttl?: number }
): FileIdempotencyStore {
  return new FileIdempotencyStore(directory, options);
}
