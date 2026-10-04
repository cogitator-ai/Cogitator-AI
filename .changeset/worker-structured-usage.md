---
'@cogitator-ai/worker': minor
---

Queued agents now do everything an in-process agent does with its answer and its bill. A job result carries `structured` (the validated answer of a JSON schema agent), the reasoning summary and `usage` with the run's cost, so a producer no longer parses JSON from `output` or prices tokens itself. `serializeAgent(agent)` builds a job from an existing agent, turning its Zod response schema into JSON Schema that the worker turns back into a schema, and carries its reasoning effort and `topP`. The redis config takes a `url` (`redis://`, or `rediss://` for TLS) with a username and a database, and explicit fields override it. `tokenUsage` stays for compatibility and is deprecated.
