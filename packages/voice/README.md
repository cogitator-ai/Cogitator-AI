# @cogitator-ai/voice

Voice and Realtime agent capabilities for [Cogitator](https://github.com/cogitator-ai/cogitator).

Two modes: **Pipeline** (STT -> Agent -> TTS) for any LLM, and **Realtime** (native speech-to-speech) for OpenAI/Gemini.

## Installation

```bash
pnpm add @cogitator-ai/voice

# Optional
pnpm add openai                    # OpenAISTT / OpenAITTS
pnpm add @cogitator-ai/core        # Cogitator agents (createCogitatorRunner) and tools (createRealtimeTools)
pnpm add onnxruntime-node          # Silero VAD (neural network-based)
```

`openai` is an optional peer, needed only for `OpenAISTT` and `OpenAITTS`. They load it on first use (constructing them does not), so the package works without it when you use Deepgram, ElevenLabs or the realtime providers; a missing `openai` surfaces as an error with an install hint on the first `transcribe` / `synthesize` call. Deepgram, the realtime sessions and the WebSocket transport use the bundled `ws`; ElevenLabs uses `fetch`.

Full documentation: [cogitator.app/docs/voice](https://cogitator.app/docs/voice).

## Features

- **Pipeline Mode** - STT -> Agent -> TTS, works with any Cogitator agent and LLM backend
- **Streaming Replies** - the answer is spoken sentence by sentence while the model still generates it
- **Spoken-only Memory** - an interrupted reply leaves only what the user heard in the conversation
- **Realtime Mode** - Native speech-to-speech via OpenAI Realtime API or Gemini Live API, with the agent's own tools run through approvals, guardrails and the sandbox
- **2 STT Providers** - OpenAI (gpt-transcribe) and Deepgram (nova-3, real-time streaming)
- **2 TTS Providers** - OpenAI (gpt-4o-mini-tts) and ElevenLabs (eleven_flash_v2_5, ~75ms latency)
- **2 VAD Providers** - Energy-based (zero deps) and Silero (ONNX neural network)
- **WebSocket Transport** - Built-in server for browser/mobile clients
- **Agent Tools** - Drop-in `transcribe_audio` and `speak_text` tools for any Cogitator agent
- **Interruption Handling** - explicit interrupts, opt-in barge-in in pipeline mode (`bargeIn`) and provider VAD in realtime mode
- **Audio Utilities** - PCM/WAV conversion, resampling, RMS calculation

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

`createCogitatorRunner()` adapts a `Cogitator` runtime + `Agent` to the `VoiceAgentRunner` interface (`run(input, { sessionId, signal })` and `stream(input, { sessionId, signal })`). Each voice session gets its own memory thread (`voice:<sessionId>`, override with `createCogitatorRunner(cogitator, agent, { threadId: ({ sessionId }) => ... })`), interrupted turns abort the underlying run, and the reply is spoken while it is generated (see [Streaming replies](#streaming-replies)). Any object with a compatible `run()` works as well.

---

## STT Providers

Docs: [STT providers](https://cogitator.app/docs/voice/stt-providers).

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

Docs: [TTS providers](https://cogitator.app/docs/voice/tts-providers).

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

Docs: [VAD](https://cogitator.app/docs/voice/vad).

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

Neural network-based VAD using the Silero ONNX model (download `silero_vad.onnx` yourself and pass its path). Both the v4 (`h`/`c`) and v5 (`state`) model signatures are supported. `sampleRate` must be `16000` or `8000`; chunks of any size are buffered into 32ms frames (512 samples @ 16kHz, 256 @ 8kHz). Call `init()` before `process()`:

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

The pipeline processes audio through a three-stage loop: STT -> Agent -> TTS. Works with any Cogitator agent regardless of the underlying LLM. Docs: [Pipeline](https://cogitator.app/docs/voice/pipeline).

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

### TTS options

`ttsOptions` is passed to every `synthesize` / `streamSynthesize` call made by the pipeline, its sessions and a pipeline-mode `VoiceAgent`. Use it for the output format or a per-pipeline `voice`, `speed` or `instructions`:

```typescript
const pipeline = new VoicePipeline({
  stt: new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY! }),
  tts: new OpenAITTS({ apiKey: process.env.OPENAI_API_KEY! }),
  agent: myAgent,
  ttsOptions: { format: 'pcm16' },
});
```

Without it the provider defaults apply (MP3 output).

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

const session = pipeline.createSession(); // or createSession({ sessionId }) — passed to the agent's run context

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

### Streaming replies

When the runner has a `stream(input, context)` method, as `createCogitatorRunner()` does, a session speaks the answer while the model is still generating it. The text deltas are split into sentences and each sentence goes to `tts.streamSynthesize` in order, so the first audio leaves before the answer is complete. The splitter knows abbreviations (`Dr.`, `e.g.`), initials after a capitalized word (`J. R. R. Tolkien`, but not `vitamin C.`), decimals (`3.14`), list numbers at the start of a line (`1.`), ellipses, `?!`, markdown marks after a stop (`**Note.**`), CJK full stops and line breaks, flushes a tail without punctuation at the end, and cuts a piece longer than `maxSentenceLength` characters (default 250, at least 20) on whitespace.

```typescript
const pipeline = new VoicePipeline({
  stt,
  tts,
  vad: new EnergyVAD(),
  agent: createCogitatorRunner(cogitator, agent),
  maxSentenceLength: 200,
});

const session = pipeline.createSession();
session.on('agent_response_delta', (delta) => showCaption(delta));
session.on('agent_response', (text) => console.log('Full answer:', text));
```

`agent_response_delta` carries each piece of text that is spoken as it arrives. `agent_response` carries the answer once the model has finished it, the same text `run()` returns: with tools, only the final model turn. It can arrive while the first sentences are still playing. Text the model says before a tool call ("Let me check.") is spoken on its own while the tool runs, and `createCogitatorRunner` ends it with a line break in the deltas for that. The stream ends with the final model turn, so the last sentence does not wait for what the run does after it (`afterRun` hooks, memory notes).

A middleware that rewrites a turn's text in `afterModel` without `holdsStream: true` is heard before the rewrite: the session speaks the text as it streams. Set `holdsStream: true` on such a middleware to speak only the final text.

A runner without `stream` is used exactly as before: `run()` answers, then the whole text is synthesized at once. `VoicePipeline.process()` returns one audio buffer, so it always uses `run()` and a single `synthesize()` call. `SentenceSplitter` is exported for your own streaming code.

A streaming runner returns a `VoiceTurn`: an `AsyncIterable<string>` of deltas that stops when `context.signal` aborts and may return the answer as its return value, with an optional `settle({ spoken, interrupted })` the session calls once the turn is over (calling it again returns the same promise). The next streamed turn of the session starts after the previous one settled, and `close()` waits for it, both at most `settleTimeout` ms (default 10 000): a settle that takes longer goes on in the background.

### Interruption and spoken-only memory

A reply can be cut short by `interrupt()`, the `{ type: 'interrupt' }` control message, `sendText()` during a turn, a barge-in, the session closing, or a model or TTS error. The session then settles the turn with `spoken`: the sentences whose audio was sent to the client in full. A sentence whose audio was only partly sent does not count. The server cannot know how much of the sent audio the client actually played, so a client that buffers a lot of audio should keep its buffer short or send `interrupt` as soon as the user starts talking.

With `createCogitatorRunner()` the thread then holds what the user heard:

- the answer was spoken in full: the thread is exactly what a plain run leaves
- interrupted while speaking: the assistant message holds only the spoken part, with `metadata.interrupted: true`
- interrupted while the model was still generating: the spoken part is saved after the run's `interrupt` event, marked the same way, since the run itself saves no partial answer
- nothing was spoken: no assistant message for the answer

Text the model said alongside tool calls (for example "Let me check") stays as the run saved it, only the final answer is trimmed. A run that fails after it saved its answer has the answer replaced the same way, and its error is reported once the turn was spoken. The model reads an interrupted reply with `[interrupted by the user]` after it, so it does not take the spoken part for a finished answer.

The thread is changed only while the turn's last entry is still its active leaf. When something else wrote to the thread after the turn (another run on the same `threadId`, a message added by your code), the thread is left as it is, with the whole answer, so a newer message is never hidden or moved. The runner settles the turns of one thread one after another. Keeping the thread needs a runtime with `getMemory()`, as a `Cogitator` with `memory` configured has.

### Barge-in

`bargeIn: true` (on `VoicePipeline` or a pipeline-mode `VoiceAgent`) stops the reply when the VAD hears speech while the agent is thinking or speaking, and starts listening to the new utterance right away. The session emits `speech_start`, which tells a client to drop the audio it still has queued. It needs a `vad` and is off by default: without echo cancellation on the client, the agent's own voice coming back through the microphone would interrupt it.

```typescript
const voiceAgent = new VoiceAgent({
  mode: 'pipeline',
  agent: createCogitatorRunner(cogitator, agent),
  stt,
  tts,
  vad: new EnergyVAD(),
  bargeIn: true,
});
```

---

## Realtime Mode

Native speech-to-speech without the STT/TTS pipeline. The LLM directly processes and generates audio. Lower latency, more natural conversation flow. Docs: [Realtime](https://cogitator.app/docs/voice/realtime).

| Provider | Default model           | Input audio      | Output audio     | Notes                                                                                   |
| -------- | ----------------------- | ---------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `openai` | `gpt-realtime-2.1-mini` | PCM16 24kHz mono | PCM16 24kHz mono | Realtime API (GA), server VAD, `marin` voice, `gpt-live-transcribe` input transcription |
| `gemini` | `gemini-3.8-live`       | PCM16 16kHz mono | PCM16 24kHz mono | Gemini Live API, input + output transcriptions                                          |

Audio and text sent before `connect()` resolves are queued and flushed once the session is ready. Tools are executed by the session and their results sent back to the model automatically. `execute(args, context)` gets the provider's `callId`, the session's `sessionId` (the client id in a `VoiceAgent`) and a `signal` that aborts when the session closes or loses its connection, and with Gemini also when Gemini cancels the call because the user talked over it (the 2.5 native audio models do, the 3.x Live models never cancel a call). A cancelled call gets no answer.

### Cogitator tools in a realtime session

A `VoiceAgent` built with `createCogitatorRunner()` gives the realtime model the agent's own tools by default (see [Realtime mode with VoiceAgent](#realtime-mode-with-voiceagent)). For a bare `RealtimeSession`, `createRealtimeTools(cogitator, tools, options)` turns Cogitator tools into realtime tools whose calls run through `cogitator.invokeTool`, the way an agent run executes them: arguments checked against the tool's schema, approval asked for calls that need it, the guardrails applied, sandboxed tools run in the sandbox and `tool.timeout` kept. A call that needs approval goes to `options.onApproval`, then to `guardrails.onToolApproval`, and one nobody approves does not run: the model gets an error saying it needs approval and can tell the user.

```typescript
import { Cogitator, tool } from '@cogitator-ai/core';
import { createRealtimeTools, RealtimeSession } from '@cogitator-ai/voice';
import { z } from 'zod';

const cogitator = new Cogitator();
const unlock = tool({
  name: 'unlock_door',
  description: 'Unlock the door of a room',
  parameters: z.object({ room: z.string() }),
  requiresApproval: true,
  execute: async ({ room }) => ({ unlocked: room }),
});

const session = new RealtimeSession({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  tools: createRealtimeTools(cogitator, [unlock], {
    onApproval: async (request) => ({ approved: await askOperator(request) }),
  }),
});
```

| Option       | Description                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `onApproval` | `(request, context)`: decides calls that need approval, as `RunOptions.onApproval` does in a run  |
| `agent`      | The agent the tools belong to: its model builds the guardrails and its middleware wraps the calls |
| `agentId`    | Agent id the tools see in their context (default `agent.id`, else `'voice'`)                      |
| `threadId`   | Thread id for the tools, from the call context (default `voice:<sessionId>`, as the runner)       |
| `userId`     | The user the calls act for, a string or a function of the call's context                          |

A result made of parts (`toolContent()` from `@cogitator-ai/core`, or an object with a base64 `image`) reaches the model as the text of its parts, with images and files described, instead of a JSON string full of base64. The text, and the message of a tool that throws, is cut to the tool's `maxResultLength` (default 100 000 characters, a positive integer, the session refuses anything else). With `toolImages: true` the session also sends the PNG, JPEG, GIF and WebP images to a model that takes them: OpenAI gets a user message with `input_image` parts after the tool outputs (`gpt-realtime`, `gpt-realtime-2`), Gemini gets `inlineData` parts in the function response (Gemini 3 models). Other results are sent as before, as JSON to OpenAI and as `{ result }` to Gemini, and one whose JSON is longer than `maxResultLength` is cut the same way.

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

When attached to an existing server, upgrade requests for other paths are left untouched for other handlers; a standalone `listen()` server rejects them with `404`. Upgrades beyond `maxConnections` are rejected with `503`. `verifyClient` returning `true` accepts, `false` rejects with `401`, `{ code, message }` rejects with that status, and a throw rejects with `500`.

### WebSocket Protocol

| Direction        | Format      | Content                                                                                                                        |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Client -> Server | Binary      | PCM16 mono 16-bit LE (16kHz for pipeline and Gemini, 24kHz for OpenAI realtime)                                                |
| Client -> Server | Text (JSON) | `{ type: 'interrupt' }`, `{ type: 'end_of_speech' }`, `{ type: 'text', text }`                                                 |
| Server -> Client | Binary      | Response audio (TTS output format in pipeline mode, PCM16 24kHz in realtime mode)                                              |
| Server -> Client | Text (JSON) | `transcript` (`text`, `isFinal` or `role`), `agent_response`, `agent_response_delta`, `speech_start`, `speech_end`, `turn_end` |

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
  agentTools: {
    onApproval: async (request, { sessionId }) => ({
      approved: await askOperator(sessionId, request),
    }),
    userId: ({ sessionId }) => userOfSession(sessionId),
  },
});

await voiceAgent.listen(8080);
```

In realtime mode the agent's `instructions` are used as the session instructions unless `instructions` is set explicitly.

Without `tools`, the model gets the agent's own tools from `agent.realtimeTools()`. This is on by default, so a realtime `VoiceAgent` built with `createCogitatorRunner()` exposes the agent's tools to the model: pass `agentTools: false` to keep the model without tools. A `createCogitatorRunner()` runner builds them with `createRealtimeTools(cogitator, agent.tools, { agent })`, so each call goes through `cogitator.invokeTool` with the agent, the gates a text run of it applies: schema validation, approvals, the guardrails built with the agent's model, the agent's `wrapToolCall` middleware after the Cogitator's, the sandbox and `tool.timeout`, with the agent's id and the session's thread id (`voice:<sessionId>`, or the runner's `threadId` resolver) in the tool context.

What is not the same as a text run:

- a tool with `requiresApproval` runs only when `agentTools.onApproval` or `guardrails.onToolApproval` approves the call, otherwise it is refused and the model reads that it needs approval (there is no run to pause)
- a realtime session sets no `maxIterations`: the model may call tools as often as it likes during the session
- a runtime without `invokeTool` (a custom `CogitatorLike`) gets no tools from the bridge

`agentTools` takes the options of `createRealtimeTools`: `onApproval(request, context)` gets the call's `agentId`, `threadId` and `userId` in the request and its `sessionId` and `callId` in the context, and `userId` is a string or a function of the call's context. Explicit `tools` always win, and `tools: []` gives the model no tools.

---

## Agent Integration

`createCogitatorRunner(cogitator, agent, options?)` connects a Cogitator agent to the voice pipeline and to `VoiceAgent`. Its runner offers:

- `run(input, context)`: a plain run of the agent in the session's thread
- `stream(input, context)`: a run with `stream: true`, yielding the answer's tokens, whose `settle` keeps only the spoken part of an interrupted answer in the thread (see [Interruption and spoken-only memory](#interruption-and-spoken-only-memory))
- `realtimeTools(options)`: the agent's tools as realtime tools, when the runtime has `invokeTool`
- `instructions`: the agent's instructions, for realtime mode

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

`VoiceTool` objects carry Zod parameter schemas, so they can be passed to `tool()` as-is. `transcribeTool(stt)` and `speakTool(tts)` create the tools one at a time. `transcribe_audio` takes `audioBase64` (+ optional `language`), `speak_text` takes `text`, `voice`, `format` and returns a `ToolContentResult` (see `toolContent` in `@cogitator-ai/core`): a line of text for the model and a `file` part with the base64 audio (`mediaType` such as `audio/mpeg`, `filename` such as `speech.mp3`). The model sees only the description, so the audio never fills its context, and your application reads it from the result:

```typescript
await cogitator.run(agent, {
  input: 'Say good morning',
  onToolResult: ({ result }) => {
    const audio = isToolContentResult(result)
      ? result.content.find((part) => part.type === 'file')
      : undefined;
    if (audio) play(Buffer.from(audio.data, 'base64'), audio.mediaType);
  },
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
  detectAudioFormat,
  audioMimeType,
} from '@cogitator-ai/voice';

const pcm = float32ToPcm16(float32Samples);
const floats = pcm16ToFloat32(pcmBuffer);

const wav = pcmToWav(pcmBuffer, 16000);
const { samples, sampleRate } = wavToPcm(wavBuffer);

const resampled = resample(float32Samples, 44100, 16000);

const rms = calculateRMS(float32Samples);

const format = detectAudioFormat(fileBuffer); // 'wav' | 'mp3' | 'ogg' | 'flac' | 'webm' | 'mp4' | null (raw PCM)
if (format) audioMimeType(format); // e.g. 'audio/wav'
```

---

## Configuration Reference

### `VoiceAgentConfig`

| Field               | Type                              | Required      | Description                                                            |
| ------------------- | --------------------------------- | ------------- | ---------------------------------------------------------------------- |
| `agent`             | `VoiceAgentRunner`                | Yes           | `createCogitatorRunner(...)` or any `{ run(input, ctx) }`              |
| `mode`              | `'pipeline' \| 'realtime'`        | Yes           | Processing mode                                                        |
| `stt`               | `STTProvider`                     | Pipeline only | Speech-to-text provider                                                |
| `tts`               | `TTSProvider`                     | Pipeline only | Text-to-speech provider                                                |
| `vad`               | `VADProvider`                     | No            | Voice activity detection                                               |
| `ttsOptions`        | `TTSOptions`                      | No            | Pipeline only: options passed to every TTS call                        |
| `bargeIn`           | `boolean`                         | No            | Pipeline only: user speech stops the reply (default false)             |
| `maxSentenceLength` | `number`                          | No            | Pipeline only: longest streamed piece sent to TTS (250)                |
| `settleTimeout`     | `number`                          | No            | Pipeline only: longest wait in ms for a turn to settle (10 000)        |
| `realtimeProvider`  | `'openai' \| 'gemini'`            | Realtime only | Realtime API provider                                                  |
| `realtimeApiKey`    | `string`                          | Realtime only | API key for realtime provider                                          |
| `realtimeModel`     | `string`                          | No            | Model override                                                         |
| `instructions`      | `string`                          | No            | Realtime instructions (defaults to `agent.instructions`)               |
| `tools`             | `RealtimeTool[]`                  | No            | Realtime tools, replace the agent's own (`[]` for none)                |
| `agentTools`        | `boolean \| RealtimeToolsOptions` | No            | Realtime: the agent's own tools when `tools` is not set (default true) |
| `toolImages`        | `boolean`                         | No            | Realtime: send images tools return to the model                        |
| `voice`             | `string`                          | No            | Voice for realtime                                                     |
| `transport`         | `WebSocketTransportConfig`        | No            | Transport options                                                      |

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

| Field             | Type     | Default | Description                                 |
| ----------------- | -------- | ------- | ------------------------------------------- |
| `modelPath`       | `string` | —       | Path to `silero_vad.onnx` model file        |
| `threshold`       | `number` | `0.5`   | Speech probability threshold (0-1)          |
| `silenceDuration` | `number` | `500`   | Silence duration (ms) before `speech_end`   |
| `sampleRate`      | `number` | `16000` | Audio sample rate in Hz (`16000` or `8000`) |

### `WebSocketTransportConfig`

| Field            | Type                                                    | Default  | Description                                                                                           |
| ---------------- | ------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `path`           | `string`                                                | `/voice` | WebSocket endpoint path                                                                               |
| `maxConnections` | `number`                                                | `100`    | Maximum concurrent connections                                                                        |
| `verifyClient`   | `(req) => boolean \| { code, message } \| Promise<...>` | —        | Authorize upgrades: `false` rejects with 401, `{ code, message }` with that status, throwing with 500 |

---

## Examples

See [`examples/voice/`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/examples/voice) for runnable examples:

- **01-pipeline.ts** — STT -> Cogitator agent -> TTS with `VoicePipeline` and `createCogitatorRunner`
- **02-realtime.ts** — Realtime session with tool calling (Gemini Live or OpenAI Realtime)
- **03-voice-agent.ts** — WebSocket `VoiceAgent` with Deepgram STT, ElevenLabs TTS and EnergyVAD
- **04-realtime-voice-agent.ts** — Realtime `VoiceAgent` (Gemini Live) with a server-side tool and a WebSocket client

---

## License

MIT
