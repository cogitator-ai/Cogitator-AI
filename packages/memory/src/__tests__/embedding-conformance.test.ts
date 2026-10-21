import { describe, it } from 'vitest';
import { embeddingAdapterConformanceCases } from '@cogitator-ai/test-utils';
import { InMemoryEmbeddingAdapter } from '../adapters/memory-embedding';

describe('InMemoryEmbeddingAdapter conformance', () => {
  for (const c of embeddingAdapterConformanceCases({
    create: async () => new InMemoryEmbeddingAdapter(),
    dimensions: 8,
  })) {
    (c.skip ? it.skip : it)(c.name, () => c.run());
  }
});
