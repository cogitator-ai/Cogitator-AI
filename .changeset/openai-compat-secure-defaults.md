---
'@cogitator-ai/openai-compat': minor
---

The server is no longer open to the network and to every web page by default. It binds `127.0.0.1` instead of `0.0.0.0`, `start()` refuses a public host without `apiKeys` unless `allowUnauthenticatedPublicAccess: true` says a gateway authenticates callers, and CORS is off until `cors.origin` names the origins browsers may call from. Run streams write a `: keep-alive` comment every `sseHeartbeatMs` (5 seconds by default) while a run is silent, so proxies no longer cut runs that wait on slow tools.
