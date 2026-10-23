import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { MemoryEntry } from '@cogitator-ai/types';
import {
  VoiceAgent,
  EnergyVAD,
  TwilioSessionTokens,
  createCogitatorRunner,
  float32ToMulaw,
  twilioSignature,
  twilioStreamTwiml,
  TWILIO_SESSION_TOKEN_PARAMETER,
  type STTProvider,
  type STTStream,
  type TTSProvider,
  type TranscribeResult,
  type TwilioCall,
} from '@cogitator-ai/voice';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const AUTH_TOKEN = 'e2e-auth-token';
const STREAM_URL = 'wss://voice.example.test/twilio';
const STREAM_SID = 'MZe2e0001';
const RATE = 8000;
const FRAME = 160;

/** Transcribes the first utterance as `transcript` and every later one as silence */
function scriptedSTT(transcript: string): STTProvider {
  let streams = 0;
  return {
    name: 'scripted',
    transcribe: async () => ({ text: transcript }),
    createStream: () => {
      const text = streams++ === 0 ? transcript : '';
      const stream = new EventEmitter() as EventEmitter & STTStream;
      let bytes = 0;
      stream.write = (chunk: Buffer) => {
        bytes += chunk.length;
      };
      stream.close = async (): Promise<TranscribeResult> => {
        const result = { text: bytes > 0 ? text : '' };
        stream.emit('final', result);
        return result;
      };
      return stream;
    },
  };
}

/** "Speaks" each sentence as its own text, declared as μ-law so it reaches the call unchanged */
function textEchoTTS(): TTSProvider {
  return {
    name: 'text-echo',
    rawSampleRates: { mulaw: RATE },
    synthesize: async (text) => Buffer.from(text),
    async *streamSynthesize(text) {
      for (const word of text.split(/\s+/).filter(Boolean)) yield Buffer.from(`${word} `);
    },
  };
}

function tone(ms: number, amplitude: number): Buffer[] {
  const total = Math.round((RATE * ms) / 1000);
  const frames: Buffer[] = [];
  for (let offset = 0; offset < total; offset += FRAME) {
    const samples = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * (offset + i)) / RATE);
    }
    frames.push(float32ToMulaw(samples));
  }
  return frames;
}

type TwilioMessage = Record<string, unknown> & { event: string };

/** Plays the part of Twilio: signs the upgrade, starts the stream and echoes marks on demand */
class FakeTwilio {
  readonly received: TwilioMessage[] = [];
  closeCode: number | undefined;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => this.received.push(JSON.parse(data.toString()) as TwilioMessage));
    ws.on('close', (code) => {
      this.closeCode = code;
    });
  }

  static dial(port: number): Promise<FakeTwilio> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio`, {
        headers: { 'X-Twilio-Signature': twilioSignature(AUTH_TOKEN, STREAM_URL) },
      });
      ws.once('open', () => resolve(new FakeTwilio(ws)));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  start(token: string): void {
    this.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    this.send({
      event: 'start',
      sequenceNumber: '1',
      streamSid: STREAM_SID,
      start: {
        accountSid: 'ACe2e',
        streamSid: STREAM_SID,
        callSid: 'CAe2e',
        tracks: ['inbound'],
        customParameters: { [TWILIO_SESSION_TOKEN_PARAMETER]: token },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: RATE, channels: 1 },
      },
    });
  }

  async speak(frames: Buffer[]): Promise<void> {
    for (const frame of frames) {
      this.send({
        event: 'media',
        streamSid: STREAM_SID,
        media: { track: 'inbound', chunk: '1', timestamp: '0', payload: frame.toString('base64') },
      });
      await new Promise((r) => setImmediate(r));
    }
  }

  marks(): string[] {
    return this.received
      .filter((m) => m.event === 'mark')
      .map((m) => (m.mark as { name: string }).name);
  }

  echo(name: string): void {
    this.send({ event: 'mark', streamSid: STREAM_SID, mark: { name } });
  }

  /** The text of the audio sent before the mark `name`, or of all audio without one */
  audioBefore(name?: string): string {
    let text = '';
    for (const message of this.received) {
      if (message.event === 'mark' && (message.mark as { name: string }).name === name) break;
      if (message.event !== 'media') continue;
      text += Buffer.from((message.media as { payload: string }).payload, 'base64').toString();
    }
    return text;
  }

  frameSizes(): number[] {
    return this.received
      .filter((m) => m.event === 'media')
      .map((m) => Buffer.from((m.media as { payload: string }).payload, 'base64').length);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function threadOf(cogitator: Cogitator, sessionId: string): Promise<MemoryEntry[]> {
  const memory = await cogitator.getMemory();
  const path = await memory!.getPath!({ threadId: `voice:${sessionId}` });
  if (!path.success) throw new Error(path.error);
  return path.data;
}

const ollamaReason = await ollamaSkipReason();
const targets = [
  { label: 'MockLLMBackend', model: 'mock/scripted', skip: false },
  {
    label: `Ollama ${getTestModel()}`,
    model: `ollama/${getTestModel()}`,
    skip: ollamaReason !== null,
  },
];

for (const target of targets) {
  describe.skipIf(target.skip)(`Voice: a Twilio phone call (${target.label})`, () => {
    const scripted = target.model.startsWith('mock/');
    let cogitator: Cogitator;
    let backend: MockLLMBackend;
    let server: http.Server | undefined;
    let voice: VoiceAgent | undefined;
    let call: FakeTwilio | undefined;

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
      call?.terminate();
      await voice?.close();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      call = undefined;
      voice = undefined;
      server = undefined;
    });

    async function answer(): Promise<{
      port: number;
      tokens: TwilioSessionTokens;
      calls: TwilioCall[];
    }> {
      const agent = new Agent({
        name: 'phone-e2e',
        model: target.model,
        instructions: 'You are a phone assistant. Describe the ocean in three long sentences.',
      });
      voice = new VoiceAgent({
        mode: 'pipeline',
        agent: createCogitatorRunner(cogitator, agent),
        stt: scriptedSTT('Describe the ocean.'),
        tts: textEchoTTS(),
        vad: new EnergyVAD({ threshold: 0.05, silenceDuration: 300, sampleRate: RATE }),
        bargeIn: true,
        ...(scripted ? {} : { maxSentenceLength: 24 }),
      });
      const tokens = new TwilioSessionTokens();
      const calls: TwilioCall[] = [];
      voice.on('call_start', (c) => calls.push(c));
      server = http.createServer();
      voice.attachTwilio(server, { authToken: AUTH_TOKEN, streamUrl: STREAM_URL, tokens });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      return { port: (server.address() as AddressInfo).port, tokens, calls };
    }

    it(
      'speaks over the call and keeps only what the caller heard after a barge-in',
      { timeout: 120_000 },
      async () => {
        backend.setStreamChunks([
          { content: 'First, the ocean is deep. ' },
          { content: 'Second, it is salty. ', delay: 50 },
          { content: 'Third, it is cold.', delay: 5_000 },
        ]);
        const { port, tokens, calls } = await answer();
        const twiml = twilioStreamTwiml({ url: STREAM_URL, token: tokens.issue() });
        const token = /value="([^"]+)"/.exec(twiml)![1]!;

        call = await FakeTwilio.dial(port);
        call.start(token);
        await waitUntil(() => calls.length === 1, 5_000);
        await call.speak([...tone(200, 0), ...tone(600, 0.4), ...tone(700, 0)]);

        await waitUntil(() => call!.marks().length >= 1, 90_000);
        const [first] = call.marks();
        const heard = call.audioBefore(first);
        expect(heard.trim().length).toBeGreaterThan(0);
        call.echo(first!);
        await waitUntil(() => call!.marks().length >= 2, 90_000);
        const second = call.marks()[1];
        expect(call.audioBefore(second).length).toBeGreaterThan(heard.length);
        expect(call.frameSizes().every((size) => size > 0 && size <= FRAME)).toBe(true);

        await call.speak(tone(300, 0.4));
        await waitUntil(() => call!.received.some((m) => m.event === 'clear'), 10_000);

        let thread: MemoryEntry[] = [];
        await waitUntil(async () => {
          thread = await threadOf(cogitator, calls[0]!.sessionId);
          return thread.some((e) => e.metadata?.interrupted === true);
        }, 30_000);
        expect(thread.map((e) => [e.message.role, String(e.message.content).trim()])).toEqual([
          ['user', 'Describe the ocean.'],
          ['assistant', heard.trim()],
        ]);
        if (scripted) expect(heard.trim()).toBe('First, the ocean is deep.');
      }
    );

    it('refuses a call whose token was already used', { timeout: 30_000 }, async () => {
      const { port, tokens, calls } = await answer();
      const token = tokens.issue();
      call = await FakeTwilio.dial(port);
      call.start(token);
      await waitUntil(() => calls.length === 1, 5_000);

      const replay = await FakeTwilio.dial(port);
      try {
        replay.start(token);
        await waitUntil(() => replay.closeCode !== undefined, 5_000);
        expect(replay.closeCode).toBe(1008);
        expect(calls).toHaveLength(1);
      } finally {
        replay.terminate();
      }
    });
  });
}
