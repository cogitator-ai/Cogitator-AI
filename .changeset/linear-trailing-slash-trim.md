---
'@cogitator-ai/a2a': patch
'@cogitator-ai/config': patch
'@cogitator-ai/deploy': patch
'@cogitator-ai/core': patch
'create-cogitator-app': patch
---

Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.
