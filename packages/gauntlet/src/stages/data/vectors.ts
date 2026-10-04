import { unwrap } from '@cogitator-ai/memory';
import type { EmbeddingAdapter, EmbeddingService } from '@cogitator-ai/types';
import type { StageContext } from '../../runner/types.js';

/** Small corpus whose documents share few words, so a bag-of-words query has one clear winner. */
export const VECTOR_CORPUS = [
  {
    sourceId: 'doc-lighthouse',
    content: 'The lighthouse keeper logs storm warnings and lamp oil every evening.',
    metadata: { agentId: 'keeper', topic: 'coast' },
  },
  {
    sourceId: 'doc-orchard',
    content: 'Orchard apples are picked in late autumn and pressed into cider.',
    metadata: { agentId: 'keeper', userId: 'user-ada', topic: 'farm' },
  },
  {
    sourceId: 'doc-observatory',
    content: 'The observatory telescope tracks comets and distant galaxies at night.',
    metadata: { agentId: 'astronomer', topic: 'sky' },
  },
  {
    sourceId: 'doc-bakery',
    content: 'The bakery ovens bake sourdough bread and cinnamon rolls at dawn.',
    metadata: { agentId: 'keeper', userId: 'user-bob', topic: 'town' },
  },
] as const;

/**
 * Store, search, filter and delete against one connected `EmbeddingAdapter`, with vectors from
 * `embeddings`. Checks are named after the store.
 */
export async function exerciseVectorStore(
  ctx: StageContext,
  store: string,
  adapter: EmbeddingAdapter,
  embeddings: EmbeddingService
): Promise<void> {
  const stored = await ctx.check(`${store}: stores document embeddings`, async (evidence) => {
    const vectors = await embeddings.embedBatch(VECTOR_CORPUS.map((doc) => doc.content));
    const ids: string[] = [];
    for (const [index, doc] of VECTOR_CORPUS.entries()) {
      const embedding = unwrap(
        await adapter.addEmbedding({
          sourceId: doc.sourceId,
          sourceType: 'document',
          vector: vectors[index]!,
          content: doc.content,
          metadata: { ...doc.metadata },
        })
      );
      ids.push(embedding.id);
    }
    evidence('ids', ids);
    evidence('dimensions', embeddings.dimensions);
    return ids;
  });

  await ctx.check(`${store}: nearest neighbour is the matching document`, async (evidence) => {
    const vector = await embeddings.embed('When are comets tracked by the telescope?');
    const hits = unwrap(await adapter.search({ vector, limit: 2, threshold: 0 }));
    evidence(
      'top',
      hits.map((hit) => `${hit.sourceId} ${hit.score.toFixed(3)}`)
    );
    if (hits[0]?.sourceId !== 'doc-observatory') {
      throw new Error(`Top hit is ${hits[0]?.sourceId ?? 'nothing'}, expected doc-observatory`);
    }
    if (!hits[0].content.includes('telescope'))
      throw new Error('The hit came back without its content');
    if (hits[0].metadata?.topic !== 'sky') {
      throw new Error(`Hit metadata came back as ${JSON.stringify(hits[0].metadata)}`);
    }
  });

  await ctx.check(`${store}: agentId and userId filters scope results`, async (evidence) => {
    const vector = await embeddings.embed('bakery bread at dawn and orchard cider');
    const keeper = unwrap(
      await adapter.search({ vector, limit: 10, threshold: 0, filter: { agentId: 'keeper' } })
    );
    const ada = unwrap(
      await adapter.search({
        vector,
        limit: 10,
        threshold: 0,
        filter: { agentId: 'keeper', userId: 'user-ada' },
      })
    );
    const keeperIds = keeper.map((hit) => hit.sourceId).sort();
    const adaIds = ada.map((hit) => hit.sourceId).sort();
    evidence('keeper', keeperIds);
    evidence('keeperForAda', adaIds);
    if (keeperIds.join() !== 'doc-bakery,doc-lighthouse,doc-orchard') {
      throw new Error(`agentId filter returned ${keeperIds.join(', ')}`);
    }
    if (adaIds.join() !== 'doc-lighthouse,doc-orchard') {
      throw new Error(
        `userId filter returned ${adaIds.join(', ')}, expected Ada's document and the shared one`
      );
    }
  });

  await ctx.check(`${store}: deletes by id and by source`, async (evidence) => {
    unwrap(await adapter.deleteBySource('doc-observatory'));
    unwrap(await adapter.deleteEmbedding(stored[0]!));
    const vector = await embeddings.embed('the and in at');
    const left = unwrap(await adapter.search({ vector, limit: 10, threshold: 0 }));
    const ids = left.map((hit) => hit.sourceId).sort();
    evidence('remaining', ids);
    if (ids.includes('doc-observatory')) throw new Error('deleteBySource left the document');
    if (ids.includes('doc-lighthouse')) throw new Error('deleteEmbedding left the embedding');
    if (ids.length !== VECTOR_CORPUS.length - 2) {
      throw new Error(`Expected ${VECTOR_CORPUS.length - 2} embeddings left, found ${ids.length}`);
    }
  });
}
