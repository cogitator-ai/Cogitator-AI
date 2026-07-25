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
const DEFAULT_TIMEOUT_MS = 30_000;

export class CohereReranker implements Reranker {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: CohereRerankerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async rerank(
    query: string,
    results: RetrievalResult[],
    topN?: number
  ): Promise<RetrievalResult[]> {
    if (results.length === 0) return [];

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
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cohere rerank failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as CohereRerankResponse;

    if (!Array.isArray(data.results)) {
      throw new Error('Cohere rerank returned unexpected response: missing results array');
    }

    const mapped = data.results
      .filter(({ index }) => index >= 0 && index < results.length)
      .map(({ index, relevance_score }) => ({
        ...results[index],
        score: relevance_score,
      }));

    return mapped.slice(0, n);
  }
}
