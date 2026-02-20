export interface McNemarResult {
  chiSquare: number;
  pValue: number;
  significant: boolean;
}

function erfc(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 1.0 - sign * y;
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

  const diff = Math.abs(b - c) - 1;
  const chiSquare = (diff * diff) / (b + c);
  const pValue = chiSquareSurvival(chiSquare);

  return {
    chiSquare,
    pValue,
    significant: pValue < 0.05,
  };
}
