---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
---

`RunOptions.onModelTurn` reports each model turn a run keeps, `{ content, toolCalls, model }`, as every `afterModel` middleware left it and before its tool calls run. A run without `stream: true` gets the text of a turn that calls tools only from here, and a run's own middleware, which sits inside the Cogitator's and the agent's, sees a turn before they do.

A run that uses memory refuses an empty `threadId` with `VALIDATION_ERROR`, as memory adapters no longer create a thread without an id.
