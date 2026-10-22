const SIGNIFICANT_DIGITS = 12;

/** A value rounded to 12 significant digits, so float noise such as 0.29999999999999993 reads 0.3 */
export function withoutNoise(value: number): number {
  return value === 0 || !Number.isFinite(value)
    ? value
    : Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

/**
 * `a - b` rounded to 12 significant digits, and 0 when it is that small next to `a` and `b`, so
 * `0.7 - 0.4` and `0.6 - 0.9` tie in magnitude and two means of the same trials differ by nothing
 */
export function pairedDifference(a: number, b: number): number {
  const difference = a - b;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (Math.abs(difference) <= scale * 10 ** -SIGNIFICANT_DIGITS) return 0;
  return withoutNoise(difference);
}

/** Whether every value is the same */
export function isConstant(values: readonly number[]): boolean {
  return values.every((value) => value === values[0]);
}
