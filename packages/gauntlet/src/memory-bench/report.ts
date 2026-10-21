import { mean, percentile } from '@cogitator-ai/evals';
import type { ModelPriceConfig } from '@cogitator-ai/types';
import { BENCH_PRICE } from './budget.js';
import { seededRandom } from './sample.js';
import type { BenchAnswer, BenchScore } from './types.js';

/** Input tokens of a group of answers, by how the prompt cache served them. */
export interface CacheTokens {
  input: number;
  /** Read from the cache */
  cached: number;
  /** Written to the cache, `written1h` of them with the 1-hour TTL */
  written: number;
  written1h: number;
}

/**
 * What `tokens` of input cost relative to the same tokens all at the plain input price: cache
 * reads at their discount, 5-minute writes at their premium and 1-hour writes at theirs, every
 * price from `price` (the bench model's: 0.1x, 1.25x and 2x of input). Below 1 the cache saved
 * money, above 1 its writes cost more than its reads saved. The long-prompt multiplier scales
 * every token class alike, so it leaves the ratio as it is. 1 without input.
 */
export function inputCostRatio(tokens: CacheTokens, price: ModelPriceConfig = BENCH_PRICE): number {
  if (tokens.input <= 0 || price.input <= 0) return 1;
  const cached = Math.min(tokens.cached, tokens.input);
  const written = Math.min(tokens.written, tokens.input - cached);
  const written1h = Math.min(tokens.written1h, written);
  const writePrice = price.inputCacheWrite ?? price.input;
  const cost =
    (tokens.input - cached - written) * price.input +
    cached * (price.inputCached ?? price.input) +
    (written - written1h) * writePrice +
    written1h * (price.inputCacheWrite1h ?? writePrice);
  return cost / (tokens.input * price.input);
}

/** How the prompt cache served a group of answers. */
export interface CacheFigures {
  inputTokensPerQuery: number;
  /** Share of input tokens served from the provider's prompt cache */
  cacheHitRate: number;
  /** Input tokens written to the cache per answer, absent when an answer predates recording them */
  cacheWriteTokensPerQuery?: number;
  /** `inputCostRatio` of the answers' input, absent when an answer predates recording cache writes */
  effectiveInputCostRatio?: number;
}

/** The cache figures of `answered`, the answers that did not fail. */
export function cacheFigures(answered: readonly BenchAnswer[]): CacheFigures {
  const total = (pick: (answer: BenchAnswer) => number) =>
    answered.reduce((sum, answer) => sum + pick(answer), 0);
  const input = total((answer) => answer.inputTokens);
  const cached = total((answer) => answer.cachedInputTokens);
  const perQuery = (value: number) => (answered.length === 0 ? 0 : value / answered.length);
  const figures: CacheFigures = {
    inputTokensPerQuery: perQuery(input),
    cacheHitRate: input === 0 ? 0 : cached / input,
  };
  if (answered.some((answer) => answer.cacheWriteTokens === undefined)) return figures;
  const written = total((answer) => answer.cacheWriteTokens ?? 0);
  const written1h = total((answer) => answer.cacheWrite1hTokens ?? 0);
  return {
    ...figures,
    cacheWriteTokensPerQuery: perQuery(written),
    effectiveInputCostRatio: inputCostRatio({ input, cached, written, written1h }),
  };
}

/** The cache figures of the follow-up turns of a group's chains (`--turns`), which are not judged. */
export interface FollowUpFigures extends CacheFigures {
  /** Follow-up turns answered, the ones the figures cover */
  turns: number;
  /** Follow-up turns that failed */
  errors: number;
}

/**
 * The figures of one group of answers (a dataset and strategy, or one category of them). The
 * cache figures are those of the first turns, the judged ones.
 */
export interface BenchRow extends CacheFigures {
  dataset: string;
  strategy: string;
  /** The category of the questions, absent on the row of the whole dataset and strategy */
  category?: string;
  /** Judged questions, the ones the figures cover */
  questions: number;
  /** Answers that failed, each counted as wrong */
  errors: number;
  /** Answers still waiting for the judge, left out of the figures */
  unjudged: number;
  /** Mean score, 0 to 1, and its 95% bootstrap interval */
  accuracy: number;
  ciLow: number;
  ciHigh: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  contextP50Ms: number;
  contextP95Ms: number;
  /** Mean share of the marked evidence that reached the model, when the dataset marks it */
  evidenceRecall?: number;
  /**
   * Accuracy minus that of `recent` on the same questions, with its 95% interval, for the other
   * strategies when `recent` answered them too, a failed answer counted as wrong on either side
   * as in the accuracy
   */
  vsRecent?: { delta: number; ciLow: number; ciHigh: number; questions: number };
  /** The follow-up turns of the group's chains, when the run asked any */
  followUps?: FollowUpFigures;
  /** Answers and the judge, follow-up turns included */
  costUsd: number;
}

/**
 * The 95% bootstrap interval of the mean of `values`, resampling whole clusters (the questions of
 * one conversation share its history, so they are not independent), `samples` resamples, seeded.
 * Without `clusters` every value is its own.
 */
export function bootstrapInterval(
  values: readonly number[],
  clusters?: readonly string[],
  samples = 1000,
  seed = 7
): [number, number] {
  if (values.length === 0) return [0, 0];
  const groups = new Map<string, number[]>();
  values.forEach((value, index) => {
    const key = clusters?.[index] ?? String(index);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  });
  const list = [...groups.values()];
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    let count = 0;
    for (const _ of list) {
      const group = list[Math.floor(random() * list.length)];
      for (const value of group) sum += value;
      count += group.length;
    }
    means.push(count === 0 ? 0 : sum / count);
  }
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

function row(
  dataset: string,
  strategy: string,
  category: string | undefined,
  scores: BenchScore[],
  recent: ReadonlyMap<string, BenchScore>,
  followUps: readonly BenchAnswer[]
): Omit<BenchRow, 'unjudged'> {
  const answered = scores.filter((score) => !score.error);
  const values = scores.map((score) => score.score);
  const [ciLow, ciHigh] = bootstrapInterval(
    values,
    scores.map((score) => score.conversationId)
  );
  const followUpsAnswered = followUps.filter((answer) => !answer.error);
  const recall = answered.flatMap((score) =>
    score.evidenceRecall === undefined ? [] : [score.evidenceRecall]
  );
  return {
    dataset,
    strategy,
    ...(category !== undefined && { category }),
    questions: scores.length,
    errors: scores.length - answered.length,
    accuracy: mean(values),
    ciLow,
    ciHigh,
    ...cacheFigures(answered),
    latencyP50Ms: percentile(
      answered.map((score) => score.durationMs),
      0.5
    ),
    latencyP95Ms: percentile(
      answered.map((score) => score.durationMs),
      0.95
    ),
    contextP50Ms: percentile(
      answered.map((score) => score.contextMs),
      0.5
    ),
    contextP95Ms: percentile(
      answered.map((score) => score.contextMs),
      0.95
    ),
    ...(recall.length > 0 && { evidenceRecall: mean(recall) }),
    ...(strategy !== 'recent' && pairedDelta(scores, recent)),
    ...(followUps.length > 0 && {
      followUps: {
        turns: followUpsAnswered.length,
        errors: followUps.length - followUpsAnswered.length,
        ...cacheFigures(followUpsAnswered),
      },
    }),
    costUsd:
      scores.reduce((sum, score) => sum + score.costUsd + score.judgeCostUsd, 0) +
      followUps.reduce((sum, answer) => sum + answer.costUsd, 0),
  };
}

function pairedDelta(
  scores: readonly BenchScore[],
  recent: ReadonlyMap<string, BenchScore>
): Pick<BenchRow, 'vsRecent'> {
  const deltas: number[] = [];
  const clusters: string[] = [];
  for (const score of scores) {
    const baseline = recent.get(`${score.dataset}\u0000${score.questionId}`);
    if (!baseline) continue;
    deltas.push(score.score - baseline.score);
    clusters.push(score.conversationId);
  }
  if (deltas.length === 0) return {};
  const [ciLow, ciHigh] = bootstrapInterval(deltas, clusters);
  return { vsRecent: { delta: mean(deltas), ciLow, ciHigh, questions: deltas.length } };
}

/**
 * Rows for every dataset and strategy in `scores` (without a category), each followed by a row
 * per category of it. `unjudged` are answers the judge has not scored yet: each row counts its
 * own, and a group with nothing judged still gets a row so it is not silently missing.
 * `followUps` are the later turns of chains (`--turns`), in the group of their chain's question.
 */
export function summarize(
  scores: readonly BenchScore[],
  unjudged: readonly BenchAnswer[] = [],
  followUps: readonly BenchAnswer[] = []
): BenchRow[] {
  const recent = new Map(
    scores
      .filter((score) => score.strategy === 'recent')
      .map((score) => [`${score.dataset}\u0000${score.questionId}`, score] as const)
  );
  const groups = new Map<
    string,
    {
      dataset: string;
      strategy: string;
      category?: string;
      scores: BenchScore[];
      unjudged: number;
      followUps: BenchAnswer[];
    }
  >();
  const groupsOf = (answer: BenchAnswer) =>
    [undefined, answer.category].map((category) => {
      const key = JSON.stringify([answer.dataset, answer.strategy, category ?? null]);
      const group = groups.get(key) ?? {
        dataset: answer.dataset,
        strategy: answer.strategy,
        ...(category !== undefined && { category }),
        scores: [],
        unjudged: 0,
        followUps: [],
      };
      groups.set(key, group);
      return group;
    });
  for (const score of scores) for (const group of groupsOf(score)) group.scores.push(score);
  for (const answer of unjudged) for (const group of groupsOf(answer)) group.unjudged++;
  for (const answer of followUps)
    for (const group of groupsOf(answer)) group.followUps.push(answer);
  return [...groups.values()]
    .map((group) => ({
      ...row(group.dataset, group.strategy, group.category, group.scores, recent, group.followUps),
      unjudged: group.unjudged,
    }))
    .sort(
      (a, b) =>
        a.dataset.localeCompare(b.dataset) ||
        a.strategy.localeCompare(b.strategy) ||
        Number(a.category !== undefined) - Number(b.category !== undefined) ||
        (a.category ?? '').localeCompare(b.category ?? '')
    );
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function questionsCell(r: BenchRow): string {
  const notes = [
    r.errors > 0 && `${r.errors} failed`,
    r.unjudged > 0 && `${r.unjudged} unjudged`,
  ].filter(Boolean);
  return `${r.questions}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
}

const accuracyCell = (r: BenchRow) =>
  r.questions === 0 ? 'n/a' : `${pct(r.accuracy)} (${pct(r.ciLow)} to ${pct(r.ciHigh)})`;

/** How the input cost column prices the cache, as multiples of the input price. */
export function cachePriceNote(price: ModelPriceConfig = BENCH_PRICE): string {
  const times = (value: number | undefined) =>
    `${((value ?? price.input) / price.input).toFixed(2)}x`;
  return (
    `Input cost vs uncached prices the input as the bench model does, cache reads at ` +
    `${times(price.inputCached)}, 5-minute cache writes at ${times(price.inputCacheWrite)} and ` +
    `1-hour ones at ${times(price.inputCacheWrite1h ?? price.inputCacheWrite)} of the input price.`
  );
}

const writeCell = (figures: CacheFigures) =>
  figures.cacheWriteTokensPerQuery === undefined
    ? 'n/a'
    : String(Math.round(figures.cacheWriteTokensPerQuery));

const ratioCell = (figures: CacheFigures) =>
  figures.effectiveInputCostRatio === undefined
    ? 'n/a'
    : `${figures.effectiveInputCostRatio.toFixed(2)}x`;

/**
 * The table of follow-up turns, for the rows whose chains had any: the cache of turns 2 and later
 * beside that of the first turns.
 */
function followUpTable(overall: readonly BenchRow[]): string[] {
  const chained = overall.filter((r) => r.followUps);
  if (chained.length === 0) return [];
  return [
    '',
    '### Follow-up turns',
    '',
    "Turns 2 and later of each question's chain, asked in the same branch of the thread and not judged.",
    '',
    '| Dataset | Strategy | Follow-ups | Input tokens/turn, 1st / 2+ | Cache hit, 1st / 2+ | Cache write/turn, 1st / 2+ | Input cost vs uncached, 1st / 2+ |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...chained.flatMap((r) => {
      const next = r.followUps;
      if (!next) return [];
      const turns = `${next.turns}${next.errors > 0 ? ` (${next.errors} failed)` : ''}`;
      return [
        `| ${r.dataset} | ${r.strategy} | ${turns} | ${Math.round(r.inputTokensPerQuery)} / ${Math.round(next.inputTokensPerQuery)} | ${pct(r.cacheHitRate)} / ${pct(next.cacheHitRate)} | ${writeCell(r)} / ${writeCell(next)} | ${ratioCell(r)} / ${ratioCell(next)} |`,
      ];
    }),
  ];
}

/** `rows` as Markdown tables: one of the datasets and strategies, one per dataset by category. */
export function markdownReport(rows: readonly BenchRow[]): string {
  const overall = rows.filter((r) => r.category === undefined);
  const lines = [
    '| Dataset | Strategy | Questions | Accuracy (95% CI) | vs recent | Input tokens/query | Cache hit | Cache write/query | Input cost vs uncached | Evidence in context | Latency p50/p95 | Context build p50/p95 | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...overall.map(
      (r) =>
        `| ${r.dataset} | ${r.strategy} | ${questionsCell(r)} | ${accuracyCell(r)} | ${r.vsRecent ? `${r.vsRecent.delta >= 0 ? '+' : ''}${pct(r.vsRecent.delta)} (${pct(r.vsRecent.ciLow)} to ${pct(r.vsRecent.ciHigh)})` : ''} | ${Math.round(r.inputTokensPerQuery)} | ${pct(r.cacheHitRate)} | ${writeCell(r)} | ${ratioCell(r)} | ${r.evidenceRecall === undefined ? 'n/a' : pct(r.evidenceRecall)} | ${Math.round(r.latencyP50Ms)}/${Math.round(r.latencyP95Ms)} ms | ${Math.round(r.contextP50Ms)}/${Math.round(r.contextP95Ms)} ms | $${r.costUsd.toFixed(3)} |`
    ),
    '',
    cachePriceNote(),
    ...followUpTable(overall),
  ];
  for (const dataset of [...new Set(rows.map((r) => r.dataset))]) {
    const byCategory = rows.filter((r) => r.dataset === dataset && r.category !== undefined);
    const strategies = [...new Set(byCategory.map((r) => r.strategy))];
    const categories = [...new Set(byCategory.map((r) => r.category))];
    lines.push(
      '',
      `### ${dataset}`,
      '',
      `| Category | ${strategies.join(' | ')} |`,
      `| --- | ${strategies.map(() => '---').join(' | ')} |`,
      ...categories.map((category) => {
        const cells = strategies.map((strategy) => {
          const r = byCategory.find((x) => x.strategy === strategy && x.category === category);
          if (!r) return '';
          const unjudged = r.unjudged > 0 ? `, ${r.unjudged} unjudged` : '';
          return `${r.questions === 0 ? 'n/a' : pct(r.accuracy)} (n=${r.questions}${unjudged})`;
        });
        return `| ${category} | ${cells.join(' | ')} |`;
      })
    );
  }
  return `${lines.join('\n')}\n`;
}
