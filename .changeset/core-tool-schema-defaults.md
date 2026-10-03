---
'@cogitator-ai/core': patch
---

Tool parameters with a Zod `.default()` are no longer sent to the model as required: tool schemas describe the input side, as the WASM tools already did.
