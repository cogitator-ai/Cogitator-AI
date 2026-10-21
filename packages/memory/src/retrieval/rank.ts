/**
 * Ranking of what memory channels found: fusion of their ranked lists, a lexical rerank,
 * a bias toward what was said lately, and diversity
 */

import { reciprocalRankFusion } from '../search/rrf';
import { tokenize } from '../search/tokenizer';

/** RRF's constant: the weight of a channel's first hit against its later ones */
export const RRF_K = 60;
/** MMR's balance of relevance (1) against diversity (0) */
export const MMR_LAMBDA = 0.7;
/** Turns after which the bias toward recent turns has halved */
export const DECAY_HALF_LIFE_TURNS = 200;

/** One channel's hits, best first, and how much the channel counts */
export interface ChannelHits {
  channel: string;
  ids: string[];
  weight: number;
}

/** The fused score of every id the channels found: weighted reciprocal rank fusion */
export function fuse(channels: readonly ChannelHits[], k = RRF_K): Map<string, number> {
  return reciprocalRankFusion(
    channels.map((channel) => channel.ids.map((id) => ({ id }))),
    channels.map((channel) => channel.weight),
    { k }
  );
}

/**
 * How much of `terms` `text` holds, from 0 to 1, rarer terms counting more (`df` gives how many
 * of the candidates hold a term): a lexical check of what the channels found
 */
export function lexicalScore(
  terms: readonly string[],
  text: string,
  df: (term: string) => number = () => 1
): number {
  const unique = [...new Set(terms)];
  if (unique.length === 0) return 0;
  const words = new Set(tokenize(text));
  let held = 0;
  let total = 0;
  for (const term of unique) {
    const weight = 1 / Math.max(1, df(term));
    total += weight;
    if (words.has(term)) held += weight;
  }
  return total === 0 ? 0 : held / total;
}

/**
 * A factor from 1 down toward 0.5 for something said `turnsAgo` turns before the turn asked:
 * recent turns count a little more, old ones are never left out
 */
export function recencyBias(turnsAgo: number, halfLife = DECAY_HALF_LIFE_TURNS): number {
  return 0.5 + 0.5 * 2 ** (-Math.max(0, turnsAgo) / halfLife);
}

/** A candidate for {@link diversify}: its score and what it says, as words */
export interface Diverse {
  id: string;
  score: number;
  words: ReadonlySet<string>;
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * The candidates in maximal marginal relevance order: each next one the best trade between its
 * score and how unlike it is to those already taken (word overlap), so near copies of one fact do
 * not crowd out the rest
 */
export function diversify(candidates: readonly Diverse[], lambda = MMR_LAMBDA): Diverse[] {
  const top = Math.max(0, ...candidates.map((candidate) => candidate.score));
  const left = [...candidates];
  const taken: Diverse[] = [];
  while (left.length > 0) {
    let best = 0;
    let bestValue = -Infinity;
    for (const [at, candidate] of left.entries()) {
      const relevance = top === 0 ? 0 : candidate.score / top;
      const similar = Math.max(0, ...taken.map((known) => overlap(candidate.words, known.words)));
      const value = lambda * relevance - (1 - lambda) * similar;
      if (value > bestValue) {
        bestValue = value;
        best = at;
      }
    }
    taken.push(...left.splice(best, 1));
  }
  return taken;
}

/** The words of `text` a candidate is compared on */
export function wordsOf(text: string): Set<string> {
  return new Set(tokenize(text));
}
