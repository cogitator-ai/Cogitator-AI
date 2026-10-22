---
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
'@cogitator-ai/core': minor
---

Add custom HTTP headers to Ollama provider configuration for authentication proxies and gateways. Headers reach both non-streaming and streaming chat requests, while the JSON content type is preserved and `apiKey` takes precedence over custom authorization regardless of header-name casing. Reject invalid HTTP headers when constructing the backend. Normalize all trailing slashes in the Ollama base URL before building request endpoints.
