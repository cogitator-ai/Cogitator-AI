import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, fuseSearchResults } from '../search/rrf';
import type { SearchResult } from '@cogitator-ai/types';

function makeResult(id: string, score: number): SearchResult {
  return { id, sourceId: id, sourceType: 'document', content: `content-${id}`, score };
}

describe('reciprocalRankFusion', () => {
  it('computes RRF scores for basic ranked items', () => {
    const set1 = [
      { id: 'a', rank: 0, score: 0.9 },
      { id: 'b', rank: 1, score: 0.8 },
    ];
    const set2 = [
      { id: 'b', rank: 0, score: 5.0 },
      { id: 'c', rank: 1, score: 4.0 },
    ];

    const scores = reciprocalRankFusion([set1, set2], [1, 1]);

    expect(scores.size).toBe(3);
    expect(scores.has('a')).toBe(true);
    expect(scores.has('b')).toBe(true);
    expect(scores.has('c')).toBe(true);

    const scoreB = scores.get('b')!;
    const scoreA = scores.get('a')!;
    expect(scoreB).toBeGreaterThan(scoreA);
  });

  it('uses default k=60', () => {
    const set = [{ id: 'x', rank: 0, score: 1 }];
    const scores = reciprocalRankFusion([set], [1]);

    expect(scores.get('x')).toBeCloseTo(1 / 61, 10);
  });

  it('respects custom k parameter', () => {
    const set = [{ id: 'x', rank: 0, score: 1 }];
    const scores = reciprocalRankFusion([set], [1], { k: 10 });

    expect(scores.get('x')).toBeCloseTo(1 / 11, 10);
  });

  it('returns empty map for empty arrays', () => {
    const scores = reciprocalRankFusion([], []);
    expect(scores.size).toBe(0);
  });

  it('returns empty map when result sets are empty arrays', () => {
    const scores = reciprocalRankFusion([[], []], [1, 1]);
    expect(scores.size).toBe(0);
  });

  it('handles a single result', () => {
    const set = [{ id: 'only', rank: 0, score: 0.5 }];
    const scores = reciprocalRankFusion([set], [1]);

    expect(scores.size).toBe(1);
    expect(scores.get('only')).toBeCloseTo(1 / 61, 10);
  });

  it('applies weights correctly', () => {
    const set1 = [{ id: 'a', rank: 0, score: 1 }];
    const set2 = [{ id: 'b', rank: 0, score: 1 }];

    const scores = reciprocalRankFusion([set1, set2], [0.9, 0.1]);

    const scoreA = scores.get('a')!;
    const scoreB = scores.get('b')!;
    expect(scoreA).toBeGreaterThan(scoreB);
    expect(scoreA / scoreB).toBeCloseTo(9, 5);
  });

  it('accumulates scores for items appearing in multiple sets', () => {
    const set1 = [{ id: 'shared', rank: 0, score: 1 }];
    const set2 = [{ id: 'shared', rank: 0, score: 1 }];

    const scores = reciprocalRankFusion([set1, set2], [1, 1]);
    expect(scores.get('shared')).toBeCloseTo(2 / 61, 10);
  });

  it('uses weight=1 when weight array is shorter than result sets', () => {
    const set1 = [{ id: 'a', rank: 0, score: 1 }];
    const set2 = [{ id: 'b', rank: 0, score: 1 }];

    const scores = reciprocalRankFusion([set1, set2], [0.5]);
    expect(scores.get('a')).toBeCloseTo(0.5 / 61, 10);
    expect(scores.get('b')).toBeCloseTo(1 / 61, 10);
  });

  it('rank position affects score (lower rank = higher score)', () => {
    const set = [
      { id: 'first', rank: 0, score: 1 },
      { id: 'second', rank: 1, score: 1 },
      { id: 'third', rank: 2, score: 1 },
    ];

    const scores = reciprocalRankFusion([set], [1]);
    expect(scores.get('first')!).toBeGreaterThan(scores.get('second')!);
    expect(scores.get('second')!).toBeGreaterThan(scores.get('third')!);
  });
});

describe('fuseSearchResults', () => {
  it('combines vector and keyword results', () => {
    const vectorResults = [makeResult('a', 0.9), makeResult('b', 0.8)];
    const keywordResults = [makeResult('c', 5.0), makeResult('a', 3.0)];

    const fused = fuseSearchResults(vectorResults, keywordResults, { vector: 0.5, bm25: 0.5 });

    expect(fused.length).toBe(3);
    expect(fused.map((r) => r.id)).toContain('a');
    expect(fused.map((r) => r.id)).toContain('b');
    expect(fused.map((r) => r.id)).toContain('c');
  });

  it('overlapping documents get higher fused scores', () => {
    const vectorResults = [makeResult('overlap', 0.9), makeResult('vec-only', 0.8)];
    const keywordResults = [makeResult('overlap', 5.0), makeResult('kw-only', 4.0)];

    const fused = fuseSearchResults(vectorResults, keywordResults, { vector: 0.5, bm25: 0.5 });
    expect(fused[0].id).toBe('overlap');
  });

  it('returns empty array for empty inputs', () => {
    const fused = fuseSearchResults([], [], { vector: 0.5, bm25: 0.5 });
    expect(fused).toEqual([]);
  });

  it('handles only vector results', () => {
    const vectorResults = [makeResult('a', 0.9), makeResult('b', 0.7)];
    const fused = fuseSearchResults(vectorResults, [], { vector: 0.5, bm25: 0.5 });

    expect(fused.length).toBe(2);
    expect(fused[0].id).toBe('a');
  });

  it('handles only keyword results', () => {
    const keywordResults = [makeResult('x', 5.0), makeResult('y', 3.0)];
    const fused = fuseSearchResults([], keywordResults, { vector: 0.5, bm25: 0.5 });

    expect(fused.length).toBe(2);
    expect(fused[0].id).toBe('x');
  });

  it('higher vector weight favors vector-first documents', () => {
    const vectorResults = [makeResult('vec-top', 0.99)];
    const keywordResults = [makeResult('kw-top', 10.0)];

    const fused = fuseSearchResults(vectorResults, keywordResults, { vector: 0.9, bm25: 0.1 });
    expect(fused[0].id).toBe('vec-top');
  });

  it('higher bm25 weight favors keyword-first documents', () => {
    const vectorResults = [makeResult('vec-top', 0.99)];
    const keywordResults = [makeResult('kw-top', 10.0)];

    const fused = fuseSearchResults(vectorResults, keywordResults, { vector: 0.1, bm25: 0.9 });
    expect(fused[0].id).toBe('kw-top');
  });

  it('attaches vectorScore and keywordScore to results', () => {
    const vectorResults = [makeResult('a', 0.95)];
    const keywordResults = [makeResult('a', 7.5)];

    const fused = fuseSearchResults(vectorResults, keywordResults, { vector: 0.5, bm25: 0.5 });

    expect(fused.length).toBe(1);
    expect(fused[0].vectorScore).toBe(0.95);
    expect(fused[0].keywordScore).toBe(7.5);
  });

  it('vectorScore is undefined for keyword-only results', () => {
    const keywordResults = [makeResult('kw', 5.0)];
    const fused = fuseSearchResults([], keywordResults, { vector: 0.5, bm25: 0.5 });

    expect(fused[0].vectorScore).toBeUndefined();
    expect(fused[0].keywordScore).toBe(5.0);
  });

  it('keywordScore is undefined for vector-only results', () => {
    const vectorResults = [makeResult('vec', 0.9)];
    const fused = fuseSearchResults(vectorResults, [], { vector: 0.5, bm25: 0.5 });

    expect(fused[0].keywordScore).toBeUndefined();
    expect(fused[0].vectorScore).toBe(0.9);
  });

  it('results are sorted by fused score descending', () => {
    const vectorResults = [makeResult('a', 0.9), makeResult('b', 0.8), makeResult('c', 0.7)];
    const keywordResults = [makeResult('c', 10), makeResult('b', 5), makeResult('a', 1)];

    const fused = fuseSearchResults(vectorResults, keywordResults, { vector: 0.5, bm25: 0.5 });

    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
  });

  it('preserves original content from vector results for overlapping docs', () => {
    const vectorResults: SearchResult[] = [
      { id: 'dup', sourceId: 'dup', sourceType: 'document', content: 'from-vector', score: 0.9 },
    ];
    const keywordResults: SearchResult[] = [
      { id: 'dup', sourceId: 'dup', sourceType: 'document', content: 'from-keyword', score: 5.0 },
    ];

    const fused = fuseSearchResults(vectorResults, keywordResults, { vector: 0.5, bm25: 0.5 });
    expect(fused[0].content).toBe('from-vector');
  });

  it('passes custom k config to reciprocalRankFusion', () => {
    const vectorResults = [makeResult('a', 0.9)];
    const defaultK = fuseSearchResults(vectorResults, [], { vector: 1, bm25: 0 });
    const customK = fuseSearchResults(vectorResults, [], { vector: 1, bm25: 0 }, { k: 1 });

    expect(customK[0].score).toBeGreaterThan(defaultK[0].score);
  });
});
