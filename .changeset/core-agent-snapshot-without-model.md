---
'@cogitator-ai/core': patch
---

`Agent.deserialize()` accepts the snapshot of an agent without a model (which runs on `llm.defaultModel`); `validateSnapshot()` used to reject it.
