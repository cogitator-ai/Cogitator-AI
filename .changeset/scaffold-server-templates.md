---
'create-cogitator-app': patch
---

The `api-server` and `nextjs` templates keep the conversation: they configure in-process memory, so the next message in a thread sees the earlier ones and the thread routes of `api-server` answer instead of `503 Memory not configured`. `api-server` no longer serves unauthenticated runs to every origin on every interface: it listens on `127.0.0.1` in development, checks `Authorization: Bearer $API_TOKEN` on everything but health and docs, refuses to start in production without a token, enables CORS only for the origins in `CORS_ORIGIN`, and its `cogitator.yml` lists the provider key and `API_TOKEN` as deploy secrets. The `nextjs` chat shows run errors and a Stop button, and its `lint: next lint` script, which prompts in CI and is gone in Next 16, is replaced by `typecheck`.
