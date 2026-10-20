import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import {
  createRealtimeTools,
  RealtimeSession,
  VoiceAgent,
  float32ToPcm16,
  pcm16ToFloat32,
  resample,
  calculateRMS,
  type RealtimeTool,
  type RealtimeToolContext,
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

  it(
    'asks approval for a Cogitator tool that needs it before the call runs',
    { timeout: 90_000 },
    async () => {
      const unlocked: string[] = [];
      const asked: string[] = [];
      const unlock = tool({
        name: 'unlock_door',
        description: 'Unlocks the door of the given room and returns its access code.',
        parameters: z.object({ room: z.string().describe('Room name') }),
        requiresApproval: true,
        execute: async ({ room }) => {
          unlocked.push(room);
          return { room, code: 'zebra' };
        },
      });
      const cogitator = new Cogitator();
      try {
        const session = createSession({
          instructions:
            'You are a voice assistant. When asked to unlock a room you MUST call unlock_door and read the access code back.',
          tools: createRealtimeTools(cogitator, [unlock], {
            onApproval: async (request) => {
              asked.push(request.toolName);
              return { approved: true };
            },
          }),
        });
        const log = record(session);
        await session.connect();

        session.sendText('Please unlock the lab.');
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !assistantText(log).includes('zebra')) {
          await nextTurnEnd(session, deadline - Date.now()).catch(() => undefined);
        }

        expect(asked[0]).toBe('unlock_door');
        expect(unlocked.length).toBeGreaterThanOrEqual(1);
        expect(asked.length).toBe(unlocked.length);
        expect(assistantText(log)).toContain('zebra');
      } finally {
        await cogitator.close();
      }
    }
  );

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

/**
 * Gemini sends `toolCallCancellation` when the user talks over a turn with a pending call. Live
 * models whose calls block (the 3.x ones) never cancel: the call simply waits for its answer, so
 * this runs on a 2.5 native audio model, which does.
 */
const CANCELLING_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

describeGemini('Voice: Gemini Live cancels a tool call the user talks over', () => {
  const sessions: RealtimeSession[] = [];
  let interruption: Buffer;

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    const speaker = new RealtimeSession({
      provider: 'gemini',
      apiKey: GOOGLE_API_KEY!,
      instructions: 'Repeat exactly what the user says, word for word, and nothing else.',
    });
    const audio: Buffer[] = [];
    speaker.on('audio', (chunk) => audio.push(chunk));
    await speaker.connect();
    const spoken = nextTurnEnd(speaker);
    speaker.sendText('Stop, stop. Never mind the weather. What is two plus two?');
    await spoken;
    speaker.close();
    interruption = float32ToPcm16(resample(pcm16ToFloat32(Buffer.concat(audio)), 24000, 16000));
  }, 90_000);

  afterEach(() => {
    for (const s of sessions) s.close();
    sessions.length = 0;
  });

  function weatherSession(tools: RealtimeTool[]) {
    const session = new RealtimeSession({
      provider: 'gemini',
      apiKey: GOOGLE_API_KEY!,
      model: CANCELLING_MODEL,
      instructions:
        'When asked about the weather, first tell the user in three long sentences that you are going to look it up, and call get_weather while you are still talking.',
      tools,
    });
    sessions.push(session);
    return session;
  }

  /** Asks about the weather and talks over the answer as soon as the tool call arrives. */
  async function askAndInterrupt(session: RealtimeSession): Promise<void> {
    const called = new Promise<void>((resolve) => session.once('tool_call', () => resolve()));
    await session.connect();
    session.sendText('What is the weather in Oslo?');
    await Promise.race([called, wait(30_000)]);
    for (let offset = 0; offset < interruption.length; offset += 3200) {
      session.pushAudio(interruption.subarray(offset, offset + 3200));
      await wait(20);
    }
    for (let i = 0; i < 40; i++) {
      session.pushAudio(Buffer.alloc(3200));
      await wait(20);
    }
  }

  const weatherParameters = {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  };

  /**
   * Runs the weather question in fresh sessions until Gemini cancels a call, up to three times:
   * whether the turn with the call is still open when the user talks varies from run to run.
   * Returns the context of the cancelled call.
   */
  async function cancelledCall(tools: () => RealtimeTool[]): Promise<RealtimeToolContext> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const contexts: RealtimeToolContext[] = [];
      const session = weatherSession(
        tools().map((realtimeTool) => ({
          ...realtimeTool,
          execute: (args: unknown, context: RealtimeToolContext) => {
            contexts.push(context);
            return realtimeTool.execute(args, context);
          },
        }))
      );
      await askAndInterrupt(session);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !contexts.some((c) => c.signal.aborted)) await wait(100);
      const cancelled = contexts.find((c) => c.signal.aborted);
      if (cancelled) return cancelled;
      session.close();
    }
    throw new Error('Gemini did not cancel the tool call in three attempts');
  }

  it('aborts the signal of the call Gemini cancels', { timeout: 180_000 }, async () => {
    let finished = false;
    const slowWeather = (): RealtimeTool[] => [
      {
        name: 'get_weather',
        description: 'Weather of a city. It is slow.',
        parameters: weatherParameters,
        execute: (_args, context) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              finished = true;
              resolve({ celsius: 21 });
            }, 20_000);
            context.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }),
      },
    ];

    const cancelled = await cancelledCall(slowWeather);

    expect((cancelled.signal.reason as Error).message).toBe('Gemini cancelled this tool call');
    expect(finished).toBe(false);
  });

  it(
    'never runs a call Gemini cancels while its approval waits, even once approved',
    { timeout: 180_000 },
    async () => {
      const ran: string[] = [];
      const approvals: Array<() => void> = [];
      const lookup = tool({
        name: 'get_weather',
        description: 'Weather of a city. It is slow.',
        parameters: z.object({ city: z.string() }),
        requiresApproval: true,
        execute: async ({ city }) => {
          ran.push(city);
          return { city, celsius: 21 };
        },
      });
      const cogitator = new Cogitator();
      try {
        const cancelled = await cancelledCall(() =>
          createRealtimeTools(cogitator, [lookup], {
            onApproval: () =>
              new Promise((resolve) => {
                approvals.push(() => resolve({ approved: true }));
              }),
          })
        );
        expect(cancelled.signal.aborted).toBe(true);
        expect(approvals.length).toBeGreaterThan(0);

        for (const approve of approvals) approve();
        await wait(2_000);

        expect(ran).toEqual([]);
      } finally {
        await cogitator.close();
      }
    }
  );
});
