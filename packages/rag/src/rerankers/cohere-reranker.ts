import type { Reranker, RetrievalResult } from '@cogitator-ai/types';

export interface CohereRerankerConfig {
  apiKey: string;
  model?: string;
}

interface CohereRerankResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
}

const DEFAULT_MODEL = 'rerank-v3.5';
const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank';

export class CohereReranker implements Reranker {
  private apiKey: string;
  private model: string;

  constructor(config: CohereRerankerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async rerank(
    query: string,
    results: RetrievalResult[],
    topN?: number
  ): Promise<RetrievalResult[]> {
    const n = topN ?? results.length;

    const response = await fetch(COHERE_RERANK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: results.map((r) => r.content),
        top_n: n,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cohere rerank failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as CohereRerankResponse;

    const mapped = data.results.map(({ index, relevance_score }) => ({
      ...results[index],
      score: relevance_score,
    }));

    return mapped.slice(0, n);
  }
}
