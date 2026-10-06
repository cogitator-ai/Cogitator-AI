---
'@cogitator-ai/core': patch
'@cogitator-ai/sandbox': patch
'@cogitator-ai/types': patch
---

A WASM tool run that traps or panics, times out, or writes more than the sandbox keeps now comes back as a tool error with the reason, instead of an empty successful result the model would guess around. `SandboxExecutionResult` has a new `truncated` flag the WASM executor sets when it cuts the output.
