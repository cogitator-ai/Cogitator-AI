import { mean, percentile } from '@cogitator-ai/evals';
import { seededRandom } from './sample.js';
import type { BenchScore } from './types.js';

/** The figures of one group of answers (a dataset and strategy, or one category of them). */
export interface BenchRow {
  dataset: string;
  strategy: string;
  /** The category of the questions, absent on the row of the whole dataset and strategy */
  category?: string;
  questions: number;
  errors: number;
  /** Mean score, 0 to 1, and its 95% bootstrap interval */
  accuracy: number;
  ciLow: number;
  ciHigh: number;
  inputTokensPerQuery: number;
  /** Share of input tokens served from the provider's prompt cache */
  cacheHitRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  contextP50Ms: number;
  contextP95Ms: number;
  /** Mean share of the marked evidence that reached the model, when the dataset marks it */
  evidenceRecall?: number;
  /**
   * Accuracy minus that of `recent` on the same questions, with its 95% interval, for the other
   * strategies when `recent` answered them too
   */
  vsRecent?: { delta: number; ciLow: number; ciHigh: number; questions: number };
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
  recent: ReadonlyMap<string, BenchScore>
): BenchRow {
  const answered = scores.filter((score) => !score.error);
  const values = scores.map((score) => score.score);
  const [ciLow, ciHigh] = bootstrapInterval(
    values,
    scores.map((score) => score.conversationId)
  );
  const input = answered.reduce((sum, score) => sum + score.inputTokens, 0);
  const cached = answered.reduce((sum, score) => sum + score.cachedInputTokens, 0);
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
    inputTokensPerQuery: answered.length === 0 ? 0 : input / answered.length,
    cacheHitRate: input === 0 ? 0 : cached / input,
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
    costUsd: scores.reduce((sum, score) => sum + score.costUsd + score.judgeCostUsd, 0),
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
    if (!baseline || score.error || baseline.error) continue;
    deltas.push(score.score - baseline.score);
    clusters.push(score.conversationId);
  }
  if (deltas.length === 0) return {};
  const [ciLow, ciHigh] = bootstrapInterval(deltas, clusters);
  return { vsRecent: { delta: mean(deltas), ciLow, ciHigh, questions: deltas.length } };
}

/**
 * Rows for every dataset and strategy in `scores` (without a category), each followed by a row
 * per category of it.
 */
export function summarize(scores: readonly BenchScore[]): BenchRow[] {
  const recent = new Map(
    scores
      .filter((score) => score.strategy === 'recent')
      .map((score) => [`${score.dataset}\u0000${score.questionId}`, score] as const)
  );
  const groups = new Map<
    string,
    { dataset: string; strategy: string; category?: string; scores: BenchScore[] }
  >();
  for (const score of scores) {
    for (const category of [undefined, score.category]) {
      const key = JSON.stringify([score.dataset, score.strategy, category ?? null]);
      const group = groups.get(key) ?? {
        dataset: score.dataset,
        strategy: score.strategy,
        ...(category !== undefined && { category }),
        scores: [],
      };
      group.scores.push(score);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map((group) => row(group.dataset, group.strategy, group.category, group.scores, recent))
    .sort(
      (a, b) =>
        a.dataset.localeCompare(b.dataset) ||
        a.strategy.localeCompare(b.strategy) ||
        Number(a.category !== undefined) - Number(b.category !== undefined) ||
        (a.category ?? '').localeCompare(b.category ?? '')
    );
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** `rows` as Markdown tables: one of the datasets and strategies, one per dataset by category. */
export function markdownReport(rows: readonly BenchRow[]): string {
  const overall = rows.filter((r) => r.category === undefined);
  const lines = [
    '| Dataset | Strategy | Questions | Accuracy (95% CI) | vs recent | Input tokens/query | Cache hit | Evidence in context | Latency p50/p95 | Context build p50/p95 | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...overall.map(
      (r) =>
        `| ${r.dataset} | ${r.strategy} | ${r.questions}${r.errors ? ` (${r.errors} failed)` : ''} | ${pct(r.accuracy)} (${pct(r.ciLow)} to ${pct(r.ciHigh)}) | ${r.vsRecent ? `${r.vsRecent.delta >= 0 ? '+' : ''}${pct(r.vsRecent.delta)} (${pct(r.vsRecent.ciLow)} to ${pct(r.vsRecent.ciHigh)})` : ''} | ${Math.round(r.inputTokensPerQuery)} | ${pct(r.cacheHitRate)} | ${r.evidenceRecall === undefined ? 'n/a' : pct(r.evidenceRecall)} | ${Math.round(r.latencyP50Ms)}/${Math.round(r.latencyP95Ms)} ms | ${Math.round(r.contextP50Ms)}/${Math.round(r.contextP95Ms)} ms | $${r.costUsd.toFixed(3)} |`
    ),
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
          return r ? `${pct(r.accuracy)} (n=${r.questions})` : '';
        });
        return `| ${category} | ${cells.join(' | ')} |`;
      })
    );
  }
  return `${lines.join('\n')}\n`;
}
