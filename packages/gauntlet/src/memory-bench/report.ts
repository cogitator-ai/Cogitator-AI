import { mean, percentile } from '@cogitator-ai/evals';
import { seededRandom } from './sample.js';
import type { BenchScore } from './types.js';

/** The figures of one group of answers (a dataset and strategy, or one category of them). */
export interface BenchRow {
  dataset: string;
  strategy: string;
  category: string;
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
  costUsd: number;
}

/** The 95% bootstrap interval of the mean of `values`, `samples` resamples, seeded. */
export function bootstrapInterval(
  values: readonly number[],
  samples = 1000,
  seed = 7
): [number, number] {
  if (values.length === 0) return [0, 0];
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (const _ of values) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

function row(dataset: string, strategy: string, category: string, scores: BenchScore[]): BenchRow {
  const answered = scores.filter((score) => !score.error);
  const values = scores.map((score) => score.score);
  const [ciLow, ciHigh] = bootstrapInterval(values);
  const input = answered.reduce((sum, score) => sum + score.inputTokens, 0);
  const cached = answered.reduce((sum, score) => sum + score.cachedInputTokens, 0);
  const recall = answered.flatMap((score) =>
    score.evidenceRecall === undefined ? [] : [score.evidenceRecall]
  );
  return {
    dataset,
    strategy,
    category,
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
    costUsd: scores.reduce((sum, score) => sum + score.costUsd + score.judgeCostUsd, 0),
  };
}

/**
 * Rows for every dataset and strategy in `scores` (category `all`), followed by a row per
 * category of each.
 */
export function summarize(scores: readonly BenchScore[]): BenchRow[] {
  const groups = new Map<string, BenchScore[]>();
  for (const score of scores) {
    for (const category of ['all', score.category]) {
      const key = `${score.dataset}\u0000${score.strategy}\u0000${category}`;
      const group = groups.get(key) ?? [];
      group.push(score);
      groups.set(key, group);
    }
  }
  return [...groups]
    .map(([key, group]) => {
      const [dataset, strategy, category] = key.split('\u0000');
      return row(dataset, strategy, category, group);
    })
    .sort(
      (a, b) =>
        a.dataset.localeCompare(b.dataset) ||
        a.strategy.localeCompare(b.strategy) ||
        Number(b.category === 'all') - Number(a.category === 'all') ||
        a.category.localeCompare(b.category)
    );
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** `rows` as Markdown tables: one of the datasets and strategies, one per dataset by category. */
export function markdownReport(rows: readonly BenchRow[]): string {
  const overall = rows.filter((r) => r.category === 'all');
  const lines = [
    '| Dataset | Strategy | Questions | Accuracy (95% CI) | Input tokens/query | Cache hit | Evidence in context | Latency p50/p95 | Context build p50/p95 | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...overall.map(
      (r) =>
        `| ${r.dataset} | ${r.strategy} | ${r.questions}${r.errors ? ` (${r.errors} failed)` : ''} | ${pct(r.accuracy)} (${pct(r.ciLow)} to ${pct(r.ciHigh)}) | ${Math.round(r.inputTokensPerQuery)} | ${pct(r.cacheHitRate)} | ${r.evidenceRecall === undefined ? 'n/a' : pct(r.evidenceRecall)} | ${Math.round(r.latencyP50Ms)}/${Math.round(r.latencyP95Ms)} ms | ${Math.round(r.contextP50Ms)}/${Math.round(r.contextP95Ms)} ms | $${r.costUsd.toFixed(3)} |`
    ),
  ];
  for (const dataset of [...new Set(rows.map((r) => r.dataset))]) {
    const byCategory = rows.filter((r) => r.dataset === dataset && r.category !== 'all');
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
