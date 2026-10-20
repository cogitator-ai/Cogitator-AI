---
'@cogitator-ai/memory': minor
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

A run's history is sized to the model it runs on. With `memory.contextBuilder` set and no `maxTokens`, the runtime used to keep every run within 4000 tokens of history, whatever the model. The budget is now the context window of the model the run starts on (from the model registry, then the model family, else 8192 tokens), minus `reserveTokens` (10% of the budget by default). An explicit `maxTokens` still wins.

`ContextBuilder.build()` takes `maxTokens` per call, so one builder serves models of different sizes, and `ContextBuilderConfig.maxTokens` is optional: a build without a budget from either side throws. `BuiltContext.dropped` (`DroppedContext`) lists what did not fit: the history entries, facts, search results and graph nodes left out, with their token count. `ContextBuilderConfigSchema` accepts a config without `maxTokens`.

**Migration:** runs with `memory.contextBuilder` and no `maxTokens` now send much more history on models with large windows, and every turn costs more on long threads. Set `memory.contextBuilder.maxTokens` to keep a cap, `4000` restores the previous behavior. Code that builds `BuiltContext` objects of its own, such as test doubles, needs a `dropped` field.
