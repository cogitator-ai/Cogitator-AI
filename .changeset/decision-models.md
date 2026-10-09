---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
'@cogitator-ai/models': minor
'@cogitator-ai/config': minor
'@cogitator-ai/studio': patch
---

Decision models and OpenRouter as a built-in provider.

- `cog.decide()` asks a decision model typed questions about a state and returns typed answers with probabilities instead of text: `noul` for yes or no, `choice` for one of several options, `score` for a level on a scale. Answers are typed by the questions, the request is checked before the call and the answer after it, and the call goes through the LLM retry policy, is priced and is reported to run observers as a run with one `llm.decide` span.
- `decisionTool()` turns fixed questions into a tool an agent passes the state to.
- OpenRouter's Decisions API is built in, with TypeSafe's Jev (`openrouter/typesafe/jev-1.13`). Other providers plug in through `llm.decisionBackends` and the `DecisionBackend` interface.
- OpenRouter is a built-in provider for chat too: `llm.providers.openrouter` with `apiKey` and an optional `baseUrl`, or `OPENROUTER_API_KEY` through `@cogitator-ai/config`.
- A chat run on a decision model fails at once with `CONFIGURATION_ERROR` instead of a provider error.
- `LLMRetryPolicy` and `retryLLMCall` give calls that are not chat the retry policy of LLM backends.
- `@cogitator-ai/models` knows Jev with its price, marks models with `kind: 'chat' | 'decision'` and adds `isDecisionModel()`.
- Studio shows `llm.decide` spans.

**Behavior change:** a model string starting with `openrouter/` now runs on the OpenRouter provider. Before, the prefix stayed part of the model name on `llm.defaultProvider`.
