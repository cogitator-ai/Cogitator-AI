import type { Reranker, RetrievalResult } from '@cogitator-ai/types';

/** What the reranker was doing when it failed. */
export interface LLMRerankFailureContext {
  query: string;
  /** The model's raw answer, or undefined when `generateFn` itself failed. */
  response?: string;
}

export interface LLMRerankerConfig {
  generateFn: (prompt: string) => Promise<string>;
  /**
   * Called when the model's answer cannot be turned into a ranking, or `generateFn` fails. The
   * reranker then returns the results in retrieval order (unless `strict` is set) and does not
   * log to the console.
   */
  onError?: (error: LLMRerankError, context: LLMRerankFailureContext) => void;
  /** Throw an `LLMRerankError` instead of falling back to the retrieval order. Defaults to false. */
  strict?: boolean;
}

/** Reranking failed: the model gave no usable ranking, or `generateFn` threw (see `cause`). */
export class LLMRerankError extends Error {
  override readonly name = 'LLMRerankError';

  constructor(
    message: string,
    /** The model's raw answer, when there was one. */
    readonly response?: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

const MAX_DOCUMENTS_IN_PROMPT = 50;

export class LLMReranker implements Reranker {
  private readonly generateFn: (prompt: string) => Promise<string>;
  private readonly onError?: LLMRerankerConfig['onError'];
  private readonly strict: boolean;

  constructor(config: LLMRerankerConfig) {
    this.generateFn = config.generateFn;
    this.onError = config.onError;
    this.strict = config.strict ?? false;
  }

  async rerank(
    query: string,
    results: RetrievalResult[],
    topN?: number
  ): Promise<RetrievalResult[]> {
    if (results.length === 0) return [];

    let response: string | undefined;
    try {
      response = await this.generateFn(this.buildPrompt(query, results));
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
      const failure =
        error instanceof LLMRerankError
          ? error
          : new LLMRerankError(
              `${response === undefined ? 'generateFn failed' : 'Reranking failed'}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              response,
              { cause: error }
            );
      if (this.strict) throw failure;
      if (this.onError) {
        this.onError(failure, { query, response });
      } else {
        console.warn('[LLMReranker] Reranking failed, returning original order:', failure);
      }
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
    if (typeof response !== 'string' || response.trim() === '') {
      throw new LLMRerankError(
        'The model returned an empty response (a reasoning model may have spent its token budget on reasoning)',
        response
      );
    }

    const candidates = response.match(/\[[\s\S]*?\]/g);
    if (!candidates) throw new LLMRerankError('No JSON array found in the response', response);

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

    throw new LLMRerankError(
      'No JSON array of { index, score } objects found in the response',
      response
    );
  }
}
