import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  RealtimeSession,
  VoiceAgent,
  float32ToPcm16,
  pcm16ToFloat32,
  resample,
  calculateRMS,
} from '@cogitator-ai/voice';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const describeGemini = GOOGLE_API_KEY ? describe : describe.skip;

interface TurnLog {
  audio: Buffer[];
  transcripts: Array<{ text: string; role: 'user' | 'assistant' }>;
  toolCalls: Array<{ name: string; args: unknown }>;
  errors: Error[];
}

function record(session: RealtimeSession): TurnLog {
  const log: TurnLog = { audio: [], transcripts: [], toolCalls: [], errors: [] };
  session.on('audio', (chunk) => log.audio.push(chunk));
  session.on('transcript', (text, role) => log.transcripts.push({ text, role }));
  session.on('tool_call', (name, args) => log.toolCalls.push({ name, args }));
  session.on('error', (err) => log.errors.push(err));
  return log;
}

function nextTurnEnd(session: RealtimeSession, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn_end timeout')), timeoutMs);
    session.once('turn_end', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assistantText(log: TurnLog): string {
  return log.transcripts
    .filter((t) => t.role === 'assistant')
    .map((t) => t.text)
    .join(' ')
    .toLowerCase();
}

describeGemini('Voice: Gemini Live realtime', () => {
  const sessions: RealtimeSession[] = [];
  let voice: VoiceAgent | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    for (const s of sessions) s.close();
    sessions.length = 0;
    ws?.terminate();
    ws = undefined;
    await voice?.close();
    voice = undefined;
  });

  function createSession(config: Partial<ConstructorParameters<typeof RealtimeSession>[0]> = {}) {
    const session = new RealtimeSession({
      provider: 'gemini',
      apiKey: GOOGLE_API_KEY!,
      instructions: 'You are a concise voice assistant. Answer in one short sentence.',
      ...config,
    });
    sessions.push(session);
    return session;
  }

  it(
    'answers a text turn with audio and an output transcription',
    { timeout: 90_000 },
    async () => {
      const session = createSession();
      const log = record(session);
      await session.connect();
      expect(session.isConnected).toBe(true);

      const done = nextTurnEnd(session);
      session.sendText('What is two plus two?');
      await done;

      expect(log.errors).toEqual([]);
      const bytes = log.audio.reduce((n, c) => n + c.length, 0);
      expect(bytes).toBeGreaterThan(24_000);
      expect(assistantText(log)).toMatch(/four|4/);
    }
  );

  it('executes a tool call and speaks the result', { timeout: 90_000 }, async () => {
    const executed: unknown[] = [];
    const session = createSession({
      instructions:
        'You are a voice assistant. When asked for the secret code you MUST call get_secret_code and read the code back.',
      tools: [
        {
          name: 'get_secret_code',
          description: 'Returns the secret code for the given user.',
          parameters: {
            type: 'object',
            properties: { user: { type: 'string', description: 'User name' } },
            required: ['user'],
          },
          execute: async (args) => {
            executed.push(args);
            return { code: 'zebra' };
          },
        },
      ],
    });
    const log = record(session);
    await session.connect();

    session.sendText('What is the secret code for user Alice?');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !assistantText(log).includes('zebra')) {
      await nextTurnEnd(session, deadline - Date.now()).catch(() => undefined);
    }

    expect(executed.length).toBeGreaterThanOrEqual(1);
    expect(log.toolCalls[0]!.name).toBe('get_secret_code');
    expect(assistantText(log)).toContain('zebra');
  });

  it('understands spoken audio input (16kHz PCM16)', { timeout: 120_000 }, async () => {
    const speaker = createSession({
      instructions: 'Repeat exactly what the user says, word for word, and nothing else.',
    });
    const speakerLog = record(speaker);
    await speaker.connect();
    const spoken = nextTurnEnd(speaker);
    speaker.sendText('What is the capital of France?');
    await spoken;
    const speech24k = pcm16ToFloat32(Buffer.concat(speakerLog.audio));
    expect(calculateRMS(speech24k)).toBeGreaterThan(0.005);
    const speech16k = float32ToPcm16(resample(speech24k, 24000, 16000));

    const listener = createSession();
    const log = record(listener);
    await listener.connect();
    const answered = nextTurnEnd(listener, 90_000);

    const chunkBytes = 3200;
    for (let offset = 0; offset < speech16k.length; offset += chunkBytes) {
      listener.pushAudio(speech16k.subarray(offset, offset + chunkBytes));
      await new Promise((r) => setTimeout(r, 20));
    }
    const silence = Buffer.alloc(chunkBytes);
    for (let i = 0; i < 25; i++) {
      listener.pushAudio(silence);
      await new Promise((r) => setTimeout(r, 20));
    }
    await answered;

    const userText = log.transcripts
      .filter((t) => t.role === 'user')
      .map((t) => t.text)
      .join(' ')
      .toLowerCase();
    expect(userText).toContain('france');
    expect(assistantText(log)).toContain('paris');
  });

  it(
    'serves a realtime session through VoiceAgent over WebSocket',
    { timeout: 90_000 },
    async () => {
      voice = new VoiceAgent({
        mode: 'realtime',
        agent: {
          run: async () => ({ content: '' }),
          instructions: 'You are a concise voice assistant. Answer in one short sentence.',
        },
        realtimeProvider: 'gemini',
        realtimeApiKey: GOOGLE_API_KEY!,
      });
      const errors: Error[] = [];
      voice.on('error', (err) => errors.push(err));
      await voice.listen(0);

      const messages: Array<Record<string, unknown>> = [];
      let audioBytes = 0;
      ws = await new Promise<WebSocket>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${voice!.port}/voice`);
        client.on('message', (data, isBinary) => {
          if (isBinary) audioBytes += (data as Buffer).length;
          else messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        client.on('open', () => resolve(client));
        client.on('error', reject);
      });

      ws.send(JSON.stringify({ type: 'text', text: 'Say hello in one word.' }));

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !messages.some((m) => m.type === 'turn_end')) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(errors).toEqual([]);
      expect(messages.some((m) => m.type === 'turn_end')).toBe(true);
      expect(audioBytes).toBeGreaterThan(0);
      expect(messages.some((m) => m.type === 'transcript' && m.role === 'assistant')).toBe(true);
    }
  );
});
