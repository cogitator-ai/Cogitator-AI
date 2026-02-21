# Voice Examples

Voice pipeline, realtime, and agent examples using `@cogitator-ai/voice`.

## Prerequisites

Examples require various API keys depending on the providers used:

```bash
export OPENAI_API_KEY=your-key          # 01, 02
export DEEPGRAM_API_KEY=your-key        # 03
export ELEVENLABS_API_KEY=your-key      # 03
```

## Examples

### 01 — Pipeline Mode

Basic STT → Agent → TTS pipeline. Generates a test tone, transcribes it, runs through an agent, and synthesizes a response.

```bash
npx tsx examples/voice/01-pipeline.ts
```

### 02 — Realtime Session

OpenAI Realtime API session with tool calling. Sends a text message and receives a streamed response.

```bash
npx tsx examples/voice/02-realtime.ts
```

### 03 — Voice Agent (WebSocket)

Full voice agent with Deepgram STT, ElevenLabs TTS, and energy-based VAD. Starts a WebSocket server that clients can connect to for live voice conversations.

```bash
npx tsx examples/voice/03-voice-agent.ts
```
