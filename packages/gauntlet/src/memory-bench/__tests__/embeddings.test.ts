import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BenchEmbeddingService,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embeddingProvider,
} from '../embeddings.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  return calls;
}

const vector = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => seed + i);

describe('embeddingProvider', () => {
  it('takes the provider named, and no other name', () => {
    expect(embeddingProvider('openrouter', {})).toBe('openrouter');
    expect(embeddingProvider('google', {})).toBe('google');
    expect(embeddingProvider('openai', {})).toBeUndefined();
  });

  it('defaults to Google with its key and to OpenRouter without it', () => {
    expect(embeddingProvider(undefined, { GOOGLE_API_KEY: 'key' })).toBe('google');
    expect(embeddingProvider(undefined, { OPENROUTER_API_KEY: 'key' })).toBe('openrouter');
    expect(embeddingProvider(undefined, {})).toBe('openrouter');
  });
});

describe('BenchEmbeddingService', () => {
  it('names the model, not the route, so both providers share the cache', () => {
    const google = new BenchEmbeddingService('google', 'key');
    const openrouter = new BenchEmbeddingService('openrouter', 'key');
    expect([google.model, google.dimensions]).toEqual([EMBEDDING_MODEL, EMBEDDING_DIMENSIONS]);
    expect([openrouter.model, openrouter.dimensions]).toEqual([google.model, google.dimensions]);
  });

  it('asks OpenRouter for the Google model in order', async () => {
    const calls = stubFetch({
      data: [
        { index: 1, embedding: vector(2) },
        { index: 0, embedding: vector(1) },
      ],
    });
    const service = new BenchEmbeddingService('openrouter', 'or-key');

    const vectors = await service.embedBatch(['first', 'second']);

    expect(vectors).toEqual([vector(1), vector(2)]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: `google/${EMBEDDING_MODEL}`,
      input: ['first', 'second'],
    });
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer or-key');
  });

  it('refuses vectors of another size', async () => {
    stubFetch({ data: [{ index: 0, embedding: [1, 2, 3] }] });
    await expect(new BenchEmbeddingService('openrouter', 'key').embed('text')).rejects.toThrow(
      /3-dimensional/
    );
  });
});
