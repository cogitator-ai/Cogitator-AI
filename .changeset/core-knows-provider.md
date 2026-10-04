---
'@cogitator-ai/core': minor
---

New `cog.knowsProvider(name)` tells whether a `name/...` model prefix routes to that provider: a backend in `llm.backends`, a built-in provider or a registered plugin. It is the check `cog.route()` uses, so code that hands a model string to another process (such as `@cogitator-ai/worker`) can tell a provider prefix from a model name that merely contains a slash, like `meta-llama/llama-4-scout`.
