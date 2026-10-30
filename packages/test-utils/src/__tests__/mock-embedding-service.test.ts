import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmbeddingService, createMockEmbeddingService } from '../mocks/mock-embedding-service';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

describe('MockEmbeddingService', () => {
  let embedder: MockEmbeddingService;

  beforeEach(() => {
    embedder = createMockEmbeddingService();
  });

  it('embeds the same text to the same vector every time', async () => {
    const first = await embedder.embed('the cat sat');
    const second = await embedder.embed('the cat sat');

    expect(first).toEqual(second);
  });

  it('returns vectors with the configured dimensions and reports the model', async () => {
    const small = new MockEmbeddingService({ dimensions: 8, model: 'mock-8d' });
    const vector = await small.embed('hello');

    expect(vector).toHaveLength(8);
    expect(small.dimensions).toBe(8);
    expect(small.model).toBe('mock-8d');
    expect(embedder.dimensions).toBe(64);
    expect(embedder.model).toBe('mock-embedding');
  });

  it('gives texts that share words a higher cosine similarity', async () => {
    const cat = await embedder.embed('the cat sat');
    const catAgain = await embedder.embed('cat sat');
    const market = await embedder.embed('stock prices');

    expect(cosine(cat, catAgain)).toBeGreaterThan(cosine(cat, market));
    expect(cosine(cat, catAgain)).toBeGreaterThan(0.5);
  });

  it('keeps unrelated texts far apart', async () => {
    const cat = await embedder.embed('the cat sat');
    const market = await embedder.embed('stock prices');
    const physics = await embedder.embed('quantum physics lecture');
    const bread = await embedder.embed('banana bread recipe');

    expect(cosine(cat, market)).toBeLessThan(0.3);
    expect(cosine(physics, bread)).toBeLessThan(0.3);
  });

  it('splits words in scripts that are not Latin', async () => {
    const russian = await embedder.embed('привет мир');
    const japanese = await embedder.embed('日本語のテキスト');
    const accented = await embedder.embed('café');

    expect(cosine(russian, japanese)).toBeLessThan(0.3);
    expect(accented).not.toEqual(await embedder.embed('caf'));
  });

  it('gives every dimension its own value above the digest length', async () => {
    const wide = new MockEmbeddingService({ dimensions: 96 });
    const vector = await wide.embed('the cat sat');

    expect(vector).toHaveLength(96);
    expect(new Set(vector).size).toBeGreaterThan(64);
  });

  it('embedBatch matches embed item for item', async () => {
    const texts = ['the cat sat', 'stock prices', ''];
    const batched = await embedder.embedBatch(texts);

    for (let i = 0; i < texts.length; i++) {
      const single = await new MockEmbeddingService().embed(texts[i]);
      expect(batched[i]).toEqual(single);
    }
  });

  it('setEmbedding wins over the hashed vector', async () => {
    const pinned = new Array(64).fill(0);
    pinned[0] = 1;
    embedder.setEmbedding('the cat sat', pinned);

    expect(await embedder.embed('the cat sat')).toEqual(pinned);
    expect(await embedder.embed('cat sat')).not.toEqual(pinned);
  });

  it('records every embed and embedBatch call', async () => {
    await embedder.embed('a');
    await embedder.embedBatch(['b', 'c']);
    await embedder.embed('d');

    expect(embedder.getCalls().map((call) => call.method)).toEqual([
      'embed',
      'embedBatch',
      'embed',
    ]);
    expect(embedder.getCallsFor('embedBatch')).toHaveLength(1);
    expect(embedder.getCallsFor('embed')[1].args).toEqual(['d']);

    embedder.reset();
    expect(embedder.getCalls()).toEqual([]);
    expect(await embedder.embed('a')).toEqual(await new MockEmbeddingService().embed('a'));
  });

  it('embeds the same word in NFC and NFD forms to the same vector', async () => {
    const precomposed = 'café'; // é as one code point
    const decomposed = 'cafe\u0301'; // e plus a combining acute accent

    expect(await embedder.embed(precomposed)).toEqual(await embedder.embed(decomposed));
  });

  it('rejects a setEmbedding vector with the wrong length', () => {
    expect(() => embedder.setEmbedding('the cat sat', [1, 2, 3])).toThrow(/dimensions/);
  });

  it('rejects a dimensions option that is not a positive integer', () => {
    expect(() => new MockEmbeddingService({ dimensions: 0 })).toThrow(/positive integer/);
    expect(() => new MockEmbeddingService({ dimensions: 8.5 })).toThrow(/positive integer/);
    expect(() => new MockEmbeddingService({ dimensions: -3 })).toThrow(/positive integer/);
  });
});
