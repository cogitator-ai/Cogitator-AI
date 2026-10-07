---
'@cogitator-ai/memory': minor
'@cogitator-ai/core': patch
'@cogitator-ai/types': minor
---

`ContextBuilder` never drops the system prompt anymore. Before, instructions larger than the budget (about 15k characters with the runtime's default 4000 tokens) were silently left out, so the run went to the model without a system prompt and lost `RunOptions.context` and reflection insights with it. The prompt is now always kept and counted, history gets what it leaves, and `BuiltContext.warnings` explains when nothing else fits. In runs, the agent's instructions always come first, `includeSystemPrompt: false` is ignored with a warning, and the warning about an oversized prompt is logged.
