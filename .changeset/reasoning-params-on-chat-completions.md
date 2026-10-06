---
'@cogitator-ai/core': patch
'@cogitator-ai/types': minor
'@cogitator-ai/config': patch
---

Reasoning models get the parameters they accept on Chat Completions too. `azure/gpt-5` with `maxTokens` sent `{ temperature: 0.7, max_tokens: 500 }` and Azure rejected every call, and `openai/gpt-5` with stop sequences or `api: 'chat-completions'` sent the agent's default temperature. Reasoning models (o-series, GPT-5 and later) now get no `temperature` / `top_p` and their limit as `max_completion_tokens`. Azure tells them by the deployment name or by the new `providers.azure.model` when the name is your own, and its default `apiVersion` is now `2025-04-01-preview`, the first that serves these models.
