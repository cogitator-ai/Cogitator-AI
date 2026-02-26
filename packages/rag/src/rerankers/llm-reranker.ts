import type { Reranker, RetrievalResult } from '@cogitator-ai/types';

export interface LLMRerankerConfig {
  generateFn: (prompt: string) => Promise<string>;
}

export class LLMReranker implements Reranker {
  private generateFn: (prompt: string) => Promise<string>;

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
    } catch {
      const fallback = [...results];
      return topN ? fallback.slice(0, topN) : fallback;
    }
  }

  private buildPrompt(query: string, results: RetrievalResult[]): string {
    const docs = results.map((r, i) => `[${i}] ${r.content}`).join('\n\n');

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
    const jsonMatch = /\[[\s\S]*?\]/.exec(response);
    if (!jsonMatch) throw new Error('No JSON array found in response');

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('Response is not an array');

    return parsed.filter(
      (item): item is { index: number; score: number } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).index === 'number' &&
        typeof (item as Record<string, unknown>).score === 'number' &&
        (item as { index: number }).index >= 0 &&
        (item as { index: number }).index < count
    );
  }
}
