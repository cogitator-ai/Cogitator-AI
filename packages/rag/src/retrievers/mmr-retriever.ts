import type {
  EmbeddingAdapter,
  EmbeddingService,
  Embedding,
  Retriever,
  RetrievalConfig,
  RetrievalResult,
} from '@cogitator-ai/types';

export interface MMRRetrieverConfig {
  embeddingAdapter: EmbeddingAdapter;
  embeddingService: EmbeddingService;
  defaultLambda?: number;
  defaultTopK?: number;
  defaultThreshold?: number;
}

const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.0;
const DEFAULT_LAMBDA = 0.7;
const CANDIDATE_MULTIPLIER = 3;

type ScoredEmbedding = Embedding & { score: number };

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class MMRRetriever implements Retriever {
  private readonly adapter: EmbeddingAdapter;
  private readonly embedding: EmbeddingService;
  private readonly defaultLambda: number;
  private readonly defaultTopK: number;
  private readonly defaultThreshold: number;

  constructor(config: MMRRetrieverConfig) {
    this.adapter = config.embeddingAdapter;
    this.embedding = config.embeddingService;
    this.defaultLambda = config.defaultLambda ?? DEFAULT_LAMBDA;
    this.defaultTopK = config.defaultTopK ?? DEFAULT_TOP_K;
    this.defaultThreshold = config.defaultThreshold ?? DEFAULT_THRESHOLD;
  }

  async retrieve(query: string, options?: Partial<RetrievalConfig>): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? this.defaultTopK;
    const threshold = options?.threshold ?? this.defaultThreshold;
    const queryVector = await this.embedding.embed(query);

    const result = await this.adapter.search({
      vector: queryVector,
      query,
      limit: topK * CANDIDATE_MULTIPLIER,
      threshold,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    const candidates = result.data;
    if (candidates.length === 0) return [];

    const selected = this.selectMMR(candidates, topK);
    return selected.map((entry) => this.toRetrievalResult(entry));
  }

  private selectMMR(
    candidates: ScoredEmbedding[],
    topK: number
  ): (ScoredEmbedding & { mmrScore: number })[] {
    const lambda = this.defaultLambda;
    const remaining = new Set(candidates.map((_, i) => i));
    const selected: (ScoredEmbedding & { mmrScore: number })[] = [];

    while (selected.length < topK && remaining.size > 0) {
      let bestIdx = -1;
      let bestScore = -Infinity;

      for (const idx of remaining) {
        const relevance = candidates[idx].score;

        let maxSelectedSim = 0;
        for (const sel of selected) {
          const sim = cosineSimilarity(candidates[idx].vector, sel.vector);
          if (sim > maxSelectedSim) maxSelectedSim = sim;
        }

        const mmrScore = lambda * relevance - (1 - lambda) * maxSelectedSim;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = idx;
        }
      }

      if (bestIdx === -1) break;

      remaining.delete(bestIdx);
      selected.push({ ...candidates[bestIdx], mmrScore: bestScore });
    }

    return selected;
  }

  private toRetrievalResult(entry: ScoredEmbedding & { mmrScore: number }): RetrievalResult {
    const rawDocId = entry.metadata?.documentId;
    const documentId = typeof rawDocId === 'string' ? rawDocId : entry.sourceId;

    return {
      chunkId: entry.sourceId,
      documentId,
      content: entry.content,
      score: entry.mmrScore,
      source: entry.sourceType,
      metadata: entry.metadata,
    };
  }
}
