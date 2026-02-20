# @cogitator-ai/evals

Evaluation framework for Cogitator AI agents. Run eval suites, compare models with A/B tests, enforce quality thresholds, and track regressions — all with built-in statistical significance testing.

## Installation

```bash
pnpm add @cogitator-ai/evals

# Optional dependencies
pnpm add papaparse  # CSV dataset loading
```

## Features

- **EvalSuite** — Run datasets against agents or plain functions with configurable concurrency, timeouts, and retries
- **4 Deterministic Metrics** — exactMatch, contains, regex, jsonSchema (Zod)
- **5 LLM-as-Judge Metrics** — faithfulness, relevance, coherence, helpfulness, custom llmMetric
- **3 Statistical Metrics** — latency, cost, tokenUsage with full percentile breakdowns
- **Custom Metrics** — `metric()` factory for anything domain-specific
- **Assertions** — threshold, noRegression, custom assertion with auto-detection of lower-is-better metrics
- **A/B Testing** — EvalComparison with paired t-test and McNemar's test for statistical significance
- **4 Reporters** — console (colored table), JSON, CSV, CI (exit code on failure)
- **Builder API** — Fluent `EvalBuilder` for composable eval pipelines
- **Baseline Workflow** — Save baselines, compare against them, catch regressions in CI
- **Zod Validation** — Type-safe configuration with runtime checks

---

## Quick Start

```typescript
import { EvalSuite, Dataset, exactMatch, contains, threshold, latency } from '@cogitator-ai/evals';

const dataset = Dataset.from([
  { input: 'What is 2+2?', expected: '4' },
  { input: 'Capital of France?', expected: 'Paris' },
  { input: 'Largest planet?', expected: 'Jupiter' },
]);

const suite = new EvalSuite({
  dataset,
  target: {
    fn: async (input) => {
      // replace with your agent or LLM call
      return `The answer is ${input}`;
    },
  },
  metrics: [exactMatch(), contains()],
  statisticalMetrics: [latency()],
  assertions: [threshold('exactMatch', 0.8)],
  concurrency: 5,
  timeout: 30_000,
});

const result = await suite.run();

result.report('console');
result.saveBaseline('./baseline.json');
```

---

## Datasets

Datasets are immutable collections of eval cases. Each case has an `input`, optional `expected`, optional `context`, and optional `metadata`.

### From inline data

```typescript
import { Dataset } from '@cogitator-ai/evals';

const dataset = Dataset.from([
  { input: 'Translate hello to French', expected: 'Bonjour' },
  { input: 'Summarize this article', context: { article: '...' } },
]);
```

### From JSONL

```typescript
const dataset = await Dataset.fromJsonl('./evals/qa.jsonl');
```

Each line must be a JSON object with at least an `input` field:

```jsonl
{"input": "What is TypeScript?", "expected": "A typed superset of JavaScript"}
{"input": "What is Zod?", "expected": "A TypeScript-first schema validation library"}
```

### From CSV

Requires `papaparse` as an optional dependency.

```typescript
const dataset = await Dataset.fromCsv('./evals/qa.csv');
```

CSV must have an `input` column. Optional columns: `expected`, `metadata.*`, `context.*`.

### Transformations

```typescript
const filtered = dataset.filter((c) => c.expected !== undefined);
const sampled = dataset.sample(50);
const shuffled = dataset.shuffle();
```

All transformations return new `Dataset` instances — the original is never mutated.

---

## Metrics

### Deterministic

Binary (0 or 1) metrics that compare output against expected values.

| Metric       | Description                                | Requires `expected` |
| ------------ | ------------------------------------------ | ------------------- |
| `exactMatch` | Exact string match (case optional)         | Yes                 |
| `contains`   | Output contains expected substring         | Yes                 |
| `regex`      | Output matches a regex pattern             | No                  |
| `jsonSchema` | Output is valid JSON matching a Zod schema | No                  |

```typescript
import { exactMatch, contains, regex, jsonSchema } from '@cogitator-ai/evals';
import { z } from 'zod';

const metrics = [
  exactMatch({ caseSensitive: true }),
  contains(),
  regex(/\d{4}-\d{2}-\d{2}/),
  jsonSchema(z.object({ answer: z.string(), confidence: z.number() })),
];
```

### LLM-as-Judge

Metrics scored by an LLM judge (0.0 to 1.0). Require a `judge` config on the suite.

| Metric         | Evaluates                               |
| -------------- | --------------------------------------- |
| `faithfulness` | Factual accuracy relative to input      |
| `relevance`    | How on-topic the response is            |
| `coherence`    | Logical structure and readability       |
| `helpfulness`  | Practical usefulness to the user        |
| `llmMetric`    | Custom prompt — you define the criteria |

```typescript
import { faithfulness, relevance, llmMetric } from '@cogitator-ai/evals';

const suite = new EvalSuite({
  dataset,
  target: { fn: myFunction },
  metrics: [
    faithfulness(),
    relevance(),
    llmMetric({
      name: 'technicalAccuracy',
      prompt: 'Rate how technically accurate the response is for a software engineering audience.',
    }),
  ],
  judge: { model: 'gpt-4o', temperature: 0 },
});
```

### Statistical

Aggregate metrics computed across all results. These report percentile breakdowns (p50, p95, p99) rather than per-case scores.

```typescript
import { latency, cost, tokenUsage } from '@cogitator-ai/evals';

const suite = new EvalSuite({
  dataset,
  target: { agent, cogitator },
  metrics: [exactMatch()],
  statisticalMetrics: [latency(), cost(), tokenUsage()],
});
```

### Custom

Build domain-specific metrics with the `metric()` factory.

```typescript
import { metric } from '@cogitator-ai/evals';

const wordCount = metric({
  name: 'wordCount',
  evaluate: ({ output }) => {
    const count = output.split(/\s+/).length;
    return { score: Math.min(count / 100, 1), details: `${count} words` };
  },
});

const suite = new EvalSuite({
  dataset,
  target: { fn: myFunction },
  metrics: [wordCount],
});
```

Scores are automatically clamped to [0, 1].

---

## Assertions

Assertions check aggregated metrics after a suite run and produce pass/fail results.

### threshold

Enforces a minimum (or maximum for latency/cost) value on a metric's mean.

```typescript
import { threshold } from '@cogitator-ai/evals';

const assertions = [
  threshold('exactMatch', 0.9),
  threshold('latency', 5000),
  threshold('relevance', 0.7),
];
```

Latency and cost metrics are automatically detected as lower-is-better.

### noRegression

Compares current results against a saved baseline file.

```typescript
import { noRegression } from '@cogitator-ai/evals';

const assertions = [noRegression('./baseline.json', { tolerance: 0.05 })];
```

### Custom assertion

```typescript
import { assertion } from '@cogitator-ai/evals';

const assertions = [
  assertion({
    name: 'totalCostBudget',
    check: (_aggregated, stats) => stats.cost < 1.0,
    message: 'Total eval cost exceeded $1.00 budget',
  }),
];
```

---

## A/B Testing

`EvalComparison` runs two targets on the same dataset and determines a winner using statistical significance tests (paired t-test for continuous metrics, McNemar's test for binary metrics).

```typescript
import { EvalComparison, Dataset, exactMatch, contains } from '@cogitator-ai/evals';

const dataset = Dataset.from([
  { input: 'What is 2+2?', expected: '4' },
  { input: 'Capital of Japan?', expected: 'Tokyo' },
  { input: 'Boiling point of water?', expected: '100°C' },
]);

const comparison = new EvalComparison({
  dataset,
  targets: {
    baseline: { fn: async (input) => baselineModel(input) },
    challenger: { fn: async (input) => challengerModel(input) },
  },
  metrics: [exactMatch(), contains()],
  concurrency: 5,
});

const result = await comparison.run();

console.log(`Winner: ${result.summary.winner}`);
for (const [name, mc] of Object.entries(result.summary.metrics)) {
  console.log(
    `  ${name}: baseline=${mc.baseline.toFixed(3)} challenger=${mc.challenger.toFixed(3)} p=${mc.pValue.toFixed(4)} ${mc.significant ? '*' : ''}`
  );
}
```

Access full suite results via `result.baseline` and `result.challenger`.

---

## Reporters

Call `result.report()` after a suite run to output results.

| Reporter  | Output                                          |
| --------- | ----------------------------------------------- |
| `console` | Colored table with metrics, assertions, summary |
| `json`    | Writes `eval-report.json` (configurable path)   |
| `csv`     | Writes `eval-report.csv` (configurable path)    |
| `ci`      | Compact output, `process.exit(1)` on failure    |

```typescript
const result = await suite.run();

result.report('console');
result.report('json', { path: './reports/eval.json' });
result.report(['console', 'json', 'csv']);
result.report('ci');
```

---

## Builder API

`EvalBuilder` provides a fluent interface for constructing eval suites.

```typescript
import {
  EvalBuilder,
  Dataset,
  exactMatch,
  contains,
  faithfulness,
  latency,
  threshold,
  noRegression,
} from '@cogitator-ai/evals';

const suite = new EvalBuilder()
  .withDataset(await Dataset.fromJsonl('./evals/qa.jsonl'))
  .withTarget({ fn: async (input) => myModel(input) })
  .withMetrics([exactMatch(), contains(), faithfulness()])
  .withStatisticalMetrics([latency()])
  .withJudge({ model: 'gpt-4o', temperature: 0 })
  .withAssertions([threshold('exactMatch', 0.85), noRegression('./baseline.json')])
  .withConcurrency(10)
  .withTimeout(60_000)
  .withRetries(2)
  .onProgress(({ completed, total }) => {
    console.log(`${completed}/${total}`);
  })
  .build();

const result = await suite.run();
result.report('console');
```

---

## Baseline Workflow

Save a baseline after a successful run, then use `noRegression` to guard against regressions in CI.

```typescript
const result = await suite.run();

result.saveBaseline('./baseline.json');
```

The baseline file is a simple JSON map of metric names to mean scores:

```json
{
  "exactMatch": 0.92,
  "contains": 0.97,
  "latency": 1234
}
```

In subsequent runs, use `noRegression` to compare:

```typescript
const suite = new EvalSuite({
  dataset,
  target: { fn: myFunction },
  metrics: [exactMatch(), contains()],
  assertions: [noRegression('./baseline.json', { tolerance: 0.05 })],
});

const result = await suite.run();
result.report('ci');
```

---

## API Reference

### Core

| Export           | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `EvalSuite`      | Main evaluation runner                                              |
| `EvalComparison` | A/B testing runner with statistical significance                    |
| `EvalBuilder`    | Fluent builder for EvalSuite                                        |
| `Dataset`        | Immutable dataset with from/fromJsonl/fromCsv/filter/sample/shuffle |
| `loadJsonl`      | Low-level JSONL file loader                                         |
| `loadCsv`        | Low-level CSV file loader                                           |

### Metrics

| Export         | Type          | Description                         |
| -------------- | ------------- | ----------------------------------- |
| `exactMatch`   | Deterministic | Exact string match                  |
| `contains`     | Deterministic | Substring match                     |
| `regex`        | Deterministic | Regex pattern match                 |
| `jsonSchema`   | Deterministic | Zod schema validation               |
| `faithfulness` | LLM Judge     | Factual accuracy                    |
| `relevance`    | LLM Judge     | Topical relevance                   |
| `coherence`    | LLM Judge     | Logical structure                   |
| `helpfulness`  | LLM Judge     | Practical usefulness                |
| `llmMetric`    | LLM Judge     | Custom judge prompt                 |
| `latency`      | Statistical   | Response time percentiles           |
| `cost`         | Statistical   | Token cost aggregation              |
| `tokenUsage`   | Statistical   | Input/output token counts           |
| `metric`       | Custom        | Factory for domain-specific metrics |

### Assertions

| Export         | Description                                    |
| -------------- | ---------------------------------------------- |
| `threshold`    | Enforce min/max on metric mean                 |
| `noRegression` | Compare against saved baseline                 |
| `assertion`    | Custom assertion with arbitrary check function |

### Reporters

| Export   | Description                            |
| -------- | -------------------------------------- |
| `report` | Dispatch to one or more reporter types |

### Statistics

| Export         | Description                                               |
| -------------- | --------------------------------------------------------- |
| `pairedTTest`  | Paired t-test for continuous metric comparison            |
| `mcnemarsTest` | McNemar's test for binary metric comparison               |
| `mean`         | Arithmetic mean                                           |
| `median`       | Median value                                              |
| `stdDev`       | Sample standard deviation                                 |
| `percentile`   | Arbitrary percentile                                      |
| `aggregate`    | Full stats: mean, median, min, max, stdDev, p50, p95, p99 |

### Agent Tools

| Export              | Description                          |
| ------------------- | ------------------------------------ |
| `createRunEvalTool` | Creates a `run_eval` tool for agents |
| `evalTools`         | Returns all eval tools as an array   |

---

## License

MIT
