---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

A run that fails still reports what it spent.

- `onRunError`, of run options and of run observers, gets a third argument: the tokens and cost of every model call that finished (`RunUsage`, the shape of `RunResult.usage`). A run cut short by its timeout or an abort used to report nothing, though its calls were paid for.
- A `RUN_TIMEOUT` error carries the same in `details.usage`.
- Each `llm.chat` span carries its call's cost in `llm.cost`, so a tracer sees spending call by call.
- The Langfuse exporter keeps the usage of a failed run in its trace metadata, and decision runs pass theirs to `onRunError` too.
