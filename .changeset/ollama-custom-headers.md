---
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
'@cogitator-ai/core': minor
---

Add custom HTTP headers to Ollama provider configuration for authentication proxies and gateways. Headers reach both chat and streaming requests, while the JSON content type is preserved and `apiKey` takes precedence over custom authorization regardless of header-name casing. Normalize all trailing slashes in the Ollama base URL before building request endpoints.
