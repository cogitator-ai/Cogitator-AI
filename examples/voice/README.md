# Voice Examples

Voice pipeline, realtime, and agent examples using `@cogitator-ai/voice`.

## Prerequisites

Examples require various API keys depending on the providers used:

```bash
export OPENAI_API_KEY=your-key          # 01 (STT/TTS), 02 (alternative to Gemini)
export GOOGLE_API_KEY=your-key          # 01 (agent), 02, 03 (agent), 04, 05 (agent)
export DEEPGRAM_API_KEY=your-key        # 03, 05
export ELEVENLABS_API_KEY=your-key      # 03, 05 (or OPENAI_API_KEY)
export TWILIO_AUTH_TOKEN=your-token     # 05
export PUBLIC_HOST=abc.ngrok.app        # 05, the public host Twilio reaches
```

## Examples

### 01 — Pipeline Mode

STT → Agent → TTS pipeline with a real Cogitator agent (`createCogitatorRunner`). Synthesizes a spoken question, transcribes it, answers it, and synthesizes the reply.

```bash
npx tsx examples/voice/01-pipeline.ts
```

### 02 — Realtime Session

Realtime speech-to-speech session with tool calling — Gemini Live when `GOOGLE_API_KEY` is set, otherwise the OpenAI Realtime API. Sends a text message and waits for the spoken answer.

```bash
npx tsx examples/voice/02-realtime.ts
```

### 03 — Voice Agent (WebSocket)

Full voice agent with a Cogitator agent, Deepgram STT, ElevenLabs TTS, and energy-based VAD. Starts a WebSocket server that clients can connect to for live voice conversations. The reply is spoken sentence by sentence while the model generates it, and an interrupted reply leaves only what was spoken in the agent's memory.

```bash
npx tsx examples/voice/03-voice-agent.ts
```

### 04 — Realtime Voice Agent (WebSocket)

`VoiceAgent` in realtime mode backed by Gemini Live. The Cogitator agent's own tools reach the model through the default tools bridge (`agentTools`), one of them approved through `onApproval` before it runs. Starts the server, connects a WebSocket client, asks a question via the `text` control message, and prints the transcript of the spoken reply.

```bash
npx tsx examples/voice/04-realtime-voice-agent.ts
```

### 05 - Twilio Phone Agent

A phone agent on one HTTP server: the voice webhook checks Twilio's signature and answers with TwiML that connects the call to a media stream, passing a one-time session token, and `VoiceAgent.attachTwilio` serves the stream (signed upgrade, token checked on `start`). Deepgram takes the call's μ-law natively, the answer is spoken by ElevenLabs in μ-law or by OpenAI TTS transcoded from 24 kHz, a barge-in clears what Twilio still holds, and the agent's memory keeps only what the caller heard. Pressing 0 asks for the opening hours. Expose the port with a tunnel such as ngrok and point your number's voice webhook at `https://PUBLIC_HOST/voice`.

```bash
npx tsx examples/voice/05-twilio-phone-agent.ts
```
