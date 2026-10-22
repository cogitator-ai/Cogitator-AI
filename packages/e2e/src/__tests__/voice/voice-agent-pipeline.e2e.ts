import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { MemoryEntry } from '@cogitator-ai/types';
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
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

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
  /** What arrived, in order: `audio` for a binary frame, else the message type */
  order: string[];
}

function connectClient(port: number): Promise<{ ws: WebSocket; log: ClientLog }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const log: ClientLog = { messages: [], audio: '', order: [] };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        log.audio += (data as Buffer).toString();
        log.order.push('audio');
        return;
      }
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      log.messages.push(message);
      log.order.push(String(message.type));
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

const describeLLM = describe.skipIf(!GOOGLE_API_KEY && (await ollamaSkipReason()) !== null);

describeLLM('Voice: VoiceAgent pipeline with a real Cogitator agent', () => {
  let cogitator: Cogitator;
  let voice: VoiceAgent | undefined;
  let ws: WebSocket | undefined;
  const model = GOOGLE_API_KEY ? 'google/gemini-3.5-flash-lite' : `ollama/${getTestModel()}`;

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

/**
 * Echoes text as audio like `textEchoTTS`, but holds the second piece it is asked to speak until
 * `release`, so a test can interrupt a reply after its first piece was spoken
 */
function holdingTTS(): { tts: TTSProvider; spoken: string[]; release: () => void } {
  const spoken: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    spoken,
    release,
    tts: {
      name: 'holding',
      synthesize: async (text) => Buffer.from(text),
      async *streamSynthesize(text) {
        spoken.push(text);
        if (spoken.length > 1) await held;
        yield Buffer.from(`${text} `);
      },
    },
  };
}

async function threadOf(cogitator: Cogitator, sessionId: string): Promise<MemoryEntry[]> {
  const memory = await cogitator.getMemory();
  const path = await memory!.getPath!({ threadId: `voice:${sessionId}` });
  if (!path.success) throw new Error(path.error);
  return path.data;
}

const ollamaReason = await ollamaSkipReason();
const streamingTargets = [
  { label: 'MockLLMBackend', model: 'mock/scripted', skip: false },
  {
    label: `Ollama ${getTestModel()}`,
    model: `ollama/${getTestModel()}`,
    skip: ollamaReason !== null,
  },
];

for (const target of streamingTargets) {
  describe.skipIf(target.skip)(
    `Voice: streamed replies with a Cogitator agent (${target.label})`,
    () => {
      const scripted = target.model.startsWith('mock/');
      let cogitator: Cogitator;
      let backend: MockLLMBackend;
      let voice: VoiceAgent | undefined;
      let ws: WebSocket | undefined;
      let release: (() => void) | undefined;

      beforeAll(() => {
        backend = new MockLLMBackend();
        cogitator = new Cogitator({
          llm: { ...(scripted && { backends: { mock: backend } }), retry: false },
          memory: { adapter: 'memory' },
        });
      });

      afterAll(async () => {
        await cogitator.close();
      });

      afterEach(async () => {
        release?.();
        ws?.terminate();
        await voice?.close();
        ws = undefined;
        voice = undefined;
        release = undefined;
      });

      async function serve(
        tts: TTSProvider,
        instructions: string,
        maxSentenceLength?: number
      ): Promise<{ log: ClientLog; sessionId: () => string }> {
        const agent = new Agent({ name: 'voice-stream-e2e', model: target.model, instructions });
        const sessions: string[] = [];
        voice = new VoiceAgent({
          mode: 'pipeline',
          agent: createCogitatorRunner(cogitator, agent),
          stt: scriptedSTT('unused'),
          tts,
          ...(maxSentenceLength !== undefined && { maxSentenceLength }),
        });
        voice.on('session_start', (id) => sessions.push(id));
        await voice.listen(0);
        const client = await connectClient(voice.port!);
        ws = client.ws;
        await waitUntil(() => sessions.length === 1, 5_000);
        return { log: client.log, sessionId: () => sessions[0]! };
      }

      it(
        'speaks the first sentence before the answer is generated',
        { timeout: 120_000 },
        async () => {
          backend.setStreamChunks([
            { content: 'The ocean is vast. ' },
            { content: 'It covers most of the planet. ', delay: 300 },
            { content: 'Its waves never stop.', delay: 300 },
          ]);
          const { log, sessionId } = await serve(
            textEchoTTS(),
            'You are a voice assistant. Answer in exactly three short sentences.'
          );

          ws!.send(JSON.stringify({ type: 'text', text: 'Tell me about the ocean.' }));
          await waitUntil(() => log.order.includes('turn_end'), 90_000);

          const response = String(log.messages.find((m) => m.type === 'agent_response')?.text);
          expect(response.trim().length).toBeGreaterThan(0);
          expect(log.audio.split(/\s+/).join(' ').trim()).toBe(
            response.split(/\s+/).filter(Boolean).join(' ')
          );
          const deltas = log.messages.filter((m) => m.type === 'agent_response_delta');
          expect(deltas.map((m) => String(m.text)).join('')).toBe(response);
          if (scripted) {
            expect(log.order.indexOf('audio')).toBeLessThan(log.order.indexOf('agent_response'));
          }

          const thread = await threadOf(cogitator, sessionId());
          expect(thread.map((e) => [e.message.role, String(e.message.content)])).toEqual([
            ['user', 'Tell me about the ocean.'],
            ['assistant', response],
          ]);
          expect(thread[1]!.metadata?.interrupted).toBeUndefined();
        }
      );

      it(
        'keeps only the spoken part of an interrupted reply in memory',
        { timeout: 120_000 },
        async () => {
          backend.setStreamChunks([
            { content: 'First, the ocean is deep. Second' },
            { content: ', it is salty. Third', delay: 200 },
            { content: ', it is cold.', delay: 5_000 },
          ]);
          const holding = holdingTTS();
          release = holding.release;
          const { log, sessionId } = await serve(
            holding.tts,
            'You are a voice assistant. Describe the ocean in three long sentences.',
            scripted ? undefined : 24
          );

          ws!.send(JSON.stringify({ type: 'text', text: 'Describe the ocean.' }));
          await waitUntil(() => holding.spoken.length >= 2, 90_000);
          expect(log.audio.trim()).toBe(holding.spoken[0]);
          ws!.send(JSON.stringify({ type: 'interrupt' }));

          let thread: MemoryEntry[] = [];
          await waitUntil(() => {
            void threadOf(cogitator, sessionId()).then((entries) => {
              thread = entries;
            });
            return thread.some((e) => e.metadata?.interrupted === true);
          }, 30_000);

          expect(thread.map((e) => [e.message.role, String(e.message.content)])).toEqual([
            ['user', 'Describe the ocean.'],
            ['assistant', holding.spoken[0]],
          ]);
          expect(thread[1]!.metadata).toEqual({ interrupted: true });
          expect(log.order).not.toContain('turn_end');
        }
      );
    }
  );
}
