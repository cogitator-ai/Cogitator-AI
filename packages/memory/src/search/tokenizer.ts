const ENGLISH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

export interface TokenizerConfig {
  lowercase?: boolean;
  removeStopwords?: boolean;
  minLength?: number;
}

export function tokenize(text: string, config: TokenizerConfig = {}): string[] {
  const { lowercase = true, removeStopwords = true, minLength = 2 } = config;

  let normalized = text;
  if (lowercase) {
    normalized = normalized.toLowerCase();
  }

  normalized = normalized.replace(/[^\p{L}\p{N}\s]/gu, ' ');

  const tokens = normalized.split(/\s+/).filter((t) => t.length >= minLength);

  if (removeStopwords) {
    return tokens.filter((t) => !ENGLISH_STOPWORDS.has(t));
  }

  return tokens;
}

export function getTermFrequency(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}
