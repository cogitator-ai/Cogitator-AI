---
'@cogitator-ai/workflows': patch
---

`WorkflowExecutor.resume()` and `stream()` accept the full executor options (`signal`, `tracer`, `metricsCollector`, stores, ...), and runs without their own tracer or metrics collector now use the ones set with `setGlobalTracer` / `setGlobalMetrics` when those are enabled.
