# @cogitator-ai/evals

Evaluation framework for Cogitator AI agents. Run eval suites, compare models with A/B tests, enforce quality thresholds, and track regressions — all with built-in statistical significance testing.

## Installation

```bash
pnpm add @cogitator-ai/evals

# Optional dependencies
pnpm add papaparse  # CSV dataset loading
pnpm add @cogitator-ai/core  # agent targets and LLM-as-judge metrics
pnpm add -D vitest  # describeEval from @cogitator-ai/evals/vitest
```

Website docs: [Evals](https://cogitator.app/docs/evals), [Datasets](https://cogitator.app/docs/evals/datasets), [Metrics](https://cogitator.app/docs/evals/metrics), [Assertions](https://cogitator.app/docs/evals/assertions), [Comparison](https://cogitator.app/docs/evals/comparison), [Reporters](https://cogitator.app/docs/evals/reporters).

## Features

- **EvalSuite** — Run datasets against agents or plain functions with configurable concurrency, timeouts, and retries
- **7 Deterministic Metrics** - exactMatch, contains, containsAll, containsAny, similarity, regex, jsonSchema (Zod)
- **5 LLM-as-Judge Metrics** — faithfulness, relevance, coherence, helpfulness, custom llmMetric
- **3 Statistical Metrics** — latency, cost, tokenUsage with full percentile breakdowns
- **Custom Metrics** — `metric()` factory for anything domain-specific
- **Assertions** — threshold, noRegression, custom assertion with auto-detection of lower-is-better metrics
- **A/B Testing** — EvalComparison with paired t-test and McNemar's test for statistical significance
- **6 Reporters** - console (colored table), JSON, CSV, JUnit XML, GitHub Actions annotations and job summary, CI (exit code on failure)
- **Vitest** - `describeEval` from `@cogitator-ai/evals/vitest` runs a suite as a test file, one test per case plus one for the assertions
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

A target is either `{ fn: (input, { signal, case, attempt }) => Promise<string> }` or `{ agent, cogitator }`, which runs the agent with `cogitator.run(agent, { input, context, signal })` and records its usage for the statistical metrics. Defaults: `concurrency` 5, `timeout` 30 000 ms (minimum 1 000), `retries` 0.

A case that throws or exceeds `timeout` is retried up to `retries` times. A timed-out attempt is cancelled through its `signal`: an agent target's run is aborted, and a `fn` target should pass the signal on to its model call. The suite waits for the cancelled attempt to stop (at most another `timeout`) before it retries, so attempts of one case never overlap and `concurrency` holds. If every attempt fails, its result has an empty `output` and an `error` message describing the last failure.

```typescript
const suite = new EvalSuite({
  dataset,
  target: {
    fn: async (input, { signal }) => {
      const res = await fetch(MODEL_URL, { method: 'POST', body: input, signal });
      return res.text();
    },
  },
  timeout: 10_000,
  retries: 2,
});
```

`suite.run(options?: EvalRunOptions)` takes `{ maxCases?: number, signal?: AbortSignal }`: with `maxCases` only the first N cases of the dataset run, and the results, aggregates, assertions and `stats.total` cover just those cases. Aborting `signal` cancels the attempts in flight, starts no further case, and `run()` rejects with the signal's reason.

A case whose every attempt failed is not scored: its empty output costs no judge calls and counts as no 0, the aggregates cover the cases that answered (`aggregated.<metric>.count` says how many), and `maxErrorRate(rate)` fails a run where too many cases errored. An agent target's case result carries `truncated`, `iterationLimitReached` and `paused` when the run ended that way.

A failure never drops a case. A metric that throws or returns a score that is not a finite number (such as NaN) scores 0 for that case with the reason in `score.error`, and an `onProgress` callback that throws is reported as a process warning.

`result.stats` holds:

| Field          | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `total`        | Cases run                                                    |
| `errors`       | Cases whose every attempt failed or timed out                |
| `metricErrors` | Metric scores that failed and count as 0                     |
| `duration`     | Wall time of the run in ms                                   |
| `cost`         | USD spent, `targetCost + judgeCost`                          |
| `targetCost`   | USD the target spent, over every attempt that reported usage |
| `judgeCost`    | USD the LLM judge spent                                      |

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

Both loaders name the line of the file a case comes from when the case schema refuses it (`Invalid case at line 3: input: ...`), the CSV loader counting quoted fields that span lines.

### Transformations

```typescript
const filtered = dataset.filter((c) => c.expected !== undefined);
const sampled = dataset.sample(50);
const shuffled = dataset.shuffle();
const nightly = dataset.sample(50, { seed: 'nightly' }); // the same cases on every run
```

All transformations return new `Dataset` instances — the original is never mutated.

---

## Metrics

### Deterministic

Metrics that compare output against expected values using string operations or schema validation.

| Metric        | Description                                    | Requires `expected` |
| ------------- | ---------------------------------------------- | ------------------- |
| `exactMatch`  | Exact string match (case optional)             | Yes                 |
| `contains`    | Output contains expected substring             | Yes                 |
| `containsAll` | Fraction of configured keywords found          | No                  |
| `containsAny` | Whether any configured keyword is found        | No                  |
| `similarity`  | Levenshtein distance similarity score (0 to 1) | Yes                 |
| `regex`       | Output matches a regex pattern                 | No                  |
| `jsonSchema`  | Output is valid JSON matching a Zod schema     | No                  |

```typescript
import {
  exactMatch,
  contains,
  containsAll,
  containsAny,
  similarity,
  regex,
  jsonSchema,
  threshold,
} from '@cogitator-ai/evals';
import { z } from 'zod';

const metrics = [
  exactMatch({ caseSensitive: true }),
  contains(),
  containsAll(['security', 'privacy', 'compliance']),
  containsAny(['approved', 'accepted']),
  similarity(),
  regex(/\d{4}-\d{2}-\d{2}/),
  jsonSchema(z.object({ answer: z.string(), confidence: z.number() })),
];

// Assert similarity is at least 0.8
const assertions = [threshold('similarity', 0.8)];
```

Every built-in per-case metric takes a `name` option. A suite refuses two metrics with the same name, because their scores would merge into one aggregate, so name the second of a kind:

```typescript
const metrics = [
  regex(/\d{4}-\d{2}-\d{2}/, { name: 'hasDate' }),
  regex(/\[\d+\]/, { name: 'hasCitation' }),
];
```

`containsAll()` scores the fraction of its keywords found and reports any missing keywords in `details`. `containsAny()` scores 1 when at least one keyword is found and 0 otherwise. Keywords use substring matching, so `cat` matches `concatenate`. Both metrics are case-insensitive by default, accept `caseSensitive` and `name` options, ignore duplicate keywords, and reject empty lists or empty and whitespace-only keywords when the metric is created.

`regex()` ignores the `g` and `y` flags, which would make identical outputs alternate between pass and fail.

### LLM-as-Judge

Metrics scored by an LLM judge (0.0 to 1.0). They require a `judge` config on the suite and a Cogitator to run the judge agent: `judge.cogitator`, or the `cogitator` of an agent target. Without one, the suite throws when it is created.

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
  judge: { model: 'openai/gpt-6.1-sol', temperature: 0, cogitator: cog },
});
```

The judge reads the case's `context` too, so `faithfulness()` can check a response against the source documents of a case without putting them into `input`:

```typescript
Dataset.from([{ input: 'Write the lede', context: { dossier: dossierText } }]);
```

The `judge` option is a `JudgeConfigInput`: `{ model, temperature?, maxTokens?, cogitator?, cache?, concurrency? }`, with `temperature` defaulting to `0`. `cache: true` reuses a verdict for the same model, settings and prompt in memory (a `JudgeCache` with `get` and `set` keeps them across runs), and `concurrency` caps the judge calls running at once.

The judge answers with `{ "score", "reasoning" }` JSON. A verdict in a code fence or with the score as a numeric string is read as well, and an answer without JSON falls back to its last labelled score (`Score: 0.4`, `score is 4/5`), never to a stray number in the prose. When no verdict can be read, or the judge call fails, the metric scores 0 with the reason in `score.error`. The judge's usage is reported on each score and counted in `stats.judgeCost`.

### Statistical

Aggregate metrics computed across all results. These report percentile breakdowns (p50, p95, p99) rather than per-case scores.

```typescript
import { latency, cost, tokenUsage } from '@cogitator-ai/evals';

const suite = new EvalSuite({
  dataset,
  target: { agent, cogitator: cog },
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

Scores are automatically clamped to [0, 1]. A score that is not a finite number (NaN from a division by zero, Infinity) is not clamped: the metric scores 0 and reports the problem in `error`.

---

## Assertions

Assertions check aggregated metrics after a suite run and produce pass/fail results.

### threshold

Enforces a minimum (or maximum for latency/cost) value on a metric's mean.

```typescript
import { threshold } from '@cogitator-ai/evals';

const assertions = [
  threshold('exactMatch', 0.9),
  threshold('similarity', 0.8),
  threshold('latency', 5000),
  threshold('relevance', 0.7),
];
```

Latency, cost and tokenUsage metrics (and names ending in `Duration` or `Latency`) are lower-is-better: the assertion passes when the value is at or below the threshold. `noRegression` uses the same rule.

### maxErrorRate

```typescript
import { maxErrorRate } from '@cogitator-ai/evals';

const assertions = [threshold('exactMatch', 0.9), maxErrorRate(0.05)];
```

Passes while at most `rate` (0 to 1) of the cases errored. Errored cases are not scored, so pair metric thresholds with it.

### noRegression

Compares current results against a saved baseline file.

```typescript
import { noRegression } from '@cogitator-ai/evals';

const assertions = [noRegression('./baseline.json', { tolerance: 0.05 })];
```

`threshold` and `noRegression` fail on a value that is not a finite number, in the results or in the baseline, and `result.saveBaseline()` refuses to write one.

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

`stats.cost` includes the LLM judge, `stats.targetCost` and `stats.judgeCost` split it.

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

Access full suite results via `result.baseline` and `result.challenger`. `comparison.run({ signal })` cancels both runs.

---

## Reporters

Call `result.report()` after a suite run to output results.

| Reporter  | Output                                                               |
| --------- | -------------------------------------------------------------------- |
| `console` | Colored table with metrics, assertions, summary                      |
| `json`    | Writes `eval-report.json` (configurable path)                        |
| `csv`     | Writes `eval-report.csv` (configurable path)                         |
| `junit`   | Writes `eval-report.xml`, a JUnit report (configurable path)         |
| `github`  | GitHub Actions annotations, plus a job summary in Actions            |
| `ci`      | Compact verdict, sets `process.exitCode = 1` when an assertion fails |

```typescript
const result = await suite.run();

result.report('console');
result.report('json', { path: './reports/eval.json' });
result.report(['console', 'json', 'csv', 'junit'], { path: './reports/eval' });
result.report(['github', 'ci']);
```

The `path` is a base path: each file reporter adds its own extension (`.json`, `.csv`, `.xml`). `ci` runs last and does not end the process, so output flushes and later hooks still run before Node exits with code 1.

- **junit** writes one `<testsuite name="eval">` with a `<testcase>` per case (a `<failure>` when it errored, its scores in `<system-out>`) and a `<testcase>` per assertion (a `<failure>` when it did not pass). Everything is XML-escaped, and characters XML 1.0 does not allow are replaced.
- **github** prints `::error` for each failed assertion and errored case and `::warning` for each failed metric score. When `GITHUB_STEP_SUMMARY` is set it also appends a Markdown summary with the totals, the aggregated metrics (mean, p50, p95, cases scored) and the assertions.

Agent run flags (`truncated`, `iterationLimitReached`, `paused`) show up per case in the json, csv and junit reports, and each aggregated metric's `count` (cases it was scored on) in the console, json and github output.

### Vitest

```typescript
// eval/qa.eval.test.ts
import { afterAll } from 'vitest';
import { describeEval } from '@cogitator-ai/evals/vitest';

const qa = describeEval('qa agent', { suite, run: { maxCases: 50 }, timeout: 5 * 60_000 });

afterAll(() => qa.result().report('junit', { path: './reports/qa' }));
```

`describeEval(name, { suite, run?, timeout? })` registers a `describe` block. The suite runs once in `beforeAll` (`timeout` defaults to 10 minutes, after which the run is cancelled), each case of `suite.cases(run?.maxCases)` gets a test that fails with the case error, and an `assertions` test lists every failed assertion. When the run itself fails, every test fails with that cause. `result()` returns the `EvalSuiteResult` once the run has finished.

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
  .withJudge({ model: 'openai/gpt-6.1-sol', temperature: 0, cogitator: cog })
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
| `isLLMMetric`    | Type guard: checks if a `MetricFn` is an `LLMMetricFn`              |

### Metrics

| Export         | Type          | Description                           |
| -------------- | ------------- | ------------------------------------- |
| `exactMatch`   | Deterministic | Exact string match                    |
| `contains`     | Deterministic | Substring match                       |
| `containsAll`  | Deterministic | Fraction of keywords found            |
| `containsAny`  | Deterministic | Any configured keyword found          |
| `similarity`   | Deterministic | Levenshtein distance similarity score |
| `regex`        | Deterministic | Regex pattern match                   |
| `jsonSchema`   | Deterministic | Zod schema validation                 |
| `faithfulness` | LLM Judge     | Factual accuracy                      |
| `relevance`    | LLM Judge     | Topical relevance                     |
| `coherence`    | LLM Judge     | Logical structure                     |
| `helpfulness`  | LLM Judge     | Practical usefulness                  |
| `llmMetric`    | LLM Judge     | Custom judge prompt                   |
| `latency`      | Statistical   | Response time percentiles             |
| `cost`         | Statistical   | Token cost aggregation                |
| `tokenUsage`   | Statistical   | Input/output token counts             |
| `metric`       | Custom        | Factory for domain-specific metrics   |

### Assertions

| Export         | Description                                    |
| -------------- | ---------------------------------------------- |
| `threshold`    | Enforce min/max on metric mean                 |
| `maxErrorRate` | Fail a run where too many cases errored        |
| `noRegression` | Compare against saved baseline                 |
| `assertion`    | Custom assertion with arbitrary check function |

### Reporters

| Export                           | Description                            |
| -------------------------------- | -------------------------------------- |
| `report`                         | Dispatch to one or more reporter types |
| `describeEval` (`/vitest` entry) | Run a suite as a Vitest describe block |

`report` takes `console`, `json`, `csv`, `junit`, `github` and `ci`. `describeEval` takes `DescribeEvalOptions` and returns a `DescribeEvalHandle`.

### Types

| Export             | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `JudgeConfigInput` | The `judge` option: model, settings, `cogitator`, `cache`, `concurrency` |
| `JudgeCache`       | Where verdicts are kept across runs: `get(key)` and `set(key, verdict)`  |
| `AggregatedMetric` | Aggregate of a metric, with `count` for the cases it covers              |
| `MetricComparison` | A metric of a comparison, with `n` for the cases it was compared on      |

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

| Export              | Description                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createRunEvalTool` | Creates a `run_eval` tool for agents for a given suite; its optional `maxCases` runs `suite.run({ maxCases })` and the summary (`total`, `metrics`, `assertionsPassed`) covers those cases |
| `evalTools`         | Returns all eval tools for a suite as an array                                                                                                                                             |

Like the RAG tools, eval tools carry a Zod `parameters` schema and can be passed to `tool()` from `@cogitator-ai/core`.

---

## License

MIT
