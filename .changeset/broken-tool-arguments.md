---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

A tool call whose arguments are not valid JSON no longer fails the run. When a finished turn carries arguments a provider broke, or arguments that are not a JSON object, the call keeps empty `arguments` with the reason in the new `ToolCall.argumentsError`. The runtime does not run it or ask for its approval, and gives the model `Invalid arguments: ...` as the call's result, as it does for arguments that miss the tool's schema, so the model calls again. Before, the run failed with `LLM_INVALID_RESPONSE`. A call cut off at the token limit is still never run. `toolCallArguments()` reads arguments this way for backends of your own, and `parseToolCallArguments()` still throws.
