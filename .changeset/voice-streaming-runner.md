---
'@cogitator-ai/voice': minor
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

Voice replies are spoken while the model generates them, and an interrupted reply leaves only what the user heard in memory

`VoiceAgentRunner` gains an optional `stream(input, context)` that returns a `VoiceTurn`: an `AsyncIterable<string>` of text deltas with an optional `settle({ spoken, interrupted })`. `createCogitatorRunner` implements it with `stream: true` and `onToken`. A `PipelineSession` with such a runner splits the deltas into sentences and synthesizes them in order through `tts.streamSynthesize`, so the first audio goes out before the answer is complete. The splitter, exported as `SentenceSplitter`, keeps abbreviations, decimals and list numbers inside their sentence, splits at `?!`, ellipses before a new sentence, CJK full stops and line breaks, flushes a tail without punctuation at the end and cuts a sentence without a break at `maxSentenceLength` (default 250) on whitespace. Sessions emit a new `agent_response_delta` event for each piece of text, forwarded to `VoiceAgent` clients as `{ type: 'agent_response_delta', text }`, and `agent_response` still carries the whole answer once it is generated. `VoicePipeline.process()` returns one buffer and keeps using `run()` with a single `synthesize()` call.

When a streamed turn stops early (an interruption, a barge-in, closing the session, or a model or TTS error), the session settles it with the sentences whose audio was sent to the client in full. The server cannot know how much of that audio the client played. With `createCogitatorRunner` the thread then holds what was spoken: the answer's assistant message is replaced by its spoken part with `metadata.interrupted: true`, or removed when nothing was spoken, and a run stopped mid-generation gets its spoken part saved after its `interrupt` event. Text said alongside tool calls stays as the run saved it, and a turn spoken in full leaves the thread exactly as before. The next streamed turn of a session starts once the previous one settled.

`bargeIn: true` on `VoicePipeline` or a pipeline-mode `VoiceAgent` lets VAD speech during a reply stop it and start listening. It is off by default, since without echo cancellation on the client the agent's own voice would interrupt it.

A realtime `VoiceAgent` without `tools` now gives the model the agent's own tools through the runner's new `realtimeTools()`, which `createCogitatorRunner` builds with `createRealtimeTools`, so calls go through approvals, guardrails and the sandbox with the session's thread id. `agentTools` passes options such as `onApproval`, and `agentTools: false` turns it off. Explicit `tools` still win, `tools: []` included.

Core: `RunOptions.onMemoryEntry` is called with each entry a run saves to its thread, also for a run that is aborted or fails, so a caller knows where such a run wrote without a `RunResult`.

Migration: a pipeline `VoiceAgent` or `PipelineSession` built with `createCogitatorRunner` now streams. Listeners of `agent_response` keep working, but the event can now arrive while the first sentences are already playing, and TTS is called once per sentence instead of once per answer. A realtime `VoiceAgent` built with `createCogitatorRunner` and no `tools` now exposes the agent's tools to the model: pass `agentTools: false` to keep the old behavior. Tools that need approval are refused unless `agentTools.onApproval` or `guardrails.onToolApproval` approves them. `RealtimeToolsOptions` moved to the package's shared types and is exported from the same place as before.
