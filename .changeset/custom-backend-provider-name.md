---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
---

A custom backend can report its own provider name: `LLMBackend.provider` (and `BaseLLMBackend.provider`) is now `LLMBackendProvider`, a built-in `LLMProvider` or any other string, so `class MyBackend extends BaseLLMBackend { readonly provider = 'my-llm' }` compiles.
