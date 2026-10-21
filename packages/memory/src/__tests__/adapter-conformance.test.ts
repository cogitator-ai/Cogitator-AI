import { describe, it } from 'vitest';
import { memoryAdapterConformanceCases } from '@cogitator-ai/test-utils';
import type { MemoryAdapter } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { SQLiteAdapter } from '../adapters/sqlite';

async function connected(adapter: MemoryAdapter): Promise<MemoryAdapter> {
  const result = await adapter.connect();
  if (!result.success) throw new Error(result.error);
  return adapter;
}

const targets: Record<string, () => Promise<MemoryAdapter>> = {
  InMemoryAdapter: () => connected(new InMemoryAdapter({ provider: 'memory' })),
  SQLiteAdapter: () => connected(new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' })),
};

for (const [name, create] of Object.entries(targets)) {
  describe(`${name} conformance`, () => {
    for (const c of memoryAdapterConformanceCases({
      create,
      release: async (adapter) => {
        await adapter.disconnect();
      },
    })) {
      (c.skip ? it.skip : it)(c.name, () => c.run());
    }
  });
}
