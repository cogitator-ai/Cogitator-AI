---
'@cogitator-ai/memory': minor
---

`unwrap(result)` turns a `MemoryResult` into its data, or throws an `Error` with the adapter's message when the call failed: `const thread = unwrap(await memory.createThread('agent-1'))`.
