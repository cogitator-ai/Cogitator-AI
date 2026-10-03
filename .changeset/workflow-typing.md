---
'@cogitator-ai/types': patch
'@cogitator-ai/workflows': patch
---

Workflow typing fixes. `addLoop` conditions receive the builder's state type, like `addConditional`, instead of `unknown`. `executeParallelSubworkflows`, `parallelSubworkflows`, `fanOutFanIn` and `scatterGather` carry the child workflow state (`CS`), so a typed child workflow fits without casts. `'noop'` is a valid tracing exporter, and `WorkflowTracer.isSampled()` is `false` with a sample rate of 0.
