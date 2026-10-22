# Evals Examples

Evaluation framework examples using `@cogitator-ai/evals`.

## Prerequisites

Examples 02, 03 and 04 require an LLM provider API key:

```bash
export GOOGLE_API_KEY=your-key-here
```

Example 01 uses a mock function and needs no API keys.

## Examples

### 01 — Basic Evaluation

Run deterministic metrics (exact match, contains) against a mock function target. Shows dataset creation, threshold assertions, and console reporting.

```bash
npx tsx examples/evals/01-basic-eval.ts
```

### 02 — LLM-as-Judge

Evaluate a real agent using LLM judge metrics (faithfulness, relevance). Demonstrates judge config, progress tracking, and saving baselines.

```bash
npx tsx examples/evals/02-llm-judge.ts
```

### 03 — A/B Comparison

Compare two agents with different configurations on the same dataset. Shows paired statistical testing, p-values, and winner determination.

```bash
npx tsx examples/evals/03-ab-comparison.ts
```

### 04 - Agent Evaluation

Evaluate what an agent does: expected tool calls scored by `toolCalls()` and `trajectory()`, expected passages by `retrievalRecall()`, a two-turn case on one conversation, and three trials of each case scored with `passAtK()`.

```bash
npx tsx examples/evals/04-agent-eval.ts
```
