/**
 * Canonical form of a decision used to compare votes: case-, markup- and
 * punctuation-insensitive ("**Option A.**" and "option a" are the same decision).
 */
export function normalizeDecision(decision: string): string {
  return decision
    .toLowerCase()
    .replace(/[*_`"'“”‘’[\]()]/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
