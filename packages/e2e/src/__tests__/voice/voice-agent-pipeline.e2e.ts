import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { Cogitator, Agent } from '@cogitator-ai/core';
import {
  VoiceAgent,
  EnergyVAD,
  createCogitatorRunner,
  float32ToPcm16,
  type STTProvider,
  type STTStream,
  type TTSProvider,
  type TranscribeResult,
  type VoiceAgentRunner,
} from '@cogitator-ai/voice';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const USE_OLLAMA = process.env.TEST_OLLAMA === 'true';
const TEST_MODEL = process.env.TEST_MODEL || 'gpt-oss:20b';

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 320;

class ScriptedSTTStream extends EventEmitter implements STTStream {
  private bytes = 0;
  constructor(private readonly transcript: string) {
    super();
  }
  write(chunk: Buffer): void {
    this.bytes += chunk.length;
    this.emit('partial', this.transcript.slice(0, 5));
  }
  async close(): Promise<TranscribeResult> {
    const result: TranscribeResult = {
      text: this.bytes > 0 ? this.transcript : '',
      duration: this.bytes / 2 / SAMPLE_RATE,
    };
    this.emit('final', result);
    return result;
  }
}

function scriptedSTT(transcript: string): STTProvider {
  return {
    name: 'scripted',
    transcribe: async () => ({ text: transcript }),
    createStream: () => new ScriptedSTTStream(transcript),
  };
}

function textEchoTTS(): TTSProvider {
  return {
    name: 'text-echo',
    synthesize: async (text) => Buffer.from(text),
    async *streamSynthesize(text) {
      for (const word of text.split(/\s+/).filter(Boolean)) {
        yield Buffer.from(`${word} `);
      }
    },
  };
}

function tone(ms: number, amplitude: number): Buffer[] {
  const total = Math.round((SAMPLE_RATE * ms) / 1000);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < total; offset += CHUNK_SAMPLES) {
    const samples = new Float32Array(CHUNK_SAMPLES);
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * (offset + i)) / SAMPLE_RATE);
    }
    chunks.push(float32ToPcm16(samples));
  }
  return chunks;
}

interface ClientLog {
  messages: Array<Record<string, unknown>>;
  audio: string;
}

function connectClient(port: number): Promise<{ ws: WebSocket; log: ClientLog }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const log: ClientLog = { messages: [], audio: '' };
    ws.on('message', (data, isBinary) => {
      if (isBinary) log.audio += (data as Buffer).toString();
      else log.messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    ws.on('open', () => resolve({ ws, log }));
    ws.on('error', reject);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function speak(ws: WebSocket): Promise<void> {
  for (const chunk of [...tone(200, 0), ...tone(600, 0.4), ...tone(700, 0)]) {
    ws.send(chunk);
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('Voice: VoiceAgent pipeline over WebSocket (deterministic STT/TTS)', () => {
  let voice: VoiceAgent | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    await voice?.close();
    voice = undefined;
    ws = undefined;
  });

  it('detects speech with EnergyVAD and streams the agent reply back', async () => {
    const calls: Array<{ input: string; sessionId?: string }> = [];
    const runner: VoiceAgentRunner = {
      async run(input, context) {
        calls.push({ input, sessionId: context?.sessionId });
        return { content: `You said ${input}` };
      },
    };
    voice = new VoiceAgent({
      mode: 'pipeline',
      agent: runner,
      stt: scriptedSTT('turn on the lights'),
      tts: textEchoTTS(),
      vad: new EnergyVAD({ threshold: 0.05, silenceDuration: 300 }),
    });
    const sessions: string[] = [];
    voice.on('session_start', (id) => sessions.push(id));
    await voice.listen(0);

    const client = await connectClient(voice.port!);
    ws = client.ws;
    await speak(ws);

    await waitUntil(() => client.log.messages.some((m) => m.type === 'turn_end'), 10_000);
    const types = client.log.messages.map((m) => m.type);
    expect(types.indexOf('speech_start')).toBeLessThan(types.indexOf('speech_end'));
    expect(client.log.messages).toContainEqual({
      type: 'transcript',
      text: 'turn on the lights',
      isFinal: true,
    });
    expect(client.log.messages).toContainEqual({
      type: 'agent_response',
      text: 'You said turn on the lights',
    });
    expect(client.log.audio.trim()).toBe('You said turn on the lights');
    expect(calls).toEqual([{ input: 'turn on the lights', sessionId: sessions[0] }]);
  });

  it('supports text input and interruption via control messages', async () => {
    let releaseFirst!: () => void;
    const runner: VoiceAgentRunner = {
      async run(input, context) {
        if (input === 'slow') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
            context?.signal?.addEventListener('abort', () => resolve());
          });
          return { content: 'stale' };
        }
        return { content: `echo ${input}` };
      },
    };
    voice = new VoiceAgent({
      mode: 'pipeline',
      agent: runner,
      stt: scriptedSTT('unused'),
      tts: textEchoTTS(),
    });
    await voice.listen(0);
    const client = await connectClient(voice.port!);
    ws = client.ws;

    ws.send(JSON.stringify({ type: 'text', text: 'slow' }));
    await waitUntil(() => typeof releaseFirst === 'function', 5_000);
    ws.send(JSON.stringify({ type: 'interrupt' }));
    ws.send(JSON.stringify({ type: 'text', text: 'fast' }));

    await waitUntil(() => client.log.messages.some((m) => m.type === 'turn_end'), 5_000);
    expect(client.log.messages.filter((m) => m.type === 'agent_response')).toEqual([
      { type: 'agent_response', text: 'echo fast' },
    ]);
    expect(client.log.audio.trim()).toBe('echo fast');
  });
});

const describeLLM = GOOGLE_API_KEY || USE_OLLAMA ? describe : describe.skip;

describeLLM('Voice: VoiceAgent pipeline with a real Cogitator agent', () => {
  let cogitator: Cogitator;
  let voice: VoiceAgent | undefined;
  let ws: WebSocket | undefined;
  const model = GOOGLE_API_KEY ? 'google/gemini-2.5-flash' : `ollama/${TEST_MODEL}`;

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: model,
        ...(GOOGLE_API_KEY && { providers: { google: { apiKey: GOOGLE_API_KEY } } }),
      },
      memory: { adapter: 'memory' },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  afterEach(async () => {
    ws?.terminate();
    await voice?.close();
    ws = undefined;
    voice = undefined;
  });

  it('speaks the agent reply for a voice turn', { timeout: 120_000 }, async () => {
    const agent = new Agent({
      name: 'voice-e2e-basic',
      model,
      instructions: 'You are a voice assistant. Reply with one short sentence.',
    });
    voice = new VoiceAgent({
      mode: 'pipeline',
      agent: createCogitatorRunner(cogitator, agent),
      stt: scriptedSTT('Say hello to the user.'),
      tts: textEchoTTS(),
    });
    await voice.listen(0);
    const client = await connectClient(voice.port!);
    ws = client.ws;

    for (const chunk of tone(300, 0.4)) ws.send(chunk);
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: 'end_of_speech' }));

    await waitUntil(() => client.log.messages.some((m) => m.type === 'turn_end'), 90_000);
    const response = client.log.messages.find((m) => m.type === 'agent_response');
    expect(typeof response?.text).toBe('string');
    expect(String(response!.text).trim().length).toBeGreaterThan(0);
    expect(client.log.audio.split(/\s+/).join(' ').trim()).toBe(
      String(response!.text).split(/\s+/).filter(Boolean).join(' ')
    );
  });

  const itGoogle = GOOGLE_API_KEY ? it : it.skip;

  itGoogle('keeps per-session conversation memory across turns', { timeout: 120_000 }, async () => {
    const agent = new Agent({
      name: 'voice-e2e',
      model,
      instructions:
        'You are a voice assistant. Answer in one short sentence. Remember facts the user tells you.',
    });
    let transcript = 'My favorite color is teal. Just say OK.';
    const stt: STTProvider = {
      name: 'switchable',
      transcribe: async () => ({ text: transcript }),
      createStream: () => new ScriptedSTTStream(transcript),
    };

    voice = new VoiceAgent({
      mode: 'pipeline',
      agent: createCogitatorRunner(cogitator, agent),
      stt,
      tts: textEchoTTS(),
    });
    await voice.listen(0);
    const client = await connectClient(voice.port!);
    ws = client.ws;

    ws.send(JSON.stringify({ type: 'text', text: transcript }));
    await waitUntil(
      () => client.log.messages.filter((m) => m.type === 'turn_end').length >= 1,
      90_000
    );

    transcript = 'What is my favorite color? Answer with one word.';
    for (const chunk of tone(300, 0.4)) ws.send(chunk);
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: 'end_of_speech' }));

    await waitUntil(
      () => client.log.messages.filter((m) => m.type === 'turn_end').length >= 2,
      90_000
    );
    const responses = client.log.messages
      .filter((m) => m.type === 'agent_response')
      .map((m) => String(m.text));
    expect(responses).toHaveLength(2);
    expect(responses[1]!.toLowerCase()).toContain('teal');
    expect(client.log.audio.toLowerCase()).toContain('teal');
  });
});
