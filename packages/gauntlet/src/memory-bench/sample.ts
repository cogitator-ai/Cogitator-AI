import type { BenchConversation, BenchQuestion } from './types.js';

/** A seeded generator of numbers in [0, 1), so a sample is the same on every run (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * `size` questions of `conversations`, stratified by category: each category gets a share of
 * the sample in proportion to its size, at least one while the sample has room, the remainder
 * going to the categories with the largest fractions. The conversations come back with only the
 * questions picked, those left without any dropped. Without `size`, or with one at least the
 * number of questions, everything is kept.
 */
export function stratifiedSample(
  conversations: readonly BenchConversation[],
  size: number | undefined,
  seed: number
): BenchConversation[] {
  const all = conversations.flatMap((conversation) =>
    conversation.questions.map((question) => ({ conversation: conversation.id, question }))
  );
  if (size === undefined || size >= all.length) return [...conversations];

  const byCategory = new Map<string, typeof all>();
  for (const item of all) {
    const group = byCategory.get(item.question.category) ?? [];
    group.push(item);
    byCategory.set(item.question.category, group);
  }
  const categories = [...byCategory.keys()].sort();
  const quotas = new Map<string, number>();
  let assigned = 0;
  const fractions: { category: string; fraction: number }[] = [];
  for (const category of categories) {
    const exact = (byCategory.get(category)!.length / all.length) * size;
    const floor = Math.min(Math.floor(exact), byCategory.get(category)!.length);
    quotas.set(category, floor);
    assigned += floor;
    fractions.push({ category, fraction: exact - floor });
  }
  for (const category of categories) {
    if (assigned >= size) break;
    if (quotas.get(category) === 0) {
      quotas.set(category, 1);
      assigned++;
      const entry = fractions.find((item) => item.category === category);
      if (entry) entry.fraction = -1;
    }
  }
  fractions.sort((a, b) => b.fraction - a.fraction || a.category.localeCompare(b.category));
  for (const { category } of fractions) {
    if (assigned >= size) break;
    if (quotas.get(category)! < byCategory.get(category)!.length) {
      quotas.set(category, quotas.get(category)! + 1);
      assigned++;
    }
  }

  const random = seededRandom(seed);
  const picked = new Set<BenchQuestion>();
  for (const category of categories) {
    for (const item of shuffled(byCategory.get(category)!, random).slice(0, quotas.get(category))) {
      picked.add(item.question);
    }
  }
  return conversations
    .map((conversation) => ({
      ...conversation,
      questions: conversation.questions.filter((question) => picked.has(question)),
    }))
    .filter((conversation) => conversation.questions.length > 0);
}
