---
'@cogitator-ai/types': minor
'@cogitator-ai/sandbox': minor
'@cogitator-ai/core': patch
---

Sandbox fallbacks are explicit and safe. `sandbox.allowNativeFallback: false` refuses to run Docker-sandboxed tools on the host when Docker is unavailable (the fallback stays on by default, with a loud warning). WASM tools no longer fall back to Docker or native execution, which failed with "Command array is empty". Every Docker execution now gets a container no code ran in before (a fresh one is kept warm), so files and processes cannot leak between runs or users; `pool.reuseContainers: true` restores reuse.
