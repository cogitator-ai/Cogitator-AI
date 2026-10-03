---
'@cogitator-ai/self-modifying': patch
---

`ToolSandbox` no longer counts worker start-up against `maxExecutionTime`. The limit used to start before the worker thread was spawned, so on a loaded machine (where a worker can take hundreds of milliseconds to boot) tools with short limits timed out before running a single line. The limit now starts once the worker is online, with a separate 10 s guard for a worker that never starts. A tool that hits the limit is always reported as a timeout, never as an error thrown by the tool, so `allowThrow` test cases no longer pass for tools that hang.
