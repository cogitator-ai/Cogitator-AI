---
'@cogitator-ai/core': minor
---

- `cogitator.observe(observer)` attaches a run observer to a runtime after it was built, also seeing the runs that agent tools start on it; `CogitatorConfig.observers` and the `observer()` of the OpenTelemetry and Langfuse exporters watch every run and flush on `close()`.
- The package ships its documentation as Markdown in `docs/`, the docs of exactly the installed version, starting at `docs/index.md`.
- `restrictFileTools` and `isPathAllowed` (moved from channels) confine the file tools to directories, with `base` and `requireApproval` options.
- Time-travel checkpoints count only a run's own tool calls as steps: a run that continued a thread forked from the wrong turn before.
