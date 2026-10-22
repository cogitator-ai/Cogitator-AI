const SIGNIFICANT_DIGITS = 12;

/** A value rounded to 12 significant digits, so float noise such as 0.29999999999999993 reads 0.3 */
export function withoutNoise(value: number): number {
  return value === 0 || !Number.isFinite(value)
    ? value
    : Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

/**
 * `a - b` on a grid of 12 significant digits of the larger of `a` and `b`, where the float noise
 * of the subtraction lives, so `0.7 - 0.4` and `0.6 - 0.9` tie in magnitude, so do
 * `12345.9 - 12345.7` and `98765.7 - 98765.5`, and two means of the same trials differ by nothing.
 * An infinite or NaN difference stays as it is.
 */
export function pairedDifference(a: number, b: number): number {
  const difference = a - b;
  if (!Number.isFinite(difference)) return difference;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(scale)) - (SIGNIFICANT_DIGITS - 1));
  const snapped = Math.round(difference / step) * step;
  return snapped === 0 ? 0 : withoutNoise(snapped);
}

/** Whether every value is the same */
export function isConstant(values: readonly number[]): boolean {
  return values.every((value) => value === values[0]);
}
