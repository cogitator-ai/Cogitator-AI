---
'@cogitator-ai/core': patch
'@cogitator-ai/models': patch
---

Cogitator runs on Cloudflare Workers and on Deno without extra permissions. Agents no longer draw a random id in their constructor — it is generated on first read — so they can be created at module scope, where Workers forbid random values. The runtime, logger and built-in tools read environment variables through a guard, and only when a feature needs them: a run no longer asks for `OPENAI_API_KEY` unless it has audio, and runtimes without `process` or with env access denied get `undefined` instead of an error. The model price cache in `@cogitator-ai/models` loads the file system lazily and stays in memory where there is none, so importing it no longer reads the home directory. `validateSkill` checks dependencies through `process.getBuiltinModule` and warns where packages cannot be resolved.
