/**
 * Holm-Bonferroni adjusted p-values, in the order given: the i-th smallest of m p-values is
 * multiplied by m - i + 1, kept from falling below the ones before it and capped at 1. Rejecting
 * where an adjusted p-value is below alpha keeps the family-wise error rate at alpha
 */
export function holm(pValues: readonly number[]): number[] {
  for (const p of pValues) {
    if (!(p >= 0 && p <= 1)) throw new Error(`p-values must be between 0 and 1, got ${p}`);
  }
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m);
  let running = 0;
  for (const [rank, { p, index }] of order.entries()) {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[index] = running;
  }
  return adjusted;
}
