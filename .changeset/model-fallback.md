---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
---

Agents can fall back to other models. `fallbackModels` on an agent lists models a turn moves to, in order, when its model fails in a way another model may not: the provider is down, overloaded or timing out after its retries, the account is out of quota, the key is rejected, the model is gone, the prompt does not fit its context window or its answer could not be read. Rate limits and server errors are still retried on the same model first (`llm.retry`), quota, authentication, permission and missing-model errors move at once, and `content_filter` and `invalid_request` failures, which another model would refuse as well, never move. An aborted run never moves either.

Each model has a circuit breaker shared by the runtime's runs, `llm.modelCircuitBreaker` (`failureThreshold` 5, `resetTimeout` 30 000 ms, `halfOpenRequests` 3 by default, also accepted by `cogitator.yml` through `@cogitator-ai/config`): a model that keeps failing, or fails in a way that lasts, is skipped until its breaker lets a call through again. A prompt too long for a model and a call the caller aborted do not count against it. Every turn starts from the agent's model, a stream moves only before its first token, a fallback turn is priced at the model that answered it, `onModelFallback` and an `llm.fallback` span report every move, and `RunResult.modelUsed` names the model of the final answer. When every model fails the run ends with their shared error code, or `LLM_UNAVAILABLE` when they failed differently, each failure in `details.attempts`. `fallbackModels` survives `agent.serialize()` (and `Agent.validateSnapshot` checks it) and the agent wire format.

An agent without `fallbackModels` behaves exactly as before. New exports: `FallbackModel`, `ModelFallbackEvent`, `ModelCircuitBreakerConfig` and `ModelCircuitBreakerConfigSchema`.
