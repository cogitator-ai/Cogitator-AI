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
- **2 STT Providers** — OpenAI (gpt-4o-mini-transcribe) and Deepgram (nova-3, real-time streaming)
- **2 TTS Providers** — OpenAI (gpt-4o-mini-tts) and ElevenLabs (eleven_flash_v2_5, ~75ms latency)
- **2 VAD Providers** — Energy-based (zero deps) and Silero (ONNX neural network)
- **WebSocket Transport** — Built-in server for browser/mobile clients
- **Agent Tools** — Drop-in `transcribe_audio` and `speak_text` tools for any Cogitator agent
- **Interruption Handling** — Barge-in support in both pipeline and realtime modes
- **Audio Utilities** — PCM/WAV conversion, resampling, RMS calculation

---

## Quick Start

```typescript
import { VoiceAgent, OpenAISTT, OpenAITTS } from '@cogitator-ai/voice';
import { Agent } from '@cogitator-ai/core';

const agent = new Agent({ instructions: 'You are a helpful assistant' });

const voiceAgent = new VoiceAgent({
  agent,
  mode: 'pipeline',
  stt: new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY! }),
  tts: new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY! }),
});

await voiceAgent.listen(8080);
```

Connect from any WebSocket client at `ws://localhost:8080/voice` — send binary audio frames, receive binary audio + JSON control messages.

---

## STT Providers

| Provider      | Default Model            | Streaming           | Word Timestamps | Notes                                          |
| ------------- | ------------------------ | ------------------- | --------------- | ---------------------------------------------- |
| `OpenAISTT`   | `gpt-4o-mini-transcribe` | Buffered            | Yes             | Also supports `gpt-4o-transcribe`, `whisper-1` |
| `DeepgramSTT` | `nova-3`                 | Real-time WebSocket | Yes             | Interim results, endpointing, auto-punctuation |

### OpenAI STT

```typescript
import { OpenAISTT } from '@cogitator-ai/voice';

const stt = new OpenAISTT({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini-transcribe',
});

const result = await stt.transcribe(audioBuffer, { language: 'en' });
console.log(result.text);
console.log(result.words);
console.log(result.duration);
```

### Deepgram STT

Real-time streaming with interim results:

```typescript
import { DeepgramSTT } from '@cogitator-ai/voice';

const stt = new DeepgramSTT({
  apiKey: process.env.DEEPGRAM_API_KEY!,
  model: 'nova-3',
  language: 'en',
});

const stream = stt.createStream({ interimResults: true, endpointing: 500 });

stream.on('partial', (text) => {
  console.log('partial:', text);
});

stream.on('final', (result) => {
  console.log('final:', result.text);
});

stream.write(audioChunk1);
stream.write(audioChunk2);
await stream.close();
```

---

## TTS Providers

| Provider        | Default Model       | Streaming | Voices                                                                                 | Notes                                                                                   |
| --------------- | ------------------- | --------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `OpenAITTS`     | `gpt-4o-mini-tts`   | Yes       | alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin, cedar | Also supports `tts-1`, `tts-1-hd`. Supports `instructions` for voice style control      |
| `ElevenLabsTTS` | `eleven_flash_v2_5` | Yes       | By voice ID                                                                            | ~75ms latency. Also supports `eleven_turbo_v2_5`, `eleven_multilingual_v2`, `eleven_v3` |

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

Neural network-based VAD using the Silero ONNX model:

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

session.pushAudio(pcm16Chunk);

session.interrupt();

await session.close();
```

---

## Realtime Mode

Native speech-to-speech without the STT/TTS pipeline. The LLM directly processes and generates audio. Lower latency, more natural conversation flow.

### OpenAI Realtime

```typescript
import { RealtimeSession } from '@cogitator-ai/voice';

const session = new RealtimeSession({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini-realtime-preview',
  voice: 'coral',
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
  model: 'gemini-live-2.5-flash-native-audio',
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

### WebSocket Protocol

| Direction        | Format      | Content                                                                             |
| ---------------- | ----------- | ----------------------------------------------------------------------------------- |
| Client -> Server | Binary      | PCM16 audio frames (16kHz, mono, 16-bit LE)                                         |
| Client -> Server | Text (JSON) | Control messages                                                                    |
| Server -> Client | Binary      | PCM16 or encoded audio response                                                     |
| Server -> Client | Text (JSON) | `{ type: 'transcript' \| 'agent_response' \| 'speech_start' \| 'speech_end', ... }` |

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
await voiceAgent.close();
```

### Realtime mode with VoiceAgent

```typescript
const voiceAgent = new VoiceAgent({
  agent: myAgent,
  mode: 'realtime',
  realtimeProvider: 'openai',
  realtimeApiKey: process.env.OPENAI_API_KEY!,
  realtimeModel: 'gpt-4o-mini-realtime-preview',
  voice: 'coral',
});

await voiceAgent.listen(8080);
```

---

## Agent Integration

Give any Cogitator agent the ability to transcribe audio or synthesize speech:

```typescript
import { Agent, tool } from '@cogitator-ai/core';
import { voiceTools, OpenAISTT, OpenAITTS } from '@cogitator-ai/voice';
import { z } from 'zod';

const [transcribe, speak] = voiceTools({
  stt: new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY! }),
  tts: new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY! }),
});

const transcribeTool = tool({
  name: transcribe.name,
  description: transcribe.description,
  parameters: z.object({
    audioBase64: z.string().describe('Base64-encoded audio data'),
    language: z.string().optional().describe('Language code'),
  }),
  execute: async (params) => transcribe.execute(params),
});

const speakTool = tool({
  name: speak.name,
  description: speak.description,
  parameters: z.object({
    text: z.string().describe('Text to convert to speech'),
    voice: z.string().optional().describe('Voice to use'),
  }),
  execute: async (params) => speak.execute(params),
});

const agent = new Agent({
  name: 'voice-assistant',
  model: 'gpt-4o',
  instructions: 'You can transcribe audio and generate speech.',
  tools: [transcribeTool, speakTool],
});
```

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
} from '@cogitator-ai/voice';

const pcm = float32ToPcm16(float32Samples);
const floats = pcm16ToFloat32(pcmBuffer);

const wav = pcmToWav(pcmBuffer, 16000);
const { samples, sampleRate } = wavToPcm(wavBuffer);

const resampled = resample(float32Samples, 44100, 16000);

const rms = calculateRMS(float32Samples);
```

---

## Configuration Reference

### `VoiceAgentConfig`

| Field              | Type                                     | Required      | Description                          |
| ------------------ | ---------------------------------------- | ------------- | ------------------------------------ |
| `agent`            | `{ run(input) => Promise<{ content }> }` | Yes           | Cogitator agent or compatible object |
| `mode`             | `'pipeline' \| 'realtime'`               | Yes           | Processing mode                      |
| `stt`              | `STTProvider`                            | Pipeline only | Speech-to-text provider              |
| `tts`              | `TTSProvider`                            | Pipeline only | Text-to-speech provider              |
| `vad`              | `VADProvider`                            | No            | Voice activity detection             |
| `realtimeProvider` | `'openai' \| 'gemini'`                   | Realtime only | Realtime API provider                |
| `realtimeApiKey`   | `string`                                 | Realtime only | API key for realtime provider        |
| `realtimeModel`    | `string`                                 | No            | Model override                       |
| `voice`            | `string`                                 | No            | Voice for TTS or realtime            |
| `transport`        | `WebSocketTransportConfig`               | No            | Transport options                    |

### `OpenAISTTConfig`

| Field     | Type     | Default                  | Description         |
| --------- | -------- | ------------------------ | ------------------- |
| `apiKey`  | `string` | —                        | OpenAI API key      |
| `model`   | `string` | `gpt-4o-mini-transcribe` | Model ID            |
| `baseURL` | `string` | —                        | Custom API base URL |

### `DeepgramSTTConfig`

| Field      | Type     | Default  | Description           |
| ---------- | -------- | -------- | --------------------- |
| `apiKey`   | `string` | —        | Deepgram API key      |
| `model`    | `string` | `nova-3` | Model ID              |
| `language` | `string` | —        | Default language code |

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

| Field            | Type     | Default  | Description                    |
| ---------------- | -------- | -------- | ------------------------------ |
| `path`           | `string` | `/voice` | WebSocket endpoint path        |
| `maxConnections` | `number` | `100`    | Maximum concurrent connections |

---

## Examples

See [`examples/voice/`](../../examples/voice/) for runnable examples:

- **01-pipeline-basic.ts** — Basic pipeline with OpenAI STT + TTS
- **02-realtime-openai.ts** — OpenAI Realtime API voice agent
- **03-realtime-gemini.ts** — Gemini Live voice agent

---

## License

MIT
