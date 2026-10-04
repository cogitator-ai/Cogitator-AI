/**
 * Memory adapter exports and factory
 */

import type {
  MemoryAdapter,
  MemoryResult,
  EmbeddingAdapter,
  InMemoryAdapterConfig,
  RedisAdapterConfig,
  PostgresAdapterConfig,
  SQLiteAdapterConfig,
  MongoDBAdapterConfig,
  QdrantAdapterConfig,
} from '@cogitator-ai/types';
import { InMemoryAdapter } from './memory';

export { BaseMemoryAdapter } from './base';
export { InMemoryAdapter } from './memory';

export type MemoryAdapterConfigUnion =
  | InMemoryAdapterConfig
  | RedisAdapterConfig
  | PostgresAdapterConfig
  | SQLiteAdapterConfig
  | MongoDBAdapterConfig;

export type EmbeddingAdapterConfigUnion = QdrantAdapterConfig;

/**
 * An embedding store that talks to a server, as `createEmbeddingAdapter` returns it: call
 * `connect()` before the first operation and `disconnect()` when done.
 */
export interface ConnectableEmbeddingAdapter extends EmbeddingAdapter {
  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;
}

export async function createMemoryAdapter(
  config: MemoryAdapterConfigUnion
): Promise<MemoryAdapter> {
  switch (config.provider) {
    case 'memory':
      return new InMemoryAdapter(config);

    case 'redis': {
      const { RedisAdapter } = await import('./redis');
      return new RedisAdapter(config);
    }

    case 'postgres': {
      const { PostgresAdapter } = await import('./postgres');
      return new PostgresAdapter(config);
    }

    case 'sqlite': {
      const { SQLiteAdapter } = await import('./sqlite');
      return new SQLiteAdapter(config);
    }

    case 'mongodb': {
      const { MongoDBAdapter } = await import('./mongodb');
      return new MongoDBAdapter(config);
    }

    default: {
      const exhaustive: never = config;
      throw new Error(
        `Unknown memory provider: ${(exhaustive as MemoryAdapterConfigUnion).provider}`
      );
    }
  }
}

export async function createEmbeddingAdapter(
  config: EmbeddingAdapterConfigUnion
): Promise<ConnectableEmbeddingAdapter> {
  switch (config.provider) {
    case 'qdrant': {
      const { QdrantAdapter } = await import('./qdrant');
      return new QdrantAdapter(config);
    }
  }
}
