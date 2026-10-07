---
'@cogitator-ai/memory': minor
'@cogitator-ai/core': patch
'@cogitator-ai/types': minor
---

A part of the context that fails to load no longer fails the run or vanishes silently. `ContextBuilder.build()` leaves out the history, facts, semantic search, knowledge graph or relevance scoring that failed and lists it in the new `BuiltContext.errors` (`{ source, error }`). Runs pass each of them to `onMemoryError` with the `'load'` operation and log a warning, so an embedding API answering 429 with `includeSemanticContext` no longer fails every run, and a brief database outage no longer makes the agent answer as if the conversation never happened. The runtime also warns at connect when `includeFacts`, `includeSemanticContext` or `includeGraphContext` cannot add anything with the configured memory.
