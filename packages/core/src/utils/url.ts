/** `value` without the slashes it ends with, in linear time, unlike `replace(/\/+$/, '')`. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}
