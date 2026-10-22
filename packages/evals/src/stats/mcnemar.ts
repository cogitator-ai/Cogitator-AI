import { erfc } from './normal';

export interface McNemarResult {
  chiSquare: number;
  pValue: number;
  significant: boolean;
}

function chiSquareSurvival(x: number): number {
  if (x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}

export function mcnemarsTest(
  pairsACorrect_BIncorrect: number,
  pairsAIncorrect_BCorrect: number
): McNemarResult {
  const b = pairsACorrect_BIncorrect;
  const c = pairsAIncorrect_BCorrect;

  if (b + c === 0) {
    return { chiSquare: 0, pValue: 1, significant: false };
  }

  const diff = Math.max(0, Math.abs(b - c) - 1);
  const chiSquare = (diff * diff) / (b + c);
  const pValue = chiSquareSurvival(chiSquare);

  return {
    chiSquare,
    pValue,
    significant: pValue < 0.05,
  };
}

export interface McNemarExactResult {
  pValue: number;
  significant: boolean;
}

/**
 * Exact McNemar test: the two-sided binomial test of `b` against `b + c` discordant pairs at
 * one half. Preferred over `mcnemarsTest` when there are few discordant pairs (below 25)
 */
export function mcnemarExact(b: number, c: number): McNemarExactResult {
  for (const [label, count] of [
    ['b', b],
    ['c', c],
  ] as const) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${label} must be a non-negative integer, got ${count}`);
    }
  }
  const n = b + c;
  if (n === 0) return { pValue: 1, significant: false };
  const k = Math.min(b, c);
  let logPmf = -n * Math.LN2;
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(logPmf);
    logPmf += Math.log((n - i) / (i + 1));
  }
  const pValue = Math.min(1, 2 * tail);
  return { pValue, significant: pValue < 0.05 };
}
