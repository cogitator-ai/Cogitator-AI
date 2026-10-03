---
'@cogitator-ai/sandbox': patch
'@cogitator-ai/types': patch
---

`memoryPages` now limits the WASM module's own memory, not only the memory Extism uses for input and output: the module's memory section gets that maximum before it loads, so `memory.grow` past it fails inside the module, and a module that needs more to start is refused. Modules given by URL are fetched by the executor so the limit applies to them as well.
