---
'@cogitator-ai/config': minor
'@cogitator-ai/core': patch
'@cogitator-ai/types': minor
---

Bedrock works with temporary AWS credentials again. `loadConfig` no longer copies `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` into `llm.providers.bedrock`, where they replaced the SDK credential chain without the session token and STS, SSO or CI role credentials failed with `UnrecognizedClientException`. The AWS SDK now resolves them itself, together with `AWS_SESSION_TOKEN` and `AWS_PROFILE`. Static credentials come only from `COGITATOR_BEDROCK_*` or `llm.providers.bedrock`, which gains `sessionToken` and `profile` (also `COGITATOR_BEDROCK_SESSION_TOKEN` and `COGITATOR_BEDROCK_PROFILE`), and `BedrockBackend` sends them to the SDK.

`PROVIDER_ENV` in `@cogitator-ai/config` lists the environment of every built-in provider, and `resolveModelRoute()` in `@cogitator-ai/types` is the one rule for which provider a model string runs on, used by the runtime and by `cogitator deploy`.
