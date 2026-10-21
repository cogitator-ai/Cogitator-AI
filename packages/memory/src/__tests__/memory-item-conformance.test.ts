import { describe, it } from 'vitest';
import { memoryItemAdapterConformanceCases } from '@cogitator-ai/test-utils';
import type { MemoryItemAdapter } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';

const targets: Record<string, () => Promise<MemoryItemAdapter>> = {
  InMemoryAdapter: async () => new InMemoryAdapter({ provider: 'memory' }),
};

for (const [name, create] of Object.entries(targets)) {
  describe(`${name} memory item conformance`, () => {
    for (const c of memoryItemAdapterConformanceCases({ create })) {
      (c.skip ? it.skip : it)(c.name, () => c.run());
    }
  });
}
