/**
 * Memory adapter exports and factory
 */

import type {
  MemoryAdapter,
  InMemoryAdapterConfig,
  RedisAdapterConfig,
  PostgresAdapterConfig,
} from '@cogitator/types';
import { InMemoryAdapter } from './memory';

export { BaseMemoryAdapter } from './base';
export { InMemoryAdapter } from './memory';

export type MemoryAdapterConfigUnion =
  | InMemoryAdapterConfig
  | RedisAdapterConfig
  | PostgresAdapterConfig;

export async function createMemoryAdapter(
  config: MemoryAdapterConfigUnion
): Promise<MemoryAdapter> {
  switch (config.provider) {
    case 'memory':
      return new InMemoryAdapter(config);

    case 'redis': {
      const { RedisAdapter } = await import('./redis.js');
      return new RedisAdapter(config);
    }

    case 'postgres': {
      const { PostgresAdapter } = await import('./postgres.js');
      return new PostgresAdapter(config);
    }

    default: {
      const exhaustive: never = config;
      throw new Error(
        `Unknown memory provider: ${(exhaustive as MemoryAdapterConfigUnion).provider}`
      );
    }
  }
}
