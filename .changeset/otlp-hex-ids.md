---
'@cogitator-ai/core': patch
---

OTLP exporter: send valid OpenTelemetry ids. Span ids went out as `span_…` and trace ids as `trace_…` whenever `onRunStart` had not mapped the run, so collectors refused the batch with 400, and the exporter re-queued it forever. Ids are now derived from the Cogitator ids with SHA-256 (32 hex chars per trace, 16 per span), which keeps parent links and works after a run ends; the original ids and the run id are kept as attributes. Attributes keep their types (doubles, booleans, objects as JSON), timestamps are exact, and a batch refused with a 4xx status is dropped instead of retried.
