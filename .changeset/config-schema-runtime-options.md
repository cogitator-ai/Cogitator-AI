---
'@cogitator-ai/config': minor
---

The config schema silently dropped runtime options it did not know. YAML and `defineConfig` now keep `sandbox.allowNativeFallback`, `sandbox.pool.reuseContainers`, sandbox `defaults` mounts/env/WASM fields, embedding `dimensions` (and the Google `baseUrl`), every `contextBuilder.graphContextOptions` field, prompt injection `patterns` and `failMode`, `guardrails.constitution`, `llm.plugins` and `prompts.autoDeployWinner`.
