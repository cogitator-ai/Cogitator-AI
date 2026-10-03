---
'@cogitator-ai/core': minor
'@cogitator-ai/types': patch
---

Time travel works end to end.

- `compare()` and `compareWithOriginal()` failed with `Trace not found` because nothing wrote to the trace store. Checkpoints, replays and forks now store their traces; a deterministic replay's trace is the original's up to the replayed step.
- `mockToolResults` (forks) and `modifiedToolResults` (replays) are keyed by tool name, as documented: the tool answers with the given value and never runs. Before, live replays looked them up by call id and never matched. In deterministic replays a modified result now wins over the cached one.
- `skipTools` removes the tools from the replayed agent; it did nothing before.
- Checkpoints record the results of tool calls (`toolResults` was always empty) and pick the pending call by call id.
- `AgentOptimizer.captureTrace()` stores traces under the run's trace id, so it can share a trace store with `TimeTravel`.
