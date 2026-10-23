---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
'@cogitator-ai/memory': minor
'create-cogitator-app': minor
---

Memory defaults chosen on the memory benchmarks, and a shadow mode for extraction.

- Behavior change: `memory.contextBuilder` without a `strategy` now uses `hybrid` when `memory.embedding` is set, and `recent` otherwise as before. A runtime with embeddings and no strategy keeps the newest turns as history and also recalls the earlier turns and memory items that match the turn, which embeds every message of a thread once, in the background. On seven long-memory datasets `hybrid` averaged 44.9% against 18.0% for `recent`, as much as `relevant` at three quarters of its cost. A `strategy` you set is kept, so set `strategy: 'recent'` to keep the old behavior.
- `memory.extraction.mode` (types, core, config): `apply` by default, or `shadow`, which writes every new item as `suggested`, so it reaches no context, no recall and no fact until it is reviewed (`MemoryItems.query` with `statuses: ['suggested']`) and activated (`MemoryItems.activate`). It is `MemoryItems({ shadow: true })` (memory), which also leaves the confidence of other opinions alone. Extraction stays off by default and the docs recommend starting with `shadow`. Compaction stays off by default too.
- Scaffolded projects with a lasting store (`sqlite`, `postgres`, `redis`, `mongodb`) get long-term memory in `cogitator.yml`: the provider's embedding model in `memory.embedding` with the `hybrid` strategy (`recent` with Anthropic, which has no embedding model), and `memory.files` for the agents' notes. On Ollama the embedding model is pulled with the chat model. The `assistant` preset is among them. Only Postgres keeps the vectors: on SQLite, Redis and MongoDB the message index lives in the process, so after a restart (`cogitator dev` restarts on every change) each thread's messages are embedded again the first time it is used, one embedding per message. That cost is cents beside the gain of `hybrid`, so those templates keep it, and the generated AGENTS.md says so.
