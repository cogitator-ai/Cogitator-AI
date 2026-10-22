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

Website docs: [Evals](https://cogitator.app/docs/evals), [Datasets](https://cogitator.app/docs/evals/datasets), [Metrics](https://cogitator.app/docs/evals/metrics), [Assertions](https://cogitator.app/docs/evals/assertions), [Agents](https://cogitator.app/docs/evals/agents), [Comparison](https://cogitator.app/docs/evals/comparison), [Experiments](https://cogitator.app/docs/evals/experiments), [Reporters](https://cogitator.app/docs/evals/reporters).

## Features

- **EvalSuite** — Run datasets against agents or plain functions with configurable concurrency, timeouts, and retries
- **8 Deterministic Metrics** - exactMatch, contains, containsAll, containsAny, similarity, tokenF1, regex, jsonSchema (Zod)
- **7 LLM-as-Judge Metrics** - faithfulness, relevance, coherence, helpfulness, contextRelevance, gEval, custom llmMetric with a free prompt or a discrete rubric. Prompts keep every untrusted value in escaped tags, `judge.samples` averages several verdicts, and `calibrateJudge()` checks a judge against labels
- **4 Statistical Metrics** - latency, cost, tokenUsage with full percentile breakdowns, and passAtK over trials
- **Custom Metrics** — `metric()` factory for anything domain-specific
- **Agent Evaluation** - `toolCalls()` and `trajectory()` against expected tool calls, `retrievalRecall()`, `retrievalPrecision()`, `retrievalMRR()` and the `contextRelevance()` judge against expected passages, multi-turn cases on one conversation
- **Trials and pass@k** - run each case several times and score how often it passes with `passAtK()`
- **Assertions** — threshold, noRegression, custom assertion with auto-detection of lower-is-better metrics
- **A/B Testing** - EvalComparison with McNemar's test (exact for few discordant pairs), the paired t-test or Wilcoxon signed-rank, Holm's correction across metrics, bootstrap confidence intervals, effect sizes, latency and cost comparisons and pairwise judging
- **Experiment Tracking** - named runs with metadata saved as versioned run files, a `RunStore` directory of runs, `compareRuns()` with the A/B statistics, per-case regressions and improvements, and warnings when datasets, prompt versions, metrics or judges differ. Agent cases keep the `traceId` and versioned `prompt` of their runs
- **8 Reporters** - console (colored table), JSON, CSV, JUnit XML, Markdown (pull request comments), self-contained HTML, GitHub Actions annotations and job summary, CI (exit code on failure), plus `reportComparison()` for comparisons
- **Vitest** - `describeEval` from `@cogitator-ai/evals/vitest` runs a suite as a test file, one test per case plus one for the assertions, and `evalMatchers` from `@cogitator-ai/evals/matchers` (Vitest 5) adds `toHaveCalledTool`, `toFollowTrajectory`, `toHaveRetrieved` and `toScoreAtLeast`
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

A target is either `{ fn: (input, { signal, case, attempt, turn, history }) => Promise<string> }` or `{ agent, cogitator, retrieval? }`, which runs the agent with `cogitator.run(agent, { input, context, signal, onToolResult })` and records its usage, tool calls, tool results and retrieved passages (see [Agent Evaluation](#agent-evaluation)). Defaults: `concurrency` 5, `timeout` 30 000 ms (minimum 1 000), `retries` 0, `trials` 1.

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

| Field          | Meaning                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `total`        | Cases run                                                                                                              |
| `errors`       | Cases whose every attempt failed or timed out (with several trials, a case counts as errored when every trial errored) |
| `metricErrors` | Metric scores that failed and count as 0, over every trial                                                             |
| `duration`     | Wall time of the run in ms                                                                                             |
| `cost`         | USD spent, `targetCost + judgeCost`                                                                                    |
| `targetCost`   | USD the target spent, over every attempt and trial that reported usage                                                 |
| `judgeCost`    | USD the LLM judge spent                                                                                                |

---

## Datasets

Datasets are immutable collections of eval cases. Each case has an `input`, optional `expected`, optional `context`, and optional `metadata`. Agent cases may also have `turns` (further user turns run on the same conversation), `expectedToolCalls` (`{ name, arguments? }[]`) and `expectedPassages` (ids or texts the retrieval should surface).

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

CSV must have an `input` column. Optional columns: `expected`, `metadata.*`, `context.*`, and `turns`, `expectedToolCalls` and `expectedPassages`, whose cells hold JSON arrays (CSV-quoted, an empty cell leaves the field out):

```csv
input,turns,expectedToolCalls,expectedPassages
Book a table,"[""For two, please""]","[{""name"":""book_table"",""arguments"":{""guests"":2}}]",
How long do refunds take?,,"[{""name"":""rag_search""}]","[""refund is issued within 5 days""]"
```

Both loaders name the line of the file a case comes from when the case schema refuses it (`Invalid case at line 3: input: ...`), the CSV loader counting quoted fields that span lines. The CSV loader splits on commas and throws on a malformed row, a quote never closed for one, with its line.

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
| `tokenF1`     | Token-level F1 score (precision and recall)    | Yes                 |
| `regex`       | Output matches a regex pattern                 | No                  |
| `jsonSchema`  | Output is valid JSON matching a Zod schema     | No                  |

```typescript
import {
  exactMatch,
  contains,
  containsAll,
  containsAny,
  similarity,
  tokenF1,
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
  tokenF1(),
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

`tokenF1()` computes token overlap using multiset counts so duplicate tokens are handled correctly, returning the harmonic mean of precision and recall. It lowercases unless `caseSensitive: true`, strips punctuation, removes standalone articles (`a`, `an`, `the`), splits on whitespace, scores 1 for both empty strings, and reports precision and recall in `details` whenever the score is below 1.

`regex()` ignores the `g` and `y` flags, which would make identical outputs alternate between pass and fail.

### LLM-as-Judge

Metrics scored by an LLM judge (0.0 to 1.0). They require a `judge` config on the suite and a Cogitator to run the judge agent: `judge.cogitator`, or the `cogitator` of an agent target. Without one, the suite throws when it is created.

| Metric             | Evaluates                                    |
| ------------------ | -------------------------------------------- |
| `faithfulness`     | Factual accuracy relative to input           |
| `relevance`        | How on-topic the response is                 |
| `coherence`        | Logical structure and readability            |
| `helpfulness`      | Practical usefulness to the user             |
| `contextRelevance` | Whether the retrieved passages fit the input |
| `gEval`            | G-Eval: evaluation steps, then a scale       |
| `llmMetric`        | Custom prompt or rubric, your criteria       |

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

When the run retrieved passages (see [Retrieval](#retrieval)), `faithfulness()` checks the response against them instead of `context`. `contextRelevance()` judges the input against the retrieved passages alone, or against `context` when nothing was retrieved, and scores 0 without a judge call when the case has neither.

The `judge` option is a `JudgeConfigInput`: `{ model, temperature?, maxTokens?, cogitator?, cache?, concurrency?, samples? }`, with `temperature` defaulting to `0`. `cache: true` reuses a verdict for the same model, settings and prompt in memory (a `JudgeCache` with `get` and `set` keeps them across runs), and `concurrency` caps the judge calls running at once.

`llmMetric` also takes a discrete `rubric` instead of a free prompt: the judge picks one level, and the score is normalized to 0 - 1 by the lowest and highest level. A rubric needs at least two levels with distinct scores, and a verdict that is not a level counts as a judge error.

```typescript
llmMetric({
  name: 'correctness',
  prompt: 'Grade whether the response answers the question correctly.', // optional with a rubric
  rubric: [
    { score: 1, description: 'wrong, or does not answer' },
    { score: 3, description: 'partly correct' },
    { score: 5, description: 'fully correct' },
  ],
});
```

`gEval({ name, criteria, steps?, scale? })` follows G-Eval: the judge scores each case on `scale` (`[1, 5]` by default, normalized to 0 - 1) following evaluation steps. Without `steps`, the judge writes them from `criteria` once per metric instance, before the first case, and every later case reuses them. A failed generation scores the cases waiting on it as judge errors, and the next case tries again. The original G-Eval weights each score by the probability of its token, which not every provider exposes, so set `judge.samples` (with a `temperature` above 0) to average several verdicts instead.

```typescript
gEval({
  name: 'clarity',
  criteria: 'A beginner can follow the explanation, and it names the key idea first.',
});
```

Every judge prompt keeps the untrusted values of a case (input, response, expected answer, context, retrieved passages, the turns of a conversation) inside XML-like tags such as `<input>` and `<response>`, with `<`, `>` and `&` escaped, so an answer cannot close its tag or open another, and the judge is told that tag contents are data to evaluate, never instructions. An answer that tells the judge to give it full marks is judged as content.

`judge.samples` asks the judge that many times per case and metric (1 by default) and scores the mean of the verdicts it could read. The score's `details` give the spread (`mean of 3 verdicts, spread 0.6..0.9`), `metadata.samples` each verdict, and `usage` the summed cost. With `cache`, each sample is cached under its own key.

`calibrateJudge(metric, examples, options?)` checks a judge against labels people gave: it scores each `{ input, output, expected?, context?, label }` (labels from 0 to 1) and returns `{ n, errors, pearson, spearman, mae, kappa, perCase }`, `kappa` being Cohen's kappa of pass and fail at `threshold` (0.5 by default). Pass a metric bound with `bindJudgeContext`, or `judge` with a `cogitator` to bind it. Examples the metric fails on are reported in `perCase` and left out of the figures.

```typescript
const calibration = await calibrateJudge(correctness, labelled, {
  judge: { model: 'openai/gpt-6.1-sol', cogitator: cog },
});
console.log(calibration.spearman, calibration.kappa);
```

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

Build domain-specific metrics with the `metric()` factory. `evaluate` gets `input`, `output`, `expected` and `context`, the run's `toolCalls`, `toolResults`, `retrieved` and `turns`, and the whole case result as `result`.

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

## Agent Evaluation

An agent target records what the agent did, not only what it answered. Each case result carries `toolCalls` (every call of the run), `toolResults` (`{ callId, name, result?, error? }`, the raw values the run's `onToolResult` reported) and `retrieved` (`{ id?, content, score?, source? }` passages the tool results surfaced), summed over every turn of the case.

### Tool calls and trajectory

```typescript
import { EvalSuite, Dataset, toolCalls, trajectory } from '@cogitator-ai/evals';

const dataset = Dataset.from([
  {
    input: 'What is the weather in Paris?',
    expectedToolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }],
  },
]);

const suite = new EvalSuite({
  dataset,
  target: { agent, cogitator },
  metrics: [toolCalls(), trajectory({ order: 'in-order' })],
});
```

`toolCalls({ arguments?, score? })` pairs the actual calls with the expected ones as multisets, each expected call taking at most one actual call. `arguments: 'subset'` (default) wants the expected arguments in the call with equal values, other arguments allowed, `'exact'` wants equal arguments and `'ignore'` compares names only. An expected call without `arguments` matches on its name. `score` is `'f1'` (default), `'recall'` or `'precision'`, and `details` lists the missing and unexpected calls.

`trajectory({ order? })` compares the sequence of tool names: `'exact'` (default) scores 1 for the same sequence and 0 otherwise, `'in-order'` scores the longest common subsequence over the longer sequence, and `'any-order'` the names both share over the longer sequence.

Both score 0 with `details: 'no expected tool calls provided'` on a case without `expectedToolCalls`, as `exactMatch()` does without `expected`. A case expecting no calls (`expectedToolCalls: []`) scores 1 when the agent made none.

### Retrieval

```typescript
import {
  retrievalRecall,
  retrievalPrecision,
  retrievalMRR,
  contextRelevance,
} from '@cogitator-ai/evals';
import { createSearchTool } from '@cogitator-ai/rag';

const agent = new Agent({ name: 'kb', model, tools: [tool(createSearchTool(pipeline))] });

const suite = new EvalSuite({
  dataset: Dataset.from([
    { input: 'How long do refunds take?', expectedPassages: ['refund is issued within 5 days'] },
  ]),
  target: { agent, cogitator },
  metrics: [retrievalRecall(), retrievalPrecision(), retrievalMRR(), contextRelevance()],
  judge: { model: 'google/gemini-3.5-flash-lite' },
});
```

The target's `retrieval` reads the passages out of each successful tool result. The default, `ragSearchPassages`, reads the `rag_search` tool of `@cogitator-ai/rag` (`{ results: [{ content, chunkId, score, source, ... }] }`, the `id` of a result or else its `chunkId` as the passage id) and any other result of that shape. Pass your own for other tools:

```typescript
target: {
  agent,
  cogitator,
  retrieval: ({ name, result }) =>
    name === 'search_docs' ? (result as Doc[]).map((d) => ({ id: d.slug, content: d.body })) : undefined,
},
```

A retrieved passage matches an expected one by an equal `id`, by an equal text once case and whitespace are normalized, or when one normalized text contains the other and the contained one has at least three words, so a short id or a single word never matches every passage that happens to hold it. `retrievalRecall()` scores the share of expected passages retrieved, `retrievalPrecision()` the share of retrieved passages expected, and `retrievalMRR()` the reciprocal rank of the first match (passages rank in the order they came). They score 0 on a case without `expectedPassages`, and a case expecting none scores 1 when nothing was retrieved.

### Multi-turn cases

```typescript
const cogitator = new Cogitator({ llm, memory: { adapter: 'memory' } });

Dataset.from([
  {
    input: 'My name is Ada.',
    turns: ['What is my name?'],
    expected: 'Ada',
  },
]);
```

An agent case with `turns` runs `input`, then each turn, on one thread of its own (`threadId` `eval-<uuid>`, a fresh one for every attempt and trial). The Cogitator's memory carries the conversation from turn to turn, so it needs a memory adapter. The case `output` is the last answer, `toolCalls`, `toolResults`, `retrieved` and `usage` cover every turn, and `turns` lists each `{ input, output, toolCalls? }`. A turn that fails fails the case with its error, `turns` then ending with the failed one, and a cancelled or timed-out case starts no further turn. LLM judges read a multi-turn case as the conversation, each turn's input and answer, with the last user message marked as the one the response answers. A `fn` target is called once per turn, with `context.turn` (0 for `input`) and `context.history` (the earlier `{ input, output }` turns).

### Trials and pass@k

```typescript
import { passAtK, exactMatch, threshold } from '@cogitator-ai/evals';

const suite = new EvalSuite({
  dataset,
  target: { agent, cogitator },
  metrics: [exactMatch()],
  statisticalMetrics: [passAtK('exactMatch', { k: 1 }), passAtK('exactMatch', { k: 5 })],
  assertions: [threshold('passAtK(exactMatch,5)', 0.9)],
  trials: 5,
});
```

`trials` (a positive integer, 1 by default) runs each case that many times. Trials share the suite's concurrency, timeout, retries, abort signal and `maxCases`, and each is scored on its own. The case result is the first trial that answered (the first one when every trial errored), so it carries an error only when all trials failed, with every trial in `trials` (each with its `scores`), and the aggregate of a metric takes the mean of a case's scored trials as that case's score. `stats.errors` counts a case as errored when every trial errored, while costs and `metricErrors` cover every trial. `latency()`, `cost()` and `tokenUsage()` see every trial as one value each, `passAtK()` sees the cases with their trials. `onProgress` fires once per case, after its last trial. `EvalComparison` takes `trials` too, comparing each case's mean over its trials.

`passAtK(metric, { k, threshold = 1 })`, named `passAtK(<metric>,<k>)`, estimates per case the chance that at least one of `k` trials scores `threshold` or more, with the unbiased estimator `1 - C(n - c, k) / C(n, k)` (`n` trials, `c` passing), and averages it over the cases with at least one scored trial. An errored trial counts as a failure. The suite throws when it is created if `k` exceeds `trials` or the metric is not among its `metrics`.

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
  trials: 1,
});

const result = await comparison.run();

console.log(`Winner: ${result.summary.winner}`);
for (const [name, mc] of Object.entries(result.summary.metrics)) {
  console.log(
    `  ${name}: baseline=${mc.baseline.toFixed(3)} challenger=${mc.challenger.toFixed(3)} p=${mc.pValue.toFixed(4)} ${mc.significant ? '*' : ''}`
  );
}
```

Binary metrics (every score 0 or 1) take McNemar's test, exact below 25 discordant pairs and chi-square with continuity correction from 25. Other metrics take the paired t-test, or Wilcoxon's signed-rank test with `test: 'wilcoxon'` (zero differences dropped, exact up to 20 pairs, normal approximation above). Paired differences are rounded to 12 significant digits, so float noise neither splits ties nor hides a zero. The winner follows the test's direction: the higher mean for McNemar's and the t-test, the larger rank sum for Wilcoxon's, which can disagree with `difference`, the mean difference. The p-values are corrected with Holm's method across the compared metrics: `pValue` is the test's own, `adjustedPValue` the corrected one, and `significant` means `adjustedPValue < alpha` (`alpha` 0.05 by default). Each metric also reports `difference` (the mean of challenger minus baseline), `ci` (a percentile bootstrap interval of the paired differences at `1 - alpha`, the same on every run with `seed`), `effectSize` (Cohen's d of the paired differences) and the `test` it ran.

`result.summary.latency` and `result.summary.cost` compare milliseconds and USD per case, paired over the cases both sides answered, where lower is better: means, `difference`, `pValue` and `winner`. `cost` is there only when both sides reported usage. Neither takes part in the metrics' vote on the overall winner.

With `pairwise`, the judge also reads both answers of each case and says which is better, twice, the second time with the answers swapped. Agreeing verdicts give the case to that side, disagreeing ones or a tie make it a tie, a side that errored loses the case without a judge call, and a case both sides errored on is left out. A judge failure counts as a tie and is reported.

```typescript
const comparison = new EvalComparison({
  dataset,
  targets: { baseline, challenger },
  metrics: [exactMatch()],
  judge: { model: 'openai/gpt-6.1-sol', cogitator: cog },
  pairwise: { criteria: 'Which answer is more accurate.' },
  test: 'wilcoxon',
  alpha: 0.05,
  seed: 42,
});

const { pairwise } = await comparison.run();
// { name, wins: { baseline, challenger }, ties, cases, winRate, judgeErrors, cost, perCase }
```

`winRate` is the challenger's wins over the decided cases, NaN when none was decided.

Access full suite results via `result.baseline` and `result.challenger`. `comparison.run({ signal })` cancels both runs.

---

## Reporters

Call `result.report()` after a suite run to output results.

| Reporter   | Output                                                                |
| ---------- | --------------------------------------------------------------------- |
| `console`  | Colored table with metrics, assertions, summary                       |
| `json`     | Writes `eval-report.json` (configurable path)                         |
| `csv`      | Writes `eval-report.csv` (configurable path)                          |
| `junit`    | Writes `eval-report.xml`, a JUnit report (configurable path)          |
| `github`   | GitHub Actions annotations, plus a job summary in Actions             |
| `ci`       | Compact verdict, sets `process.exitCode = 1` when an assertion fails  |
| `markdown` | Writes `eval-report.md`, a compact summary for a pull request comment |
| `html`     | Writes `eval-report.html`, a self-contained page for light and dark   |

```typescript
const result = await suite.run();

result.report('console');
result.report('json', { path: './reports/eval.json' });
result.report(['console', 'json', 'csv', 'junit'], { path: './reports/eval' });
result.report(['github', 'ci']);
```

The `path` is a base path: each file reporter adds its own extension (`.json`, `.csv`, `.xml`, `.md`, `.html`). `ci` runs last and does not end the process, so output flushes and later hooks still run before Node exits with code 1.

- **junit** writes one `<testsuite name="eval">` with a `<testcase>` per case (a `<failure>` when it errored, its scores in `<system-out>`) and a `<testcase>` per assertion (a `<failure>` when it did not pass). Everything is XML-escaped, and characters XML 1.0 does not allow are replaced.
- **markdown** writes the totals (with the trials per case when there are several), each metric's mean and cases, the assertions with pass or fail, and the failed cases. Every value is escaped, so no answer breaks the tables.
- **html** writes one page with inline CSS and no scripts or external assets: totals, metrics, assertions and every case with its scores, status, turns, trials, trace id and prompt version. Every value is HTML-escaped.
- **github** prints `::error` for each failed assertion and errored case and `::warning` for each failed metric score. When `GITHUB_STEP_SUMMARY` is set it also appends a Markdown summary with the totals, the aggregated metrics (mean, p50, p95, cases scored) and the assertions.

Agent run flags (`truncated`, `iterationLimitReached`, `paused`) show up per case in the json, csv and junit reports, and each aggregated metric's `count` (cases it was scored on) in the console, json and github output. The json report keeps each case's `toolCalls`, `toolResults`, `retrieved`, `turns` and `trials`, and the console and github reports show the trials per case.

### Vitest

```typescript
// eval/qa.eval.test.ts
import { afterAll } from 'vitest';
import { describeEval } from '@cogitator-ai/evals/vitest';

const qa = describeEval('qa agent', { suite, run: { maxCases: 50 }, timeout: 5 * 60_000 });

afterAll(() => qa.result().report('junit', { path: './reports/qa' }));
```

`evalMatchers` adds assertions on results to Vitest's `expect`, typed through a module augmentation of `Assertion` and `AsymmetricMatchersContaining` (Vitest 5):

```typescript
import { expect, it } from 'vitest';
import { evalMatchers } from '@cogitator-ai/evals/matchers';

expect.extend(evalMatchers);

it('books a table', async () => {
  const result = await suite.run();
  const [booking] = result.results;
  expect(booking).toHaveCalledTool('book_table', { guests: 2 });
  expect(booking).toFollowTrajectory(['find_restaurant', 'book_table'], { order: 'in-order' });
  expect(booking).toHaveRetrieved('doc:menu');
  expect(booking).toScoreAtLeast('toolCalls', 1);
  expect(result).toScoreAtLeast('trajectory', 0.8);
});
```

`toHaveCalledTool(name, args?)` checks a case result's calls, `args` as a subset of a call's arguments. `toFollowTrajectory(names, { order? })` wants exactly those calls in that order by default, the calls in that order with others between them for `'in-order'`, and each of them in any order for `'any-order'`. `toHaveRetrieved(idOrText)` matches passages as the retrieval metrics do. `toScoreAtLeast(metric, min)` reads a case result's score or a suite result's aggregated mean, and throws when the metric is missing.

`describeEval(name, { suite, run?, timeout? })` registers a `describe` block. The suite runs once in `beforeAll` (`timeout` defaults to 10 minutes, after which the run is cancelled), each case of `suite.cases(run?.maxCases)` gets a test that fails with the case error, and an `assertions` test lists every failed assertion. When the run itself fails, every test fails with that cause. `result()` returns the `EvalSuiteResult` once the run has finished.

---

## Experiment Tracking

Give a suite a `name` and JSON `metadata`, save each run as a run file, and compare runs later, across commits or prompt versions.

```typescript
import { EvalSuite, RunStore, compareRuns, reportComparison } from '@cogitator-ai/evals';

const suite = new EvalSuite({
  dataset,
  target: { agent, cogitator },
  metrics: [exactMatch(), faithfulness()],
  judge: { model: 'google/gemini-3.5-flash-lite', cogitator },
  name: 'support-agent',
  metadata: { branch: process.env.GITHUB_HEAD_REF, commit: process.env.GITHUB_SHA },
});

const result = await suite.run();
const store = new RunStore('./eval-runs');
const base = store.latest({ name: 'support-agent' });
store.save(result); // ./eval-runs/<runId>.json, as result.saveRun('./eval-runs') writes it

if (base) {
  const comparison = compareRuns(base, result, { seed: 42 });
  reportComparison(comparison, ['console', 'markdown'], { path: './reports/comparison' });
}
```

- **Run files.** `result.saveRun(target)` writes JSON with `format: 'cogitator.eval-run'` and `version: 1`: `runId`, `startedAt` and `finishedAt`, `name`, `metadata`, the dataset fingerprint (SHA-256 of the canonical JSON of the cases run), the config (metric names, judge model, temperature and samples, trials, concurrency, target kind, agent name and model), the prompt versions used, every case result with its `caseKey`, the aggregates, assertions and stats. A directory target (or one ending in `/`) gets `<runId>.json`. Functions, Cogitator instances and keys are never written. `result.toRun()` returns the same object, and `loadRun(path)` reads one back, validated with Zod.
- **Traces and prompts.** Agent cases keep the `traceId` of their run (`RunResult.trace.traceId`) and the versioned instructions in `prompt` (`{ key, versionId?, version?, abTest? }`, set when the Cogitator versions instructions with `cogitator.prompts`). Each turn of a multi-turn case keeps its own and the case keeps the last turn's, each trial its own.
- **RunStore.** `new RunStore(dir)` keeps run files in a directory: `save(result | run)`, `list(filter?)` newest first with id, name, metadata, times and metric means, `load(id)`, and `latest(filter?)`, where a filter is `{ name }` or a predicate.
- **compareRuns(base, head, { alpha?, test?, seed?, metrics? }).** Cases are matched by `caseKey` (SHA-256 of `{ input, turns, expected }`), the others listed in `added` and `removed`. Each metric both runs have gets the statistics of `EvalComparison`: means, `difference`, `ci`, `effectSize`, `pValue`, `adjustedPValue` (Holm across the compared metrics), `significant` and `winner` (`head`, `base` or `tie`), plus the `improved` and `regressed` cases. An errored side counts as 0, a case both runs errored on is dropped. `warnings` say when the datasets, the prompt versions, the metrics or the judge differ.
- **reportComparison(comparison, 'markdown' | 'html' | 'console', { path? }).** Renders a `compareRuns()` or `EvalComparison` result: the winner, a metric table with difference, CI, p and adjusted p and significance, the regressions and improvements, and the warnings. The default path is `eval-comparison`.

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
  .withTrials(3)
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
| `calibrateJudge` | Agreement of a judge metric with labelled examples                  |
| `EvalBuilder`    | Fluent builder for EvalSuite                                        |
| `compareRuns`    | Compares two saved runs or suite results case by case               |
| `RunStore`       | Directory of run files: save, list, load, latest                    |
| `loadRun`        | Reads and validates a run file                                      |
| `caseKey`        | The key a case is matched by across runs                            |
| `Dataset`        | Immutable dataset with from/fromJsonl/fromCsv/filter/sample/shuffle |
| `loadJsonl`      | Low-level JSONL file loader                                         |
| `loadCsv`        | Low-level CSV file loader                                           |
| `isLLMMetric`    | Type guard: checks if a `MetricFn` is an `LLMMetricFn`              |

### Metrics

| Export               | Type          | Description                                                        |
| -------------------- | ------------- | ------------------------------------------------------------------ |
| `exactMatch`         | Deterministic | Exact string match                                                 |
| `contains`           | Deterministic | Substring match                                                    |
| `containsAll`        | Deterministic | Fraction of keywords found                                         |
| `containsAny`        | Deterministic | Any configured keyword found                                       |
| `similarity`         | Deterministic | Levenshtein distance similarity score                              |
| `tokenF1`            | Deterministic | Token-level F1 score                                               |
| `regex`              | Deterministic | Regex pattern match                                                |
| `jsonSchema`         | Deterministic | Zod schema validation                                              |
| `faithfulness`       | LLM Judge     | Factual accuracy                                                   |
| `relevance`          | LLM Judge     | Topical relevance                                                  |
| `coherence`          | LLM Judge     | Logical structure                                                  |
| `helpfulness`        | LLM Judge     | Practical usefulness                                               |
| `contextRelevance`   | LLM Judge     | Relevance of the retrieved passages to the input                   |
| `gEval`              | LLM Judge     | Evaluation steps from criteria, then a score on a scale            |
| `llmMetric`          | LLM Judge     | Custom judge prompt or discrete rubric                             |
| `toolCalls`          | Agent         | Tool calls against `expectedToolCalls`, F1, recall or precision    |
| `trajectory`         | Agent         | Sequence of tool names, exact, in-order or any-order               |
| `retrievalRecall`    | Agent         | Share of `expectedPassages` retrieved                              |
| `retrievalPrecision` | Agent         | Share of retrieved passages expected                               |
| `retrievalMRR`       | Agent         | Reciprocal rank of the first expected passage                      |
| `latency`            | Statistical   | Response time percentiles                                          |
| `cost`               | Statistical   | Token cost aggregation                                             |
| `tokenUsage`         | Statistical   | Input/output token counts                                          |
| `passAtK`            | Statistical   | pass@k of a metric over the trials                                 |
| `metric`             | Custom        | Factory for domain-specific metrics                                |
| `ragSearchPassages`  | Helper        | The default `retrieval` of agent targets, for `rag_search` results |

### Assertions

| Export         | Description                                    |
| -------------- | ---------------------------------------------- |
| `threshold`    | Enforce min/max on metric mean                 |
| `maxErrorRate` | Fail a run where too many cases errored        |
| `noRegression` | Compare against saved baseline                 |
| `assertion`    | Custom assertion with arbitrary check function |

### Reporters

| Export                                 | Description                                      |
| -------------------------------------- | ------------------------------------------------ |
| `report`                               | Dispatch to one or more reporter types           |
| `reportComparison`                     | Render a comparison as console, Markdown or HTML |
| `comparisonMarkdown`, `comparisonHtml` | The Markdown or HTML of a comparison as a string |
| `describeEval` (`/vitest` entry)       | Run a suite as a Vitest describe block           |
| `evalMatchers` (`/matchers` entry)     | Matchers for `expect.extend()`, Vitest 5         |

`report` takes `console`, `json`, `csv`, `junit`, `github`, `ci`, `markdown` and `html`. `describeEval` takes `DescribeEvalOptions` and returns a `DescribeEvalHandle`.

### Types

| Export             | Description                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `JudgeConfigInput` | The `judge` option: model, settings, `cogitator`, `cache`, `concurrency`                      |
| `JudgeCache`       | Where verdicts are kept across runs: `get(key)` and `set(key, verdict)`                       |
| `AggregatedMetric` | Aggregate of a metric, with `count` for the cases it covers                                   |
| `MetricComparison` | A metric of a comparison, with `n` for the cases it was compared on                           |
| `ExpectedToolCall` | A tool call a case expects: `name` and optional `arguments`                                   |
| `Passage`          | A retrieved passage: `id?`, `content`, `score?`, `source?`                                    |
| `EvalTurnResult`   | A turn of a multi-turn case: `input`, `output`, `toolCalls?`, `traceId?`, `prompt?`, `error?` |
| `EvalPrompt`       | Versioned instructions of an agent run: `key`, `versionId?`, `version?`, `abTest?`            |
| `EvalRun`          | A saved run, as `loadRun()` returns it                                                        |
| `RunComparison`    | What `compareRuns()` returns                                                                  |

### Statistics

| Export               | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| `pairedTTest`        | Paired t-test for continuous metric comparison                  |
| `wilcoxonSignedRank` | Wilcoxon signed-rank test, zeros dropped, exact up to 20 pairs  |
| `mcnemarsTest`       | McNemar's test (chi-square, continuity corrected) for binary    |
| `mcnemarExact`       | Exact McNemar's test, the binomial test of the discordant pairs |
| `holm`               | Holm-Bonferroni adjusted p-values                               |
| `bootstrapCI`        | Seeded percentile bootstrap confidence interval of the mean     |
| `cohensD`            | Cohen's d of paired differences (dz)                            |
| `pearson`            | Pearson's correlation                                           |
| `spearman`           | Spearman's rank correlation                                     |
| `mean`               | Arithmetic mean                                                 |
| `median`             | Median value                                                    |
| `stdDev`             | Sample standard deviation                                       |
| `percentile`         | Arbitrary percentile                                            |
| `aggregate`          | Full stats: mean, median, min, max, stdDev, p50, p95, p99       |

### Agent Tools

| Export              | Description                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createRunEvalTool` | Creates a `run_eval` tool for agents for a given suite; its optional `maxCases` runs `suite.run({ maxCases })` and the summary (`total`, `metrics`, `assertionsPassed`) covers those cases |
| `evalTools`         | Returns all eval tools for a suite as an array                                                                                                                                             |

Like the RAG tools, eval tools carry a Zod `parameters` schema and can be passed to `tool()` from `@cogitator-ai/core`.

---

## License

MIT
