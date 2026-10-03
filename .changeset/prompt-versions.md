---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
---

Agent instructions get versions you can deploy, roll back and A/B test without redeploying code. `cog.prompts.deploy(agent, instructions)` makes every following run of that agent use the new version, `rollbackTo` brings the previous one back, and each version records its run count, success rate, score, latency and cost. `startABTest` splits threads between the current instructions and a treatment — a thread keeps its variant for the whole test — completes on a significant difference (Welch's t-test) and with `autoDeployWinner` deploys the winner. `RunResult.prompt` says which version and variant ran; `prompts.score` scores runs your way. Versions and tests live in memory by default, or in Postgres via `PostgresTraceStore.instructionVersions()` / `abTests()`.
