---
'@cogitator-ai/memory': minor
---

`LLMEntityExtractor` now accepts a Cogitator `LLMBackend` directly together with a `model` (`new LLMEntityExtractor(backend, { model })`), so no hand-written adapter is needed. Hand-written `LLMBackendMinimal` adapters keep working and receive the configured `model` when one is set.
