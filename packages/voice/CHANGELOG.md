# @cogitator-ai/voice

## 0.10.0

### Minor Changes

- [#293](https://github.com/cogitator-ai/Cogitator-AI/pull/293) [`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8) - Steer a run while it goes on, choose what a second message does to a busy thread, pause a run on a question a tool asks, and cancel a run without losing what it showed or did.

  Behavior changes, none of which needs a code change:

  - An aborted run (its `signal`, its timeout, `handle.abort()` or a newer run that interrupts it) now leaves more in its thread: the text it already streamed as an assistant message with `metadata.interrupted: true`, the results of tool calls that finished before the abort, and `Aborted before dispatch` for the calls it never started. Before, it left only its `interrupt` entry. A tool that ignores the signal still runs on, its late result is never written.
  - History read from memory now answers a tool call left without a result (a crash, an abort while the tool ran) with `The run stopped before this tool call returned: outcome unknown, verify before retrying`, instead of dropping the call from the assistant message. The model learns the call may have run. The log is not rewritten. Code that sends `history` of its own is not affected.
  - A paused run's `output` is the text of its last assistant message. For a pause on approvals this is what it always was.

  New:

  - `cog.start(agent, options)` returns a `RunHandle`: `steer(message)` adds a user message after the current step's tool calls (none is skipped) and wakes an agent about to stop, `followUp(message)` runs once the agent would stop (with a fresh `maxIterations`), `inject(message)` adds context to the next model call without waking the agent (one left at the end is saved to the thread), `abort(reason?)` stops the run and returns what it did not deliver, and `result` is what `run()` returns. `queue: { steering, followUp }` takes queued messages `'one-at-a-time'` (default) or `'all'` at once. Delivered messages are saved as `message` entries with `metadata.queued`, so a later run reads them as history, and a run that pauses returns the rest in `result.undelivered`. `run()` is unchanged.
  - `multitaskStrategy` (`RunOptions`, or `CogitatorConfig` for every run) says what a run does when another run of the runtime goes on in its thread, with the names of LangGraph's `multitask_strategy`: `enqueue` waits, `reject` fails with `THREAD_BUSY` (409), `interrupt` aborts the running one (it fails with `RUN_INTERRUPTED`, 409), `rollback` interrupts it and runs on a branch from where it started, so the thread goes on as if it never happened. Unset, runs of one thread go on side by side as before. A run started from a tool call of the run going on is never held back, other runs of the same trace follow the strategy.
  - Tools pause a run to ask a person with `context.interrupt({ reason, message, responseSchema, expiresAt })`. The run returns `status: 'paused'` with the question in `result.interrupts` (`id`, `kind: 'input'`, `reason`, `message`, `responseSchema` as JSON Schema, `expiresAt`, `toolCallId`, `toolName`), and `cog.resume(agent, thread, { responses: { [id]: answer } })` checks the answer against the schema and runs the tool again, where `interrupt()` returns it, parsed by a Zod schema. A wrong answer fails the resume with `INTERRUPT_ANSWER_INVALID` (400, `details.interruptId`), one after `expiresAt` with `INTERRUPT_EXPIRED` (410), and the run still waits. Finished calls of the same step keep their results. The pause and the resume are logged as `interrupt` entries (`status: 'paused' | 'resumed'`).
  - The run result wire format (`toAgentWireRunResult`) keeps `interrupts`, and `AgentRunPausedError` says when a workflow node or a swarm turn paused on questions instead of approvals.
  - Tool calls of a step run one after another, and the step stops at the first question: the calls after it run once the answer came. With `parallelToolCalls: true` the other calls run before the answer. Calls that finished keep their results, the checkpoint lists them in `turn.completed`, and a handoff among them hands over once the resumed step is done. A resume that leaves a question unanswered pauses on it again as it was asked, its tool not run again and its `expiresAt` unchanged. Answers are checked with the tool's Zod schema (refinements included) while the process that asked keeps it, else with the stored JSON Schema of the schema's input side.
  - A run with a `multitaskStrategy` is refused with `THREAD_ACCESS_DENIED` before it touches another user's run going on in the thread. A follow-up or steering message starts a new task, so its first tool call is never taken for a duplicate. `handle.abort()` is final: what it returns was never delivered or saved, also when it comes after the last model turn.
  - Queued messages pass the run's `beforeRun` input checks (PII in `block` mode, prompt injection, input guardrails, your own hooks) before they reach the model or the thread, injected messages saved at the end too. A refused message is dropped and listed in `handle.refused` with its error (`onRefusedMessage` in the options of `start()`), the run goes on.
  - A question that expired without an answer no longer holds the run: a resume answers its tool call with `Nobody answered "<message>" before it expired`, so other questions of the step can be answered alone. Calls of a step that never ran get "Not started" when the user moves on. A run whose signal aborted already, and a run of another user on a thread whose run has not written anything yet, change nothing on the thread.
  - `saveInterruptedReply: false` keeps an aborted run from saving its streamed text, and the voice runner uses it, so an interrupted voice turn keeps only what the caller heard, as before.
  - Resume a checkpoint with the same or a newer version: from this release the turn of a pause on a question lists all its calls, the finished ones in `turn.completed`, and an older version would run those again. The checkpoint stays `version: 1`.
  - `multitaskStrategy` is part of the config schema, so `defineConfig()` and `cogitator.yml` keep it.
  - Approvals are interrupts of `kind: 'approval'` keyed by tool call id: `result.interrupts` lists them, and `responses` decides them as `decisions` does. `decisions`, `defaultDecision` and `pendingApprovals` work as before. `RunCheckpoint` stays `version: 1` with optional `interrupts` and `iterationLimit`, older checkpoints resume as they did.
  - `@cogitator-ai/core` exports `ABORTED_BEFORE_DISPATCH`, `OUTCOME_UNKNOWN`, `repairUnansweredToolCalls()`, `APPROVAL_RESPONSE_SCHEMA` and `isToolInterrupt()` (rethrow it from a `wrapToolCall` middleware that catches tool errors). `@cogitator-ai/types` adds `RunHandle`, `StartOptions`, `QueuedRunMessage`, `MultitaskStrategy`, `RunInterrupt`, `InterruptRequest`, `ToolContext.interrupt` and the error codes `THREAD_BUSY`, `RUN_INTERRUPTED` and `INTERRUPT_EXPIRED`.
  - Server adapters (Express, Fastify, Hono, Koa, Tetsu, Next.js) take `multitaskStrategy` in run, stream and WebSocket run requests and `responses` in resume requests. A paused run that waits on questions of its tools carries them in `interrupts` of the JSON answer, the `finish` event and the WebSocket `complete` event, and its stream sends the new `interrupt-required` event instead of `approval-required`. `@cogitator-ai/server-shared` adds `runRequestRunOptions()`, `MULTITASK_STRATEGIES`, `createInterruptRequiredEvent()`, `toPendingInterrupts()`, `PendingInterrupt` and their schemas, and the OpenAPI document lists the new fields. `useCogitatorChat` keeps `pendingInterrupts`, calls `onInterruptRequired`, and resumes with `resume({ responses })`. With `multitaskStrategy: 'enqueue'` or `'reject'` it no longer aborts the request in flight when a new message is sent, and a refused message shows as an error without touching the running answer. Swarm routes ignore `multitaskStrategy` in every adapter. A stream refused or interrupted this way answers `200` with an `error` event carrying the code, the JSON routes `409` (`410` for `INTERRUPT_EXPIRED`).
  - The Gateway's `queueMode` takes the run strategies too: `enqueue` (the same as `sequential`), `reject` (a message for a busy thread runs nothing, reaches the new `message:rejected` hook, is never handed back to its channel, and makes `injectMessage` reject) and `rollback` (as `interrupt`, then the new message is answered on a branch from where the stopped answer started). Every gateway run names the strategy its queue mode stands for, so the runtime's `multitaskStrategy` never contradicts the queue (`parallel` names none). `sequential`, `parallel`, `interrupt` and `collect` work as before. Cogitator Studio labels pauses on questions and their answers in the thread tree.
  - Pauses on questions of tools never resume without answers anywhere. `pendingQuestions(result)` lists them, and `AgentRunPausedError` carries them in `interrupts`. A workflow `agentNode` fails with it, also with an approval store or `approvals: false`, where it used to resume without an answer forever. Swarm turns and queued workflow jobs fail the same way, and `JobQueue.resumeAgentJob` takes `responses`. The Gateway asks the question in the chat and takes the user's next message as the answer, and the voice runner says it and takes the caller's next turn. A2A tasks wait in `input-required` with an `interrupt-request` part and take the answer back (`A2AClient.answerQuestions()`). MCP servers ask through elicitation. The OpenAI-compatible APIs, Studio and delegated `agentAsTool` runs end with an error that names the questions, and the AI SDK provider warns with them (`providerMetadata.cogitator.pendingQuestions`).
  - `parseAnswer(text, schema)` and `answerFormat(schema)` (`@cogitator-ai/types`) read a typed or spoken answer by the question's schema and say what an answer looks like. `cog.pausedRun(threadId)` lists what a thread waits on, `cog.cancelPause(threadId, { userId, reason })` ends a pause with declined results. The Gateway shows the format with the question, tells a wrong answer in plain words, cancels a question with a cancel word (`approvals.cancelWords`, `cancel` by default) or after `approvals.maxAnswerAttempts` wrong answers (3), ends an expired one, and picks up a question waiting across a restart. The voice runner reads spoken answers the same way. A2A tasks keep their paused run by task, so a new task in the same context no longer answers the wrong run (the older task ends `canceled`), an expired question fails its task and lifts the pause, and text answers are read by the schema. MCP elicitation carries the schema's limits, asks again on a refused answer (3 times at most) and waits `elicitationTimeoutMs` (10 minutes by default) instead of 60 seconds.

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0
  - @cogitator-ai/core@0.64.0

## 0.9.5

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/core@0.63.1

## 0.9.4

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/core@0.63.0

## 0.9.3

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0

## 0.9.2

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1

## 0.9.1

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0

## 0.9.0

### Minor Changes

- [#283](https://github.com/cogitator-ai/Cogitator-AI/pull/283) [`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e) - Voice: phone calls through Twilio Media Streams, G.711 μ-law and a band-limited resampler.

  - `voiceAgent.attachTwilio(server, { authToken, streamUrl, tokens })` serves bidirectional Twilio media streams (`<Connect><Stream>`) on an existing HTTP server, and `handleTwilio(ws, options)` serves one stream on a socket your own server accepted. Every upgrade must carry a valid `X-Twilio-Signature` for the stream URL (with or without a trailing slash, compared in constant time). That signature is the same for every call, so the gate is a one-time token from `TwilioSessionTokens`, passed as a `<Parameter>` and checked on the stream's `start`: it expires, works once and, issued with the webhook's `CallSid`, only for that call. A refused stream, a socket with no `start` within `startTimeout` (10 seconds), a binary frame, malformed JSON or event, or a second `start` closes the stream, and messages are capped at 64 KiB. `twilioStreamTwiml` builds the TwiML with escaped values, the token and an optional `statusCallback`, and `validateTwilioWebhook` checks the voice webhook, form or JSON (`bodySHA256`).
  - In pipeline mode a phone call needs a VAD, since Twilio never says when the caller stopped speaking. The call's μ-law goes to the STT as is when it lists `mulaw` in `streamEncodings` (Deepgram, OpenAI STT), decoded otherwise, and to the VAD decoded and resampled to its `sampleRate`. The TTS is asked for `mulaw` when `rawSampleRates` lists it at 8 kHz (ElevenLabs `ulaw_8000`), else for PCM16 (OpenAI TTS at 24 kHz), transcoded on the way out. In realtime mode the session runs with the new `audioFormat: 'pcmu'`: native `audio/pcmu` with OpenAI Realtime, decoded and resampled to and from Gemini Live.
  - The session marks the audio on the stream and learns from Twilio's echoes what the caller actually heard. In pipeline mode every sentence is marked, a turn ends (`turn_end`) only once its audio was played, a barge-in or an interrupt sends `clear`, and a streamed turn settles with only the sentences that were played, so `createCogitatorRunner` keeps only what the caller heard. In realtime mode the audio is marked every 200 ms, and when the caller speaks the call's audio is cleared and the OpenAI answer truncated (`conversation.item.truncate`) at the last mark played, the items after it at 0, with their audio still arriving dropped. Text sent while a response is active (such as a key press after an interrupt) waits for it to end before the new response is created. A mark whose echo is lost counts as not heard after the duration of its audio plus `markTimeoutMargin`. Key presses come as `dtmf` events and, with `dtmfInput`, as text input that interrupts the answer first. `call_start` reports the call, and `close()` ends every call.
  - Each pipeline session now gets its own VAD: `vad` takes a factory (`() => VADProvider`), and an instance is cloned per session when it has `clone()`, which `EnergyVAD` and `SileroVAD` have (a Silero clone shares the loaded model). Before, all sessions of a `VoiceAgent` shared one VAD, mixing the audio of concurrent sessions. An instance without `clone` is still shared, with a warning. A VAD the session made is freed with the new optional `dispose()` when the session closes. `SileroVAD` handles overlapping `process()` calls one after another, so they no longer share frames or fork the model's state, and loads its model on the first call when `init()` was not called.
  - `PipelineSession` (`createSession`) takes `input` (the format of the pushed audio), `ttsOptions` over the pipeline's own, and a `playback` (`VoicePlayback`) that reports what was played. A session given `input` resamples the audio for a VAD whose `sampleRate` differs. `TwilioMediaStream` is the stream on its own, and `RealtimeSession.truncate(playedMs)` tells the model how much of its audio was heard.
  - Gemini Live sessions emit `speech_start` for new speech of the user: on an interruption while the model generates, and when the model is not generating on the first transcript of a new utterance (after one marked `finished` or a pause of 1.5 seconds), which catches the caller speaking while the last answer still plays. Late transcripts of the utterance being answered do not count.
  - `resample` now filters with a Kaiser-windowed sinc low-pass instead of interpolating linearly, so downsampling no longer aliases. The output length is unchanged, and fractional rates still interpolate linearly. `Resampler` resamples a stream chunk by chunk, `AudioTranscoder` converts between PCM16 and μ-law at any rates, and `linearToMulaw`, `mulawToLinear`, `float32ToMulaw`, `mulawToFloat32`, `pcm16ToMulaw` and `mulawToPcm16` implement G.711 μ-law, bit-exact with the ITU-T G.191 reference.
  - `VoiceAudioFormat` in `@cogitator-ai/types` gains `mulaw`, so an exhaustive `switch` over it needs a new case. ElevenLabs returns it as `ulaw_8000`, and OpenAI TTS refuses it with a clear error. `EnergyVAD.sampleRate` and `SileroVAD.sampleRate` are public, and `WebSocketTransportConfig` takes `maxPayload`.

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/core@0.60.3

## 0.8.3

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/core@0.60.2

## 0.8.2

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/core@0.60.1

## 0.8.1

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0

## 0.8.0

### Minor Changes

- [#269](https://github.com/cogitator-ai/Cogitator-AI/pull/269) [`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698) - Voice replies are spoken while the model generates them, and an interrupted reply leaves only what the user heard in memory

  `VoiceAgentRunner` gains an optional `stream(input, context)` that returns a `VoiceTurn`: an `AsyncIterable<string>` of text deltas that may return the answer as its return value, with an optional, idempotent `settle({ spoken, interrupted })`. `createCogitatorRunner` implements it with `stream: true` and `onToken`. Its stream ends with the final model turn, so the last sentence does not wait for what the run does afterwards, and text the model says before a tool call ends with a line break so it is spoken on its own while the tool runs. A `PipelineSession` with such a runner splits the deltas into sentences and synthesizes them in order through `tts.streamSynthesize`, so the first audio goes out before the answer is complete. The splitter, exported as `SentenceSplitter`, keeps abbreviations, initials after a capitalized word, decimals and list numbers at the start of a line inside their sentence, keeps markdown marks after a stop with it, splits at `?!`, ellipses before a new sentence, CJK full stops and line breaks, flushes a tail without punctuation at the end and cuts a piece longer than `maxSentenceLength` (default 250, at least 20) on whitespace. Sessions emit a new `agent_response_delta` event for each piece of spoken text, forwarded to `VoiceAgent` clients as `{ type: 'agent_response_delta', text }`. `VoicePipeline.process()` returns one buffer and keeps using `run()` with a single `synthesize()` call.

  When a streamed turn stops early (an interruption, a barge-in, closing the session, or a model or TTS error), the session settles it with the sentences whose audio was sent to the client in full. The server cannot know how much of that audio the client played. With `createCogitatorRunner` the thread then holds what was spoken: the answer's assistant message is replaced by its spoken part with `metadata.interrupted: true`, or removed when nothing was spoken, and a run stopped before it saved an answer gets its spoken part saved after its `interrupt` event. A run that fails after saving its answer has that answer replaced too, and its error is reported once the turn was spoken. Text said alongside tool calls stays as the run saved it, and a turn spoken in full leaves the thread exactly as before. The thread is only changed while the turn's last entry is still its active leaf: when another run or your code wrote to the thread meanwhile, it is left as it is, so no newer message is hidden. The runner fixes the thread as soon as the run saved its answer, without waiting for its `afterRun` hooks, settles the turns of one thread one after another and starts a run once the previous run of its thread saved its answer, waiting for the rest of that run at most `tailTimeout` ms (a new `createCogitatorRunner` option, default 10 000), the next streamed turn of a session starts once the previous one settled, and both that wait and `close()` are bounded by `settleTimeout` (default 10 000 ms).

  `bargeIn: true` on `VoicePipeline` or a pipeline-mode `VoiceAgent` lets VAD speech during a reply stop it and start listening, with streaming runners and plain ones. It is off by default, since without echo cancellation on the client the agent's own voice would interrupt it.

  A realtime `VoiceAgent` without `tools` now gives the model the agent's own tools through the runner's new `realtimeTools()`. `createCogitatorRunner` builds them with `createRealtimeTools` and the agent, so each call goes through `cogitator.invokeTool` with the gates a text run of the agent applies: approvals, the guardrails (built with the agent's model unless `guardrails.model` is set), the agent's `wrapToolCall` middleware, the sandbox and `tool.timeout`, with the session's thread id. Unlike a text run, a tool that needs approval is refused unless `agentTools.onApproval` or `guardrails.onToolApproval` approves it (the model reads that it needs approval), and a realtime session sets no `maxIterations`. A runtime without `invokeTool`, such as a custom `CogitatorLike`, gets no tools. `agentTools` passes options, and `agentTools: false` turns it off. Explicit `tools` still win, `tools: []` included. `createRealtimeTools` takes `agent`, a `userId` that can be a function of the call's context, and an `onApproval(request, context)` that also gets the call's session.

  Core: `RunOptions.onMemoryEntry` is called with each entry a run saves to its thread, also for a run that is aborted or fails, before its promise rejects (a failed run now waits for its pending memory writes before it rejects). A throwing or rejecting callback is logged. `invokeTool` takes `agent`: the guardrails are built with its model unless `guardrails.model` is set, as for a run of it, its middleware wraps the call after the Cogitator's, and its id and name name the call. `ToolApprovalRequest` gains optional `agentId`, `threadId` and `userId`, set for `invokeTool` calls.

  Types and memory: `historyMessage(entry)` and `INTERRUPTED_REPLY_NOTE`. An assistant entry with `metadata.interrupted: true` reaches the model with `[interrupted by the user]` after its text, both from plain history and from the context builder, so the model does not take a cut-off reply for a finished one.

  Migration:

  - A pipeline `VoiceAgent` or `PipelineSession` built with `createCogitatorRunner` now streams. TTS is called once per sentence instead of once per answer, and `agent_response` can arrive while the first sentences are already playing. It carries what `run()` returns, the final model turn, as before.
  - A middleware that rewrites a turn's text in `afterModel` without `holdsStream: true` is heard before its rewrite in a streamed voice turn. Set `holdsStream: true` on it to speak only the final text.
  - A realtime `VoiceAgent` built with `createCogitatorRunner` and no `tools` now exposes the agent's tools to the model. Pass `agentTools: false` to keep the old behavior, and `agentTools: { onApproval }` for tools that need approval.
  - `maxSentenceLength` below 20 is rejected.
  - `RealtimeToolsOptions` moved to the package's shared types and is exported from the same place as before.

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0

## 0.7.19

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0

## 0.7.18

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0

## 0.7.17

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3

## 0.7.16

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/core@0.56.2

## 0.7.15

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/core@0.56.1

## 0.7.14

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/core@0.56.0

## 0.7.13

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/core@0.55.0

## 0.7.12

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/core@0.54.0

## 0.7.11

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/core@0.53.0

## 0.7.10

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/core@0.52.0

## 0.7.9

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/core@0.51.0

## 0.7.8

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/core@0.50.0

## 0.7.7

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/core@0.49.0

## 0.7.6

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/core@0.48.0

## 0.7.5

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/core@0.47.0

## 0.7.4

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0

## 0.7.3

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0

## 0.7.2

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0

## 0.7.1

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0

## 0.7.0

### Minor Changes

- [#207](https://github.com/cogitator-ai/Cogitator-AI/pull/207) [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22) - Realtime tools can run through the Cogitator tool invoker. `createRealtimeTools(cogitator, tools, options)` turns Cogitator tools into realtime tools whose calls go through `cogitator.invokeTool`, the way an agent run executes them: arguments checked against the tool's schema, approval asked for calls that need it, the guardrails applied, sandboxed tools run in the sandbox and `tool.timeout` kept. A call that needs approval goes to `options.onApproval`, then to `guardrails.onToolApproval`, and one nobody approves does not run: the model gets an error saying it needs approval. Realtime sessions used to call `execute` directly, so a tool marked `requiresApproval` ran without anyone approving it. The options also set the `agentId`, `userId` and `threadId` (default `voice:<sessionId>`) the tools see.

  `RealtimeTool.execute(args, context)` gets the provider's `callId`, the session's `sessionId` (a `VoiceAgent` sets the client id, a `RealtimeSession` takes `sessionId` in its config) and a `signal` that aborts when the session closes or loses its connection. With Gemini it also aborts when Gemini cancels the call (`toolCallCancellation`, sent when the user interrupts), and the cancelled call gets no answer.

  The voice project of the scaffolder uses `createRealtimeTools`.

  **Migration:** tools written as `execute: async (args) => ...` keep working. Code that calls a `RealtimeTool`'s `execute` itself, such as a test, now passes a context: `{ callId, signal }`.

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0

## 0.6.0

### Minor Changes

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - Realtime sessions read tool results made of parts the way a run does. A `toolContent()` result, or an object with a base64 `image`, used to reach OpenAI as a JSON string with the base64 inside and Gemini as the raw object. Both now get the text of the parts, with images and files described, cut to the tool's `maxResultLength` (100 000 characters by default). Other results are sent as before, except one whose JSON is longer than `maxResultLength`, which is cut the same way (as text, for Gemini).

  `toolImages: true` on `RealtimeSessionConfig` (or `VoiceAgentConfig`) also sends the images to a model that takes them: OpenAI gets a user message with `input_image` parts after the tool outputs (`gpt-realtime`, `gpt-realtime-2`), Gemini gets `inlineData` parts in the function response (Gemini 3 models). Only PNG, JPEG, GIF and WebP images are sent, others stay described. The message of a tool that throws is cut the same way, and a session refuses a tool whose `maxResultLength` is not a positive integer. It is off by default, since not every realtime model takes images.

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0

## 0.5.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/core@0.40.0

## 0.5.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/types@0.41.1

## 0.5.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0

## 0.5.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0

## 0.5.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/types@0.37.0

## 0.5.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `speak_text` returns the synthesized audio as a `file` part of a tool content result instead of `{ audioBase64, format }`. The model sees a one-line description and the application reads the audio from the result, so a spoken answer no longer puts tens of thousands of base64 tokens into the next model call.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0

## 0.4.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0

## 0.4.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0

## 0.4.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2

## 0.4.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/types@0.33.1

## 0.4.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1

## 0.4.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0

## 0.4.2

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/types@0.31.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0

## 0.4.0

### Minor Changes

- c340b6d: Add `ttsOptions` to `VoicePipelineConfig` and `VoiceAgentConfig`. The pipeline called `synthesize`/`streamSynthesize` without options, so formats such as raw `pcm16` audio, or a per-pipeline voice, speed or instructions, could not be requested; the options are now passed to every TTS call.

### Patch Changes

- 0828928: `openai` is an optional peer dependency, but importing `@cogitator-ai/voice` loaded it eagerly, so the package failed to import without it even when only Deepgram, ElevenLabs or realtime providers were used. `OpenAISTT` and `OpenAITTS` now load `openai` on first use and report how to install it when it is missing.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [b8c9eca]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [d35ef2a]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0

## 0.3.4

### Patch Changes

- 0e21115: `verifyClient` may return `false` to reject an upgrade with 401, so an async check such as `async (req) => isValid(req)` type-checks; `true` accepts and `{ code, message }` still rejects with that status.
- Updated dependencies [e211b6a]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/types@0.28.0

## 0.3.3

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/types@0.27.0

## 0.3.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0

## 0.3.1

### Patch Changes

- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0

## 0.3.0

### Minor Changes

- OpenAI STT defaults to `gpt-transcribe`; realtime defaults to `gpt-realtime-2.1-mini` with `gpt-live-transcribe`; the `openai` peer accepts ^6 || ^7.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

## 0.2.0

### Minor Changes

- The OpenAI Realtime adapter still used the beta protocol, which was shut down on 2026-05-12. It now uses the GA interface: `gpt-realtime-mini`, the new `session.update` shape and the new event names. Tool calls are now handled once per completed response, and unknown tools return an error output. The Gemini Live adapter had a default model that only exists on Vertex AI; it is now `gemini-3.8-live`. The API key moved from the URL to a header. It now uses `realtimeInput.audio`/`text`, real input/output transcription (model thoughts are no longer emitted as transcripts), barge-in handling, and an `interrupt()` that no longer drops the next turn. Both providers were verified live against Gemini. Audio/text sent before connect is now queued instead of lost. OpenAISTT failed on every call with its default model because only whisper-1 accepts `verbose_json`; raw PCM is now wrapped into WAV. Deepgram streaming now declares linear16/sample_rate and returns the full utterance instead of only the last segment. SileroVAD accepts any chunk size and supports the v5 model. Pipeline fixes: interrupt race, VAD queue poisoning, `close()` no longer hangs on a stuck agent (abort signal passed to the agent), empty-transcript handling. Transport fixes: header injection in `verifyClient`, `attachToServer` no longer destroys other paths' upgrades, dead peers are terminated, `verifyClient` can be async. VoiceAgent gained control messages (interrupt/end_of_speech/text), realtime instructions and tools, `attach()`, and 1011 close on provider failure; a misbehaving client can no longer crash the server. Added `createCogitatorRunner`; the README Quick Start had passed a core Agent, which has no `run()`. VERSION is read from package.json. Docs site, README and examples updated; examples/package.json was missing `@cogitator-ai/voice`.

  **Breaking changes**
  - OpenAIRealtimeAdapter speaks the GA Realtime protocol (beta was shut down upstream); default model gpt-realtime-mini, default voice marin.
  - GeminiRealtimeAdapter default model is gemini-3.8-live; tool responses are structured { result } / { error } objects instead of JSON strings; text input uses realtimeInput.text.
  - ElevenLabsTTS format 'pcm16' now returns 24kHz PCM (was 16kHz) to match OpenAI.
  - PipelineSession.close()/interrupt() abort the in-flight turn instead of waiting for it; VoiceAgentRunner.run receives a second context argument { sessionId, signal } (backward compatible).
  - VoiceAgent emits 'error' only when a listener is attached; unknown client control messages are reported as errors; WebSocketTransport no longer answers 404 for foreign paths when attached to an external server.
  - OpenAISTT uses response_format 'json' for non-whisper models (no word timestamps/duration there).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.1.13

### Patch Changes

- Comprehensive audit: ~560 bugs fixed across 16 packages

  Second-pass audit of all major packages with deep source review,
  automated fixes, and test updates. Key security fixes include SSRF
  protection (rag, a2a), sandbox escape prevention via worker_threads
  (self-modifying), broken MD5/Ed25519 crypto (wasm-tools), prototype
  chain bypass (server adapters), and MCP input schema validation.
  - memory: 58 fixes (adapters try/catch, embedding retry/timeout, knowledge graph UNION ALL, BM25 inverted index)
  - workflows: ~100 fixes (concurrency enforcement, cancel/abort wiring, cron double-fire race, setTimeout overflow)
  - swarms: ~70 fixes (Redis atomic writes via Lua, pipeline goto guard, approval Promise hang, delegation race)
  - rag: 31 fixes (SSRF protection, PDF splitPages rewrite, recursive chunker offsets, MMR lambda wiring)
  - a2a: 24 fixes (busy-loop fix, HMAC nested fields, SSRF IPv6 bypass, auth enforcement, Redis atomic update)
  - voice: 45 fixes (VAD race serialization, Deepgram timeout, TTS safe body access, SileroVAD dispose)
  - browser: 41 fixes (stealth flags controllable, smartSelect crash, path traversal, screenshot dimensions)
  - neuro-symbolic: 58 fixes (semicolon lexer, PRNG OOB, Ed25519 curve math, extractJSON string-aware, plan repair)
  - self-modifying: 63 fixes (worker_threads sandbox, safety constraints enforced, dead triggers wired, shouldAdopt logic)
  - wasm-tools: 27 fixes (MD5 BigInt padding, CSPRNG keygen, plugin leak, extism API fix, serialization queue)
  - mcp: 17 fixes (per-request transport, Zod raw shape inputSchema, body size limit, callTool all content blocks)
  - server adapters: 26 fixes (Object.hasOwn prototype bypass, error masking, abort signal, CORS credentials)
  - types: allowReverseTraversal, baseUrl, dimensions fields added
  - CI: retired models updated, http.test.ts mocked, TEST_MODEL upgraded to gpt-oss:20b

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/types@0.22.3

## 0.1.12

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.1.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.1.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.1.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.1.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.1.7

### Patch Changes

- fix(voice): audit — 30+ bugs fixed, +15 tests, improved coverage
  - Fixed critical pcmToWav DataView byteOffset bug (corrupted WAV headers)
  - Fixed SileroVAD async process() — ONNX session.run() returns Promise
  - Fixed null-ws send() crash in both realtime adapters
  - Fixed interrupt() flag immediately resetting (TTS continued after interrupt)
  - Fixed ElevenLabs voiceId URL injection security issue
  - Fixed Buffer.buffer shared pool bug in Deepgram STT
  - Fixed Deepgram close() not waiting for WebSocket server
  - Added JSON.parse error handling in realtime adapters
  - Added typed events to PipelineSession
  - Added endAudio() method for no-VAD pipeline mode
  - Replaced unsafe AsyncIterable casts with ReadableStream.getReader()
  - Added 15 new tests (openai-stt: 23 total, pipeline endAudio, deepgram edge cases, realtime error resilience)

## 0.1.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.1.5

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.1.4

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.1.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
