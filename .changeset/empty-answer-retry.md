---
'@cogitator-ai/core': patch
---

A run no longer ends on an empty turn. When the model stops with neither text nor tool calls — Gemini occasionally does this right after a tool result — the run asks again, up to twice, instead of returning an empty answer (and, for structured output, an `undefined` `structured`). The empty turn is never added to the conversation or saved to the thread, and the retries count towards `maxIterations`. Turns cut off by the token limit are not retried.
