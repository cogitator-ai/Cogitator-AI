# @cogitator-ai/voice

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
