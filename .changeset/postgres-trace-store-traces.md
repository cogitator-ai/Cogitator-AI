---
'@cogitator-ai/core': minor
---

`PostgresTraceStore.traces()` adapts the store to a `TraceStore`, so it can back `AgentOptimizer`, `DemoSelector` or `TimeTravel` directly. Traces also persist the run's `prompt` (a `prompt` column is added to existing tables on connect).
