# @cogitator-ai/voice

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
