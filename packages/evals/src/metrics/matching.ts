import type { Passage } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether two JSON-like values are equal, objects key by key and arrays item by item */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Whether `actual` holds everything `expected` has: every key of an expected object is in the
 * actual one with a matching value, arrays match item by item with the same length, and other
 * values are equal
 */
export function isSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return (
      expected.length === actual.length && expected.every((item, i) => isSubset(item, actual[i]))
    );
  }
  if (isRecord(expected) && isRecord(actual)) {
    return Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(actual, key) && isSubset(value, actual[key])
    );
  }
  return Object.is(expected, actual);
}

/** Text compared without case and with whitespace runs collapsed */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Texts shorter than this many words match only as a whole, never as a part of another */
const MIN_CONTAINED_WORDS = 3;

function wordCount(text: string): number {
  return text === '' ? 0 : text.split(' ').length;
}

/**
 * Whether a retrieved passage is the expected one: the same id, the same text once normalized,
 * or texts where one contains the other when the contained one has at least three words, so a
 * short id or a single word never matches every passage that happens to hold it
 */
export function passageMatches(passage: Passage, expected: string): boolean {
  if (passage.id !== undefined && passage.id === expected) return true;
  const content = normalizeText(passage.content);
  const target = normalizeText(expected);
  if (content === '' || target === '') return false;
  if (content === target) return true;
  if (wordCount(target) >= MIN_CONTAINED_WORDS && content.includes(target)) return true;
  return wordCount(content) >= MIN_CONTAINED_WORDS && target.includes(content);
}

/**
 * A largest one-to-one matching between `left` and `right` items, `matches` telling which pairs
 * may match (Kuhn's augmenting paths): the index of the right item each matched left item took
 */
export function maxMatching<L, R>(
  left: readonly L[],
  right: readonly R[],
  matches: (l: L, r: R) => boolean
): Map<number, number> {
  const owner = new Array<number>(right.length).fill(-1);
  const edges = left.map((l) => right.flatMap((r, j) => (matches(l, r) ? [j] : [])));

  const augment = (i: number, seen: boolean[]): boolean => {
    for (const j of edges[i]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (owner[j] === -1 || augment(owner[j], seen)) {
        owner[j] = i;
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < left.length; i++) augment(i, new Array<boolean>(right.length).fill(false));

  const pairs = new Map<number, number>();
  owner.forEach((i, j) => {
    if (i !== -1) pairs.set(i, j);
  });
  return pairs;
}

/** The length of the longest common subsequence of two sequences */
export function longestCommonSubsequence(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const item of a) {
    const curr = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      curr[j] = item === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** How many items two multisets share */
export function multisetOverlap(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of b) {
    const left = counts.get(item) ?? 0;
    if (left > 0) {
      counts.set(item, left - 1);
      shared++;
    }
  }
  return shared;
}
