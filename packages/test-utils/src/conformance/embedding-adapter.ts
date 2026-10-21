import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Embedding, EmbeddingAdapter, MemoryResult } from '@cogitator-ai/types';

/** An embedding store under test, with vectors of `dimensions` numbers. */
export interface EmbeddingAdapterConformanceTarget<T extends EmbeddingAdapter = EmbeddingAdapter> {
  /** A connected store. Cases only touch embeddings of their own, so it may be shared. */
  create(): Promise<T>;
  /** Called with each store `create` made once its case is done */
  release?(adapter: T): Promise<void>;
  /** Vector size the store was made for, at least 3 */
  dimensions: number;
  /** Cases to leave out, with the reason */
  skip?: Partial<Record<EmbeddingAdapterScenario, string>>;
}

export type EmbeddingAdapterScenario =
  | 'nearest-first'
  | 'threshold-and-limit'
  | 'filters'
  | 'user-scope'
  | 'delete-embedding'
  | 'delete-by-source'
  | 'delete-by-filter'
  | 'missing-not-null';

/** One case of the embedding store contract. */
export interface EmbeddingAdapterConformanceCase {
  name: EmbeddingAdapterScenario;
  /** Why the case does not apply, when it does not */
  skip?: string;
  /** Runs the case; throws an `AssertionError` when the store breaks the contract */
  run(): Promise<void>;
}

function ok<T>(result: MemoryResult<T>, what: string): T {
  if (!result.success) assert.fail(`${what} failed: ${result.error}`);
  return result.data;
}

/** A unit vector along `axis` of `dimensions`, nudged toward the next axis by `tilt`. */
function axis(dimensions: number, index: number, tilt = 0): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[index % dimensions] = 1;
  vector[(index + 1) % dimensions] = tilt;
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

type NewEmbedding = Omit<Embedding, 'id' | 'createdAt'>;

function scope() {
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  return {
    agentId: `conformance-agent-${tag}`,
    source: (name: string) => `conformance-${tag}-${name}`,
  };
}

async function add(adapter: EmbeddingAdapter, embedding: NewEmbedding): Promise<Embedding> {
  return ok(await adapter.addEmbedding(embedding), 'addEmbedding');
}

const SCENARIOS: Record<
  EmbeddingAdapterScenario,
  (adapter: EmbeddingAdapter, dimensions: number) => Promise<void>
> = {
  async 'nearest-first'(adapter, dimensions) {
    const { agentId, source } = scope();
    const near = await add(adapter, {
      sourceId: source('near'),
      sourceType: 'document',
      vector: axis(dimensions, 0, 0.1),
      content: 'near',
      metadata: { agentId },
    });
    await add(adapter, {
      sourceId: source('far'),
      sourceType: 'document',
      vector: axis(dimensions, 0, 2),
      content: 'far',
      metadata: { agentId },
    });
    const found = ok(
      await adapter.search({
        vector: axis(dimensions, 0),
        limit: 5,
        threshold: 0,
        filter: { agentId },
      }),
      'search'
    );
    assert.deepEqual(
      found.map((result) => result.content),
      ['near', 'far']
    );
    assert.equal(found[0].id, near.id);
    assert.ok(found[0].score >= found[1].score, 'scores fall with distance');
    assert.ok(found[0].score <= 1.0001 && found[0].score > 0.9);
  },

  async 'threshold-and-limit'(adapter, dimensions) {
    const { agentId, source } = scope();
    for (const [index, tilt] of [0, 0.2, 0.5, 5].entries()) {
      await add(adapter, {
        sourceId: source(String(index)),
        sourceType: 'document',
        vector: axis(dimensions, 0, tilt),
        content: `c${index}`,
        metadata: { agentId },
      });
    }
    const limited = ok(
      await adapter.search({ vector: axis(dimensions, 0), limit: 2, filter: { agentId } }),
      'search with a limit'
    );
    assert.deepEqual(
      limited.map((result) => result.content),
      ['c0', 'c1']
    );
    const close = ok(
      await adapter.search({
        vector: axis(dimensions, 0),
        limit: 10,
        threshold: 0.85,
        filter: { agentId },
      }),
      'search with a threshold'
    );
    assert.deepEqual(close.map((result) => result.content).sort(), ['c0', 'c1', 'c2']);
    for (const result of close) assert.ok(result.score >= 0.85);
  },

  async filters(adapter, dimensions) {
    const { agentId, source } = scope();
    const vector = axis(dimensions, 1);
    await add(adapter, {
      sourceId: source('a'),
      sourceType: 'message',
      vector,
      content: 'message in t1',
      metadata: { agentId, threadId: 't1', lang: 'en', rank: 1 },
    });
    await add(adapter, {
      sourceId: source('b'),
      sourceType: 'document',
      vector,
      content: 'document in t2',
      metadata: { agentId, threadId: 't2', lang: 'de', rank: 2 },
    });
    const contents = async (filter: object) =>
      ok(await adapter.search({ vector, limit: 10, filter: { agentId, ...filter } }), 'search').map(
        (result) => result.content
      );
    assert.deepEqual(await contents({ sourceType: 'message' }), ['message in t1']);
    assert.deepEqual(await contents({ threadId: 't2' }), ['document in t2']);
    assert.deepEqual(await contents({ metadata: { lang: 'de' } }), ['document in t2']);
    assert.deepEqual(await contents({ metadata: { rank: 1 } }), ['message in t1']);
    assert.deepEqual(await contents({ metadata: { rank: '1' } }), [], 'values compare by type');
  },

  async 'user-scope'(adapter, dimensions) {
    const { agentId, source } = scope();
    const vector = axis(dimensions, 2);
    for (const owner of ['alice', 'bob', undefined]) {
      await add(adapter, {
        sourceId: source(owner ?? 'shared'),
        sourceType: 'fact',
        vector,
        content: owner ?? 'shared',
        metadata: { agentId, ...(owner && { userId: owner }) },
      });
    }
    const found = ok(
      await adapter.search({ vector, limit: 10, filter: { agentId, userId: 'alice' } }),
      'search for a user'
    );
    assert.deepEqual(found.map((result) => result.content).sort(), ['alice', 'shared']);
  },

  async 'delete-embedding'(adapter, dimensions) {
    const { agentId, source } = scope();
    const vector = axis(dimensions, 0);
    const gone = await add(adapter, {
      sourceId: source('gone'),
      sourceType: 'document',
      vector,
      content: 'gone',
      metadata: { agentId },
    });
    await add(adapter, {
      sourceId: source('stays'),
      sourceType: 'document',
      vector,
      content: 'stays',
      metadata: { agentId },
    });
    ok(await adapter.deleteEmbedding(gone.id), 'deleteEmbedding');
    const found = ok(await adapter.search({ vector, limit: 10, filter: { agentId } }), 'search');
    assert.deepEqual(
      found.map((result) => result.content),
      ['stays']
    );
  },

  async 'delete-by-source'(adapter, dimensions) {
    const { agentId, source } = scope();
    const vector = axis(dimensions, 0);
    for (const part of ['1', '2']) {
      await add(adapter, {
        sourceId: source('doc'),
        sourceType: 'document',
        vector,
        content: `doc part ${part}`,
        metadata: { agentId },
      });
    }
    await add(adapter, {
      sourceId: source('other'),
      sourceType: 'document',
      vector,
      content: 'other',
      metadata: { agentId },
    });
    ok(await adapter.deleteBySource(source('doc')), 'deleteBySource');
    const found = ok(await adapter.search({ vector, limit: 10, filter: { agentId } }), 'search');
    assert.deepEqual(
      found.map((result) => result.content),
      ['other']
    );
  },

  async 'delete-by-filter'(adapter, dimensions) {
    if (!adapter.deleteByFilter) return;
    const { agentId, source } = scope();
    const vector = axis(dimensions, 0);
    for (const lang of ['en', 'de']) {
      await add(adapter, {
        sourceId: source(lang),
        sourceType: 'document',
        vector,
        content: lang,
        metadata: { agentId, lang },
      });
    }
    assert.equal(
      (await adapter.deleteByFilter({})).success,
      false,
      'a filter without any condition is refused'
    );
    ok(await adapter.deleteByFilter({ agentId, metadata: { lang: 'en' } }), 'deleteByFilter');
    const found = ok(await adapter.search({ vector, limit: 10, filter: { agentId } }), 'search');
    assert.deepEqual(
      found.map((result) => result.content),
      ['de']
    );
  },

  async 'missing-not-null'(adapter, dimensions) {
    const { agentId, source } = scope();
    const vector = axis(dimensions, 0);
    const added = await add(adapter, {
      sourceId: source('plain'),
      sourceType: 'document',
      vector,
      content: 'plain',
      metadata: { agentId },
    });
    assert.ok(added.id && added.createdAt instanceof Date);
    const [found] = ok(await adapter.search({ vector, limit: 1, filter: { agentId } }), 'search');
    for (const [key, value] of Object.entries(found)) {
      assert.notEqual(value, null, `${key} comes back absent, not null`);
    }
    assert.equal(found.sourceId, source('plain'));
    assert.equal(found.sourceType, 'document');
  },
};

/**
 * The cases of the embedding store contract, each against a store `target` makes. Framework
 * agnostic: run each case's `run()` in any test runner.
 */
export function embeddingAdapterConformanceCases<T extends EmbeddingAdapter>(
  target: EmbeddingAdapterConformanceTarget<T>
): EmbeddingAdapterConformanceCase[] {
  return (Object.keys(SCENARIOS) as EmbeddingAdapterScenario[]).map((name) => {
    const skip = target.skip?.[name];
    return {
      name,
      ...(skip && { skip }),
      run: async () => {
        const adapter = await target.create();
        try {
          await SCENARIOS[name](adapter, target.dimensions);
        } finally {
          await target.release?.(adapter);
        }
      },
    };
  });
}
