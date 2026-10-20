---
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
'@cogitator-ai/core': minor
---

OpenAI-compatible servers get only the request fields they understand. A server profile says which field takes the output token limit, whether streams ask for usage with `stream_options` and which `reasoning_effort` values the server takes. Set it with `profile` on `llm.providers.openai` or `llm.providers.vllm`, by preset name (`openai`, `generic`, `vllm`, `ollama`, `lmstudio`, `llamacpp`, `groq`, `together`, `deepseek`, `mistral`, `openrouter`) or field by field over a preset. An effort the server does not take is sent as the nearest one it does.

The built-in providers use their own preset. Mistral rejects fields it does not know, so it no longer gets `stream_options` (its streams failed with 422) or efforts beyond `high`. DeepSeek gets `none`, `low`, `high` or `max`, Together `low`, `medium` or `high` and no `stream_options`, Groq `max_completion_tokens`. A server without a preset keeps the request it got before. The official OpenAI API on Chat Completions (used when a request has stop sequences) takes efforts up to `xhigh`, so `max` is sent as `xhigh` there.
