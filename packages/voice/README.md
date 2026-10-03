# @cogitator-ai/voice

Voice and Realtime agent capabilities for [Cogitator](https://github.com/cogitator-ai/cogitator).

Two modes: **Pipeline** (STT -> Agent -> TTS) for any LLM, and **Realtime** (native speech-to-speech) for OpenAI/Gemini.

## Installation

```bash
pnpm add @cogitator-ai/voice

# Required for OpenAI STT/TTS
pnpm add openai

# Optional dependencies
pnpm add onnxruntime-node  # Silero VAD (neural network-based)
```

## Features

- **Pipeline Mode** — STT -> Agent -> TTS, works with any Cogitator agent and LLM backend
- **Realtime Mode** — Native speech-to-speech via OpenAI Realtime API or Gemini Live API
- **2 STT Providers** — OpenAI (gpt-transcribe) and Deepgram (nova-3, real-time streaming)
- **2 TTS Providers** — OpenAI (gpt-4o-mini-tts) and ElevenLabs (eleven_flash_v2_5, ~75ms latency)
- **2 VAD Providers** — Energy-based (zero deps) and Silero (ONNX neural network)
- **WebSocket Transport** — Built-in server for browser/mobile clients
- **Agent Tools** — Drop-in `transcribe_audio` and `speak_text` tools for any Cogitator agent
- **Interruption Handling** — Barge-in support in both pipeline and realtime modes
- **Audio Utilities** — PCM/WAV conversion, resampling, RMS calculation

---

## Quick Start

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import {
  VoiceAgent,
  OpenAISTT,
  OpenAITTS,
  EnergyVAD,
  createCogitatorRunner,
} from '@cogitator-ai/voice';

const cogitator = new Cogitator({ memory: { adapter: 'memory' } });
const agent = new Agent({
  name: 'assistant',
  model: 'openai/gpt-6-luna',
  instructions: 'You are a helpful voice assistant. Keep answers short.',
});

const voiceAgent = new VoiceAgent({
  mode: 'pipeline',
  agent: createCogitatorRunner(cogitator, agent),
  stt: new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY! }),
  tts: new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY! }),
  vad: new EnergyVAD(),
});

await voiceAgent.listen(8080);
```

Connect from any WebSocket client at `ws://localhost:8080/voice` — send binary PCM16 frames, receive binary audio + JSON events (see [WebSocket Protocol](#websocket-protocol)).

`createCogitatorRunner()` adapts a `Cogitator` runtime + `Agent` to the `VoiceAgentRunner` interface (`run(input, { sessionId, signal })`). Each voice session gets its own memory thread (`voice:<sessionId>`), and interrupted turns abort the underlying run. Any object with a compatible `run()` works as well.

---

## STT Providers

| Provider      | Default Model    | Streaming           | Word Timestamps  | Notes                                                                    |
| ------------- | ---------------- | ------------------- | ---------------- | ------------------------------------------------------------------------ |
| `OpenAISTT`   | `gpt-transcribe` | Buffered            | `whisper-1` only | Also supports `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1` |
| `DeepgramSTT` | `nova-3`         | Real-time WebSocket | Yes              | Interim results, endpointing, auto-punctuation                           |

Both providers accept containerized audio (wav, mp3, ogg, flac, webm, mp4 — detected from magic bytes) or headerless PCM16 mono. Streams (`createStream()`) expect raw PCM16 at `sampleRate` (default 16kHz).

### OpenAI STT

```typescript
import { OpenAISTT } from '@cogitator-ai/voice';

const stt = new OpenAISTT({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-transcribe',
});

const result = await stt.transcribe(audioBuffer, { language: 'en' });
console.log(result.text);

const whisper = new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY!, model: 'whisper-1' });
const detailed = await whisper.transcribe(audioBuffer);
console.log(detailed.words, detailed.duration);
```

### Deepgram STT

Real-time streaming with interim results. `close()` resolves with the full utterance (all final segments joined):

```typescript
import { DeepgramSTT } from '@cogitator-ai/voice';

const stt = new DeepgramSTT({
  apiKey: process.env.DEEPGRAM_API_KEY!,
  model: 'nova-3',
  language: 'en',
  sampleRate: 16000,
});

const stream = stt.createStream({ interimResults: true, endpointing: 500 });

stream.on('partial', (text) => {
  console.log('partial:', text);
});

stream.on('final', (result) => {
  console.log('final:', result.text);
});

stream.write(pcm16Chunk1);
stream.write(pcm16Chunk2);
const { text } = await stream.close();
```

---

## TTS Providers

| Provider        | Default Model       | Streaming | Voices                                                                                 | Notes                                                                                   |
| --------------- | ------------------- | --------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `OpenAITTS`     | `gpt-4o-mini-tts`   | Yes       | alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin, cedar | Also supports `tts-1`, `tts-1-hd`. Supports `instructions` for voice style control      |
| `ElevenLabsTTS` | `eleven_flash_v2_5` | Yes       | By voice ID                                                                            | ~75ms latency. Also supports `eleven_turbo_v2_5`, `eleven_multilingual_v2`, `eleven_v3` |

Default output is MP3. `format: 'pcm16'` returns raw PCM16 mono at **24kHz** for both providers. ElevenLabs supports `speed` (0.7–1.2) but not `wav`/`aac` output.

### OpenAI TTS

```typescript
import { OpenAITTS } from '@cogitator-ai/voice';

const tts = new OpenAITTS({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini-tts',
  voice: 'coral',
});

const audio = await tts.synthesize('Hello, world!', {
  speed: 1.0,
  format: 'mp3',
  instructions: 'Speak in a warm, friendly tone',
});

for await (const chunk of tts.streamSynthesize('Streaming response...')) {
  process.stdout.write('.');
}
```

### ElevenLabs TTS

```typescript
import { ElevenLabsTTS } from '@cogitator-ai/voice';

const tts = new ElevenLabsTTS({
  apiKey: process.env.ELEVENLABS_API_KEY!,
  model: 'eleven_flash_v2_5',
  voiceId: '21m00Tcm4TlvDq8ikWAM',
});

const audio = await tts.synthesize('Hello!', { format: 'mp3' });

for await (const chunk of tts.streamSynthesize('Streaming...')) {
  process.stdout.write('.');
}
```

---

## VAD Providers

| Provider    | Accuracy | Dependencies       | Speed      | Notes                                             |
| ----------- | -------- | ------------------ | ---------- | ------------------------------------------------- |
| `EnergyVAD` | Basic    | None               | Fast       | RMS energy threshold, good for quiet environments |
| `SileroVAD` | High     | `onnxruntime-node` | ~3ms/frame | Neural network, works in noisy environments       |

### Energy VAD

Zero-dependency voice activity detection based on audio energy levels:

```typescript
import { EnergyVAD } from '@cogitator-ai/voice';

const vad = new EnergyVAD({
  threshold: 0.01,
  silenceDuration: 500,
  sampleRate: 16000,
});

const event = vad.process(float32Samples);

switch (event.type) {
  case 'speech_start':
    console.log('User started speaking');
    break;
  case 'speech_end':
    console.log(`Speech ended after ${event.duration}ms`);
    break;
  case 'speech':
    console.log(`Speech probability: ${event.probability}`);
    break;
  case 'silence':
    break;
}
```

### Silero VAD

Neural network-based VAD using the Silero ONNX model. Both the v4 (`h`/`c`) and v5 (`state`) model signatures are supported. Chunks of any size are buffered into 32ms frames (512 samples @ 16kHz, 256 @ 8kHz):

```typescript
import { SileroVAD } from '@cogitator-ai/voice';

const vad = new SileroVAD({
  modelPath: './silero_vad.onnx',
  threshold: 0.5,
  silenceDuration: 500,
  sampleRate: 16000,
});

await vad.init();

const event = await vad.process(float32Samples);
```

---

## Pipeline Mode

The pipeline processes audio through a three-stage loop: STT -> Agent -> TTS. Works with any Cogitator agent regardless of the underlying LLM.

### One-shot processing

```typescript
import { VoicePipeline, OpenAISTT, OpenAITTS } from '@cogitator-ai/voice';

const pipeline = new VoicePipeline({
  stt: new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY! }),
  tts: new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY! }),
  agent: myAgent,
});

const result = await pipeline.process(audioBuffer);
console.log(result.transcript);
console.log(result.response);
// result.audio — synthesized response audio
```

### Streaming sessions

For continuous conversations with VAD-driven turn detection:

```typescript
import { VoicePipeline, OpenAISTT, OpenAITTS, EnergyVAD } from '@cogitator-ai/voice';

const pipeline = new VoicePipeline({
  stt: new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY! }),
  tts: new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY! }),
  vad: new EnergyVAD({ threshold: 0.01, silenceDuration: 500 }),
  agent: myAgent,
});

const session = pipeline.createSession();

session.on('speech_start', () => {
  console.log('User started speaking');
});

session.on('transcript', (text, isFinal) => {
  console.log(isFinal ? `Final: ${text}` : `Interim: ${text}`);
});

session.on('agent_response', (text) => {
  console.log('Agent:', text);
});

session.on('audio', (chunk) => {
  playAudio(chunk);
});

session.on('turn_end', () => {
  console.log('Agent finished speaking');
});

session.pushAudio(pcm16Chunk);
session.endAudio();

await session.sendText('Skip STT and answer this');

session.interrupt();

await session.close();
```

Without a VAD, audio is buffered until `endAudio()`. `interrupt()` cancels the in-flight turn (the agent receives an aborted `signal`), and `close()` returns without waiting for hung providers. Empty transcripts never reach the agent.

---

## Realtime Mode

Native speech-to-speech without the STT/TTS pipeline. The LLM directly processes and generates audio. Lower latency, more natural conversation flow.

| Provider | Default model           | Input audio      | Output audio     | Notes                                                                                   |
| -------- | ----------------------- | ---------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `openai` | `gpt-realtime-2.1-mini` | PCM16 24kHz mono | PCM16 24kHz mono | Realtime API (GA), server VAD, `marin` voice, `gpt-live-transcribe` input transcription |
| `gemini` | `gemini-3.8-live`       | PCM16 16kHz mono | PCM16 24kHz mono | Gemini Live API, input + output transcriptions                                          |

Audio and text sent before `connect()` resolves are queued and flushed once the session is ready. Tools are executed by the session and their results sent back to the model automatically.

### OpenAI Realtime

```typescript
import { RealtimeSession } from '@cogitator-ai/voice';

const session = new RealtimeSession({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions: 'You are a helpful assistant.',
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      execute: async (args) => ({ temp: 72, unit: 'F' }),
    },
  ],
});

session.on('connected', () => console.log('Connected'));
session.on('audio', (chunk) => playAudio(chunk));
session.on('transcript', (text, role) => console.log(`${role}: ${text}`));
session.on('speech_start', () => console.log('VAD: speech detected'));
session.on('tool_call', (name, args) => console.log(`Tool: ${name}`, args));

await session.connect();

session.pushAudio(pcm16Chunk);
session.sendText('Hello!');

session.interrupt();
session.close();
```

### Gemini Live

```typescript
import { RealtimeSession } from '@cogitator-ai/voice';

const session = new RealtimeSession({
  provider: 'gemini',
  apiKey: process.env.GOOGLE_API_KEY!,
  model: 'gemini-3.8-live',
  voice: 'Puck',
  instructions: 'You are a helpful assistant.',
});

session.on('audio', (chunk) => playAudio(chunk));
session.on('transcript', (text, role) => console.log(`${role}: ${text}`));

await session.connect();
session.pushAudio(pcm16Chunk);
```

---

## WebSocket Transport

Built-in WebSocket server for connecting browser/mobile clients. Binary frames carry audio, text frames carry JSON control messages.

```typescript
import { WebSocketTransport, VoiceClient } from '@cogitator-ai/voice';

const transport = new WebSocketTransport({
  path: '/voice',
  maxConnections: 100,
  verifyClient: async (req) => isValidToken(req.headers.authorization), // false rejects with 401
});

transport.on('connection', (client: VoiceClient) => {
  console.log(`Client connected: ${client.id}`);

  client.on('audio', (chunk) => {
    // PCM16 audio from client
  });

  client.on('message', (msg) => {
    // JSON control messages
  });

  client.on('close', () => {
    console.log(`Client disconnected: ${client.id}`);
  });

  client.sendAudio(responseChunk);
  client.sendMessage({ type: 'transcript', text: 'Hello' });
});

await transport.listen(8080);

// or attach to an existing HTTP server
transport.attachToServer(httpServer);

await transport.close();
```

When attached to an existing server, upgrade requests for other paths are left untouched for other handlers; a standalone `listen()` server rejects them with `404`.

### WebSocket Protocol

| Direction        | Format      | Content                                                                                                |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| Client -> Server | Binary      | PCM16 mono 16-bit LE (16kHz for pipeline and Gemini, 24kHz for OpenAI realtime)                        |
| Client -> Server | Text (JSON) | `{ type: 'interrupt' }`, `{ type: 'end_of_speech' }`, `{ type: 'text', text }`                         |
| Server -> Client | Binary      | Response audio (TTS output format in pipeline mode, PCM16 24kHz in realtime mode)                      |
| Server -> Client | Text (JSON) | `transcript` (`text`, `isFinal` or `role`), `agent_response`, `speech_start`, `speech_end`, `turn_end` |

`end_of_speech` commits buffered audio when no VAD is configured (pipeline mode). `interrupt` cancels the current turn. `text` runs a turn from text input in both modes. Unknown control message types are reported through the `error` event. If the realtime provider cannot be reached or disconnects, the client is closed with code `1011`.

---

## VoiceAgent

High-level class that wires together transport, pipeline/realtime, and session management:

```typescript
import { VoiceAgent, OpenAISTT, OpenAITTS, EnergyVAD } from '@cogitator-ai/voice';

const voiceAgent = new VoiceAgent({
  agent: myAgent,
  mode: 'pipeline',
  stt: new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY! }),
  tts: new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY! }),
  vad: new EnergyVAD(),
  transport: { path: '/voice', maxConnections: 50 },
});

voiceAgent.on('session_start', (id) => console.log(`Session started: ${id}`));
voiceAgent.on('session_end', (id) => console.log(`Session ended: ${id}`));
voiceAgent.on('error', (err) => console.error(err));

console.log(`Active sessions: ${voiceAgent.activeSessions}`);

await voiceAgent.listen(8080);
// or share an existing HTTP server: voiceAgent.attach(httpServer);
await voiceAgent.close();
```

Attach an `error` listener to observe provider and client errors; without one, errors are not thrown (a misbehaving client cannot crash the server).

### Realtime mode with VoiceAgent

```typescript
const voiceAgent = new VoiceAgent({
  agent: createCogitatorRunner(cogitator, agent),
  mode: 'realtime',
  realtimeProvider: 'gemini',
  realtimeApiKey: process.env.GOOGLE_API_KEY!,
  voice: 'Puck',
  tools: [
    {
      name: 'get_time',
      description: 'Current server time',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ time: new Date().toISOString() }),
    },
  ],
});

await voiceAgent.listen(8080);
```

In realtime mode the agent's `instructions` are used as the session instructions unless `instructions` is set explicitly.

---

## Agent Integration

Give any Cogitator agent the ability to transcribe audio or synthesize speech:

```typescript
import { Agent, tool } from '@cogitator-ai/core';
import { voiceTools, OpenAISTT, OpenAITTS } from '@cogitator-ai/voice';

const [transcribe, speak] = voiceTools({
  stt: new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY! }),
  tts: new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY! }),
});

const agent = new Agent({
  name: 'voice-assistant',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You can transcribe audio and generate speech.',
  tools: [tool(transcribe), tool(speak)],
});
```

`VoiceTool` objects carry Zod parameter schemas, so they can be passed to `tool()` as-is.

---

## Audio Utilities

Low-level audio conversion functions for working with PCM and WAV data:

```typescript
import {
  float32ToPcm16,
  pcm16ToFloat32,
  pcmToWav,
  wavToPcm,
  resample,
  calculateRMS,
  detectAudioFormat,
} from '@cogitator-ai/voice';

const pcm = float32ToPcm16(float32Samples);
const floats = pcm16ToFloat32(pcmBuffer);

const wav = pcmToWav(pcmBuffer, 16000);
const { samples, sampleRate } = wavToPcm(wavBuffer);

const resampled = resample(float32Samples, 44100, 16000);

const rms = calculateRMS(float32Samples);

detectAudioFormat(fileBuffer); // 'wav' | 'mp3' | 'ogg' | 'flac' | 'webm' | 'mp4' | null (raw PCM)
```

---

## Configuration Reference

### `VoiceAgentConfig`

| Field              | Type                       | Required      | Description                                               |
| ------------------ | -------------------------- | ------------- | --------------------------------------------------------- |
| `agent`            | `VoiceAgentRunner`         | Yes           | `createCogitatorRunner(...)` or any `{ run(input, ctx) }` |
| `mode`             | `'pipeline' \| 'realtime'` | Yes           | Processing mode                                           |
| `stt`              | `STTProvider`              | Pipeline only | Speech-to-text provider                                   |
| `tts`              | `TTSProvider`              | Pipeline only | Text-to-speech provider                                   |
| `vad`              | `VADProvider`              | No            | Voice activity detection                                  |
| `realtimeProvider` | `'openai' \| 'gemini'`     | Realtime only | Realtime API provider                                     |
| `realtimeApiKey`   | `string`                   | Realtime only | API key for realtime provider                             |
| `realtimeModel`    | `string`                   | No            | Model override                                            |
| `instructions`     | `string`                   | No            | Realtime instructions (defaults to `agent.instructions`)  |
| `tools`            | `RealtimeTool[]`           | No            | Realtime tools executed by the session                    |
| `voice`            | `string`                   | No            | Voice for realtime                                        |
| `transport`        | `WebSocketTransportConfig` | No            | Transport options                                         |

### `OpenAISTTConfig`

| Field     | Type     | Default          | Description         |
| --------- | -------- | ---------------- | ------------------- |
| `apiKey`  | `string` | —                | OpenAI API key      |
| `model`   | `string` | `gpt-transcribe` | Model ID            |
| `baseURL` | `string` | —                | Custom API base URL |

### `DeepgramSTTConfig`

| Field        | Type     | Default  | Description                                    |
| ------------ | -------- | -------- | ---------------------------------------------- |
| `apiKey`     | `string` | —        | Deepgram API key                               |
| `model`      | `string` | `nova-3` | Model ID                                       |
| `language`   | `string` | —        | Default language code                          |
| `sampleRate` | `number` | `16000`  | Sample rate of raw PCM16 (streams, headerless) |

### `OpenAITTSConfig`

| Field     | Type     | Default           | Description         |
| --------- | -------- | ----------------- | ------------------- |
| `apiKey`  | `string` | —                 | OpenAI API key      |
| `model`   | `string` | `gpt-4o-mini-tts` | Model ID            |
| `voice`   | `string` | `alloy`           | Default voice       |
| `baseURL` | `string` | —                 | Custom API base URL |

### `ElevenLabsTTSConfig`

| Field     | Type     | Default                | Description        |
| --------- | -------- | ---------------------- | ------------------ |
| `apiKey`  | `string` | —                      | ElevenLabs API key |
| `voiceId` | `string` | `21m00Tcm4TlvDq8ikWAM` | Default voice ID   |
| `model`   | `string` | `eleven_flash_v2_5`    | Model ID           |

### `EnergyVADConfig`

| Field             | Type     | Default | Description                               |
| ----------------- | -------- | ------- | ----------------------------------------- |
| `threshold`       | `number` | `0.01`  | RMS energy threshold for speech detection |
| `silenceDuration` | `number` | `500`   | Silence duration (ms) before `speech_end` |
| `sampleRate`      | `number` | `16000` | Audio sample rate in Hz                   |

### `SileroVADConfig`

| Field             | Type     | Default | Description                               |
| ----------------- | -------- | ------- | ----------------------------------------- |
| `modelPath`       | `string` | —       | Path to `silero_vad.onnx` model file      |
| `threshold`       | `number` | `0.5`   | Speech probability threshold (0-1)        |
| `silenceDuration` | `number` | `500`   | Silence duration (ms) before `speech_end` |
| `sampleRate`      | `number` | `16000` | Audio sample rate in Hz                   |

### `WebSocketTransportConfig`

| Field            | Type                                                    | Default  | Description                                                                                           |
| ---------------- | ------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `path`           | `string`                                                | `/voice` | WebSocket endpoint path                                                                               |
| `maxConnections` | `number`                                                | `100`    | Maximum concurrent connections                                                                        |
| `verifyClient`   | `(req) => boolean \| { code, message } \| Promise<...>` | —        | Authorize upgrades: `false` rejects with 401, `{ code, message }` with that status, throwing with 500 |

---

## Examples

See [`examples/voice/`](../../examples/voice/) for runnable examples:

- **01-pipeline.ts** — STT -> Cogitator agent -> TTS with `VoicePipeline` and `createCogitatorRunner`
- **02-realtime.ts** — Realtime session with tool calling (Gemini Live or OpenAI Realtime)
- **03-voice-agent.ts** — WebSocket `VoiceAgent` with Deepgram STT, ElevenLabs TTS and EnergyVAD
- **04-realtime-voice-agent.ts** — Realtime `VoiceAgent` (Gemini Live) with a server-side tool and a WebSocket client

---

## License

MIT
