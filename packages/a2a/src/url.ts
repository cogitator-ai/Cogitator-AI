/**
 * `value` without the slashes it ends with. A loop rather than `replace(/\/+$/, '')`: that
 * pattern backtracks in quadratic time over a long run of slashes followed by anything else,
 * and base paths and URLs come from configuration and requests.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}
