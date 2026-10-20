---
'@cogitator-ai/memory': minor
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

A run's history is sized to the model it runs on. With `memory.contextBuilder` set and no `maxTokens`, the runtime used to keep every run within 4000 tokens of history, whatever the model. The budget is now the context window of the model the run starts on (from the model registry, then the model family, else 8192 tokens), minus room for the answer (the agent's `maxTokens`, else 15% of the window), the tool schemas and the input, and below the point where the context manager would compress, when it is on. A model on a local Ollama gets at most the 4096 tokens Ollama serves by default (Ollama cloud models get their whole window). The builder keeps `reserveTokens` (10% of the budget by default) on top as slack. An explicit `maxTokens` still wins.

`ContextBuilder.build()` takes `maxTokens` per call, so one builder serves models of different sizes, and `ContextBuilderConfig.maxTokens` is optional: a build without a budget from either side throws, and a budget that is not a positive number throws too, `memory.contextBuilder.maxTokens: 0` included. `BuiltContext.dropped` (`DroppedContext`) lists what was left out: the history entries, facts, search results and graph nodes, with their token count. With the `relevant` and `hybrid` strategies the entries include those the selection passed over. `ContextBuilderConfigSchema` accepts a config without `maxTokens`, and `modelContextWindow(model)` from `@cogitator-ai/core` gives the window the runtime uses.

**Migration:** runs with `memory.contextBuilder` and no `maxTokens` now send much more history on models with large windows, and every turn costs more on long threads. Set `memory.contextBuilder.maxTokens` to keep a cap, `4000` restores the previous behavior. If your Ollama server runs with a larger context (`OLLAMA_CONTEXT_LENGTH`), set `maxTokens` to use it. Code that builds `BuiltContext` objects of its own, such as test doubles, needs a `dropped` field.
