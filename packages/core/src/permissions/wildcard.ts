/**
 * Whether `text` matches `pattern`, where `*` stands for any text and everything else is literal.
 * Greedy and linear in the length of the text: the parts between `*` are found in order, the first
 * at the start and the last at the end, no regex
 */
export function wildcardMatch(text: string, pattern: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return text === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!text.startsWith(first)) return false;
  if (text.length - last.length < first.length || !text.endsWith(last)) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const part of parts.slice(1, -1)) {
    if (part === '') continue;
    const found = text.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}
