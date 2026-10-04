---
'@cogitator-ai/sandbox': patch
---

A WASM module given as a package path, such as `@cogitator-ai/wasm-tools/wasm/calc.wasm`, now resolves from your application. The executor resolved it from `@cogitator-ai/sandbox` itself, which does not depend on the package that ships the module, so with pnpm's strict layout (or any install that does not hoist) the call failed with `WASM module not found` unless a launcher happened to set `NODE_PATH`. Package paths are now resolved from the working directory, then from the entry script's directory, then from the sandbox package as before. Relative paths are read from the working directory, and a module that cannot be found is reported with the directory it was looked up from.
