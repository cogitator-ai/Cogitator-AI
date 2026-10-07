/**
 * `value` without the `char` characters it ends with. A loop rather than a `/x+$/` regular
 * expression, which backtracks in quadratic time over a long run of `char` followed by
 * anything else.
 */
export function trimTrailing(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end--;
  return value.slice(0, end);
}

/** `value` without the `char` characters it starts or ends with, in linear time. */
export function trimEdges(value: string, char: string): string {
  let start = 0;
  while (start < value.length && value[start] === char) start++;
  return trimTrailing(value.slice(start), char);
}
