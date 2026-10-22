---
'@cogitator-ai/evals': minor
---

Agent-native evaluation: tool calls, trajectories, retrieval, multi-turn cases, trials with pass@k and Vitest matchers

A case can now say what the agent should do, not only what it should answer. `expectedToolCalls` (`{ name, arguments? }[]`) is scored by `toolCalls()`, which pairs the calls of the run with the expected ones as multisets (arguments compared as a subset, exactly or not at all, scored as F1, recall or precision), and by `trajectory()`, which compares the sequence of tool names exactly, in order or in any order. `expectedPassages` (ids or texts) is scored by `retrievalRecall()`, `retrievalPrecision()` and `retrievalMRR()`, and the new `contextRelevance()` judge asks whether the retrieved passages fit the input.

An agent target records the raw tool results of the run (`toolResults`, through `onToolResult`) and the passages they surfaced (`retrieved`). The target's new `retrieval` option reads passages out of a tool result, by default `ragSearchPassages`, which reads the `rag_search` tool of `@cogitator-ai/rag`. `faithfulness()` checks the response against the retrieved passages when there are some, the case `context` otherwise.

A case with `turns` runs as a conversation: an agent target answers every turn on one thread of its own, so the Cogitator's memory carries it, and a `fn` target is called once per turn with `context.turn` and `context.history`. The case output is the last answer, tool calls, results, passages and usage are summed over the turns, and `turns` lists each. A failing turn fails the case with its error.

The suite's new `trials` option runs each case several times, each trial scored on its own, the case result being the first trial that answered and holding them all in `trials` and the aggregates taking the mean of a case's trials. `passAtK(metric, { k, threshold })` scores the unbiased pass@k estimate over the trials, and the suite refuses a `k` above `trials` or a metric it does not have.

The new `@cogitator-ai/evals/matchers` entry exports `evalMatchers` for `expect.extend()`: `toHaveCalledTool`, `toFollowTrajectory`, `toHaveRetrieved` and `toScoreAtLeast`. It is typed for Vitest 5, whose matcher types changed, and sits apart from `@cogitator-ai/evals/vitest` so `describeEval` keeps working from Vitest 3. The custom `metric()` callback also gets the run's tool calls, tool results, passages, turns and the whole case result. The CSV loader reads `turns`, `expectedToolCalls` and `expectedPassages` from JSON cells, the json report keeps the agent data and trials of each case, and the console and GitHub reports show the trials per case.

Datasets now validate `turns`, `expectedToolCalls` and `expectedPassages`: a CSV column or a JSONL field with one of those names that does not hold a valid value now fails the load, where it used to be ignored. The `faithfulness()` prompt changed, so cached faithfulness verdicts miss and its scores against saved baselines may shift. With several trials, `latency()`, `cost()` and `tokenUsage()` see every trial, and `stats.errors` counts a case as errored only when every trial errored. `EvalComparison` takes `trials` as well. LLM judges read a multi-turn case as the conversation, the last user message marked as the one the response answers.
