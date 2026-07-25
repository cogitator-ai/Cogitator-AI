import type { HybridSearchWeights, SearchResult } from '@cogitator-ai/types';

export interface RRFConfig {
  k?: number;
}

interface RankedItem {
  id: string;
}

export function reciprocalRankFusion(
  resultSets: RankedItem[][],
  weights: number[],
  config: RRFConfig = {}
): Map<string, number> {
  const k = config.k ?? 60;
  const scores = new Map<string, number>();

  for (let i = 0; i < resultSets.length; i++) {
    const weight = weights[i] ?? 1;
    const results = resultSets[i];
    const seen = new Set<string>();

    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank];
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const rrfScore = weight * (1 / (k + rank + 1));
      scores.set(item.id, (scores.get(item.id) ?? 0) + rrfScore);
    }
  }

  return scores;
}

export function fuseSearchResults(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  weights: HybridSearchWeights,
  config: RRFConfig = {}
): SearchResult[] {
  const vectorRanked: RankedItem[] = vectorResults.map((r) => ({ id: r.id }));
  const keywordRanked: RankedItem[] = keywordResults.map((r) => ({ id: r.id }));

  const fusedScores = reciprocalRankFusion(
    [vectorRanked, keywordRanked],
    [weights.vector, weights.bm25],
    config
  );

  const resultMap = new Map<string, SearchResult>();
  for (const r of vectorResults) {
    resultMap.set(r.id, r);
  }
  for (const r of keywordResults) {
    if (!resultMap.has(r.id)) {
      resultMap.set(r.id, r);
    }
  }

  const vectorScoreMap = new Map(vectorResults.map((r) => [r.id, r.score]));
  const keywordScoreMap = new Map(keywordResults.map((r) => [r.id, r.score]));

  return [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .flatMap(([id, score]) => {
      const original = resultMap.get(id);
      if (!original) return [];
      return [
        {
          ...original,
          score,
          vectorScore: vectorScoreMap.get(id),
          keywordScore: keywordScoreMap.get(id),
        },
      ];
    });
}
