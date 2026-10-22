import { normalTwoSidedP } from './normal';
import { averageRanks, tieGroups } from './ranks';
import { pairedDifference } from './precision';

export interface WilcoxonResult {
  /** W+: the sum of the ranks of the positive differences `a - b` */
  statistic: number;
  /** Pairs left once the zero differences are dropped */
  n: number;
  pValue: number;
  significant: boolean;
  /** `exact` for up to 20 pairs, `normal` (with tie and continuity corrections) above */
  method: 'exact' | 'normal';
}

const EXACT_UP_TO = 20;

/**
 * Wilcoxon signed-rank test of paired samples, two-sided. The differences `a - b` are rounded to
 * 12 significant digits first, so float noise neither splits ties nor hides a zero. Zero differences are dropped
 * (Wilcoxon's handling, not Pratt's), tied absolute differences share their mean rank. The
 * p-value is exact for up to 20 nonzero pairs, ties included, and from the normal approximation
 * with tie and continuity corrections above
 */
export function wilcoxonSignedRank(
  samplesA: readonly number[],
  samplesB: readonly number[]
): WilcoxonResult {
  if (samplesA.length !== samplesB.length) {
    throw new Error('Sample arrays must have equal length');
  }
  const differences = samplesA
    .map((a, i) => pairedDifference(a, samplesB[i]))
    .filter((d) => d !== 0);
  const n = differences.length;
  if (n === 0) return { statistic: 0, n: 0, pValue: 1, significant: false, method: 'exact' };

  const magnitudes = differences.map(Math.abs);
  const ranks = averageRanks(magnitudes);
  const statistic = ranks.reduce((sum, rank, i) => (differences[i] > 0 ? sum + rank : sum), 0);

  const pValue =
    n <= EXACT_UP_TO ? exactP(ranks, statistic) : normalP(n, statistic, tieGroups(magnitudes));
  return {
    statistic,
    n,
    pValue,
    significant: pValue < 0.05,
    method: n <= EXACT_UP_TO ? 'exact' : 'normal',
  };
}

/**
 * The exact two-sided p-value of W+ over every assignment of signs to the ranks, counted on
 * doubled ranks so mean ranks of ties stay integers
 */
function exactP(ranks: readonly number[], statistic: number): number {
  const doubled = ranks.map((rank) => Math.round(rank * 2));
  const total = doubled.reduce((sum, r) => sum + r, 0);
  let counts = new Array<number>(total + 1).fill(0);
  counts[0] = 1;
  for (const r of doubled) {
    const next = [...counts];
    for (let s = 0; s + r <= total; s++) next[s + r] += counts[s];
    counts = next;
  }
  const observed = Math.round(statistic * 2);
  const outcomes = 2 ** ranks.length;
  let lower = 0;
  let upper = 0;
  for (let s = 0; s <= total; s++) {
    if (s <= observed) lower += counts[s];
    if (s >= observed) upper += counts[s];
  }
  return Math.min(1, (2 * Math.min(lower, upper)) / outcomes);
}

function normalP(n: number, statistic: number, ties: readonly number[]): number {
  const expected = (n * (n + 1)) / 4;
  const tieCorrection = ties.reduce((sum, t) => sum + (t ** 3 - t), 0) / 48;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection;
  if (variance <= 0) return 1;
  const distance = Math.max(0, Math.abs(statistic - expected) - 0.5);
  return normalTwoSidedP(distance / Math.sqrt(variance));
}
