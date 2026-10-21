import { describe, it } from 'vitest';
import {
  memoryItemAdapterConformanceCases,
  type MemoryItemAdapterConformanceTarget,
} from '@cogitator-ai/test-utils';
import type { MemoryItemAdapter } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { SQLiteAdapter } from '../adapters/sqlite';

function conformance<T extends MemoryItemAdapter>(
  name: string,
  target: MemoryItemAdapterConformanceTarget<T>
): void {
  describe(`${name} memory item conformance`, () => {
    for (const c of memoryItemAdapterConformanceCases(target)) {
      (c.skip ? it.skip : it)(c.name, () => c.run());
    }
  });
}

conformance('InMemoryAdapter', {
  create: async () => new InMemoryAdapter({ provider: 'memory' }),
});

conformance('SQLiteAdapter', {
  create: async () => {
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' });
    const connected = await adapter.connect();
    if (!connected.success) throw new Error(connected.error);
    return adapter;
  },
  release: async (adapter) => {
    await adapter.disconnect();
  },
});
