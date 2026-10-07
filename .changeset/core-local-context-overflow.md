---
'@cogitator-ai/core': patch
---

Context overflow errors of Ollama (`input length exceeds the context length`), llama.cpp (`the request exceeds the available context size`) and proxies that answer `context length exceeded` are reported as `LLM_CONTEXT_LENGTH_EXCEEDED` again, not as a plain `VALIDATION_ERROR`. Only the providers' own overflow phrases count, so a rejected `max_tokens` value still does not.
