---
'@cogitator-ai/ai-sdk': minor
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

A full AI SDK provider, Cogitator agents as AI SDK agents, the conversation as messages instead of a transcript, and agent events as custom parts

`createCogitatorProvider` carries the members of its specification, so `createProviderRegistry` takes it. Its embedding and image models throw `NoSuchModelError`, and so does an unknown agent, which used to throw a plain `Error` with the same message.

`toAISDKAgent(cogitator, agent, settings?)` from the new `@cogitator-ai/ai-sdk/agent` entry point (ai@7) is a `ToolLoopAgent` on `cogitatorModel()`, an AI SDK agent for everything that takes one.

The prompt no longer reaches the agent as a `User:` / `Assistant:` / `Tool:` transcript. Its trailing user messages are the input, and the turns before them are the run's history as messages, tool calls and their results included, through the new `RunOptions.history` in core: the conversation the caller holds, read instead of the thread's memory, refused when it holds a system message. A prompt that does not end with a user message is now refused, unless it answers tool approvals.

`providerOptions.cogitator` (`providerMetadata.cogitator` on ai@4) takes `threadId`, `userId` and `saveHistory`. With a `threadId`, the memory thread is the history and only the new turn of the prompt is used. A call without one no longer saves its turn to a thread of its own, which nothing could read back, unless `saveHistory: true`.

`v4` models report handoffs and model fallbacks inside the run as custom parts, `cogitator.handoff` and `cogitator.model-fallback`.
