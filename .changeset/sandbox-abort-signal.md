---
'@cogitator-ai/types': minor
'@cogitator-ai/sandbox': minor
'@cogitator-ai/core': patch
---

A sandboxed execution stops when its signal aborts. `SandboxExecutionRequest` takes `signal`: aborting it kills the native process group, ends the Docker exec and removes its container (an aborted container is never reused), or closes the WASM plugin, which ends its worker. The result is a failure naming the reason, `Execution aborted: <reason>`, and a signal that is already aborted runs nothing. A Docker execution aborted while its container is still being pulled or started fails at once, and the container is removed when it comes up.

Core passes the run's signal to sandboxed tools, so cancelling a run stops a Docker or WASM tool instead of leaving it running until its own timeout, and the call fails with the abort reason, as a native tool does.

The container pool removes a container once even when an aborted execution releases it while the pool shuts down, and `destroyAll()` waits for removals still in progress.
