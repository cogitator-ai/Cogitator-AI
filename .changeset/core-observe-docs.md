---
'@cogitator-ai/core': minor
---

- `cogitator.observe(observer)` attaches a run observer to a runtime after it was built, also seeing the runs that agent tools start on it; `CogitatorConfig.observers` and the `observer()` of the OpenTelemetry and Langfuse exporters watch every run and flush on `close()`.
- The package ships its documentation as Markdown in `docs/`, the docs of exactly the installed version, starting at `docs/index.md`.
- `restrictFileTools` and `isPathAllowed` (moved from channels) confine the file tools to directories, with `base` and `requireApproval` options.
- The Langfuse exporter marks the trace of a failed run as an error, ends what was still open as ERROR and drops the run, which it kept forever before.
- Time-travel checkpoints count only a run's own tool calls as steps: a run that continued a thread forked from the wrong turn before.

**Breaking:** a time-travel step is the index of a tool call of the run itself. Checkpoints of runs on a thread with earlier tool calls now have smaller step numbers, and a step past the last tool call forks before the final answer. Code that stored step numbers of such runs needs to read them again from `getCheckpoints()`.
