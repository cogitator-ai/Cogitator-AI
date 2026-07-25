import type { Reranker, RetrievalResult } from '@cogitator-ai/types';

export interface LLMRerankerConfig {
  generateFn: (prompt: string) => Promise<string>;
}

const MAX_DOCUMENTS_IN_PROMPT = 50;

export class LLMReranker implements Reranker {
  private readonly generateFn: (prompt: string) => Promise<string>;

  constructor(config: LLMRerankerConfig) {
    this.generateFn = config.generateFn;
  }

  async rerank(
    query: string,
    results: RetrievalResult[],
    topN?: number
  ): Promise<RetrievalResult[]> {
    if (results.length === 0) return [];

    try {
      const prompt = this.buildPrompt(query, results);
      const response = await this.generateFn(prompt);
      const scores = this.parseScores(response, results.length);

      const scored = results.map((result, i) => {
        const entry = scores.find((s) => s.index === i);
        return { result, llmScore: entry?.score ?? 0 };
      });

      scored.sort((a, b) => b.llmScore - a.llmScore);
      const reranked = scored.map(({ result, llmScore }) => ({
        ...result,
        score: Math.max(0, Math.min(1, llmScore / 10)),
      }));

      return topN ? reranked.slice(0, topN) : reranked;
    } catch (error) {
      console.warn('[LLMReranker] Reranking failed, returning original order:', error);
      const fallback = [...results];
      return topN ? fallback.slice(0, topN) : fallback;
    }
  }

  private buildPrompt(query: string, results: RetrievalResult[]): string {
    const limited = results.slice(0, MAX_DOCUMENTS_IN_PROMPT);
    const docs = limited.map((r, i) => `[${i}] ${r.content}`).join('\n\n');

    return [
      "Score each document's relevance to the query on a scale of 0-10.",
      'Return ONLY a JSON array: [{ "index": number, "score": number }]',
      '',
      `Query: ${query}`,
      '',
      'Documents:',
      docs,
    ].join('\n');
  }

  private parseScores(response: string, count: number): Array<{ index: number; score: number }> {
    const candidates = response.match(/\[[\s\S]*?\]/g);
    if (!candidates) throw new Error('No JSON array found in response');

    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        const parsed: unknown = JSON.parse(candidates[i]);
        if (!Array.isArray(parsed)) continue;

        const scores = parsed.filter(
          (item): item is { index: number; score: number } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).index === 'number' &&
            typeof (item as Record<string, unknown>).score === 'number' &&
            (item as { index: number }).index >= 0 &&
            (item as { index: number }).index < count
        );

        if (scores.length > 0) return scores;
      } catch {
        continue;
      }
    }

    throw new Error('No valid JSON array found in response');
  }
}
