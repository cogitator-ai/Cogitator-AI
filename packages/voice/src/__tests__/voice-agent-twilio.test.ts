import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  RealtimeSessionConfig,
  STTProvider,
  STTStream,
  TTSProvider,
  VoiceAgentConfig,
  VoiceAgentRunner,
} from '../types';
import {
  TWILIO_SESSION_TOKEN_PARAMETER,
  TwilioSessionTokens,
  twilioSignature,
} from '../telephony/twilio-security';
import { float32ToPcm16 } from '../audio';

const mocks = await vi.hoisted(async () => {
  const { EventEmitter: EE } = await import('node:events');
  const sessions: Array<InstanceType<typeof MockRealtimeSession>> = [];
  class MockRealtimeSession extends EE {
    readonly config: RealtimeSessionConfig;
    pushAudio = vi.fn();
    sendText = vi.fn();
    interrupt = vi.fn();
    close = vi.fn();
    connect = vi.fn(async () => {});
    constructor(config: RealtimeSessionConfig) {
      super();
      this.config = config;
      sessions.push(this);
    }
  }
  return { sessions, MockRealtimeSession };
});

vi.mock('../realtime/realtime-session.js', () => ({ RealtimeSession: mocks.MockRealtimeSession }));

import { VoiceAgent, type TwilioCall } from '../voice-agent';

const AUTH_TOKEN = 'test-auth-token';
const STREAM_URL = 'wss://voice.example.com/twilio';
const STREAM_SID = 'MZ0001';

type TwilioMessage = Record<string, unknown> & { event: string };

class FakeCall {
  readonly received: TwilioMessage[] = [];
  closeCode: number | undefined;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => this.received.push(JSON.parse(data.toString()) as TwilioMessage));
    ws.on('close', (code) => {
      this.closeCode = code;
    });
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  start(customParameters: Record<string, string>): void {
    this.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    this.send({
      event: 'start',
      sequenceNumber: '1',
      streamSid: STREAM_SID,
      start: {
        accountSid: 'AC0001',
        streamSid: STREAM_SID,
        callSid: 'CA0001',
        tracks: ['inbound'],
        customParameters,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    });
  }

  media(payload: Buffer): void {
    this.send({
      event: 'media',
      streamSid: STREAM_SID,
      media: { track: 'inbound', chunk: '1', timestamp: '0', payload: payload.toString('base64') },
    });
  }

  of(event: string): TwilioMessage[] {
    return this.received.filter((m) => m.event === event);
  }

  outboundAudio(): Buffer {
    return Buffer.concat(
      this.of('media').map((m) => Buffer.from((m.media as { payload: string }).payload, 'base64'))
    );
  }

  echoMarks(): void {
    for (const mark of this.of('mark'))
      this.send({ event: 'mark', streamSid: STREAM_SID, mark: mark.mark });
  }
}

function ttsWith(rawSampleRates: TTSProvider['rawSampleRates']): TTSProvider {
  return {
    name: 'tts',
    ...(rawSampleRates && { rawSampleRates }),
    synthesize: vi.fn(),
    streamSynthesize: vi.fn(async function* (text: string) {
      if (rawSampleRates?.mulaw === 8000) {
        yield Buffer.from(text);
        return;
      }
      yield float32ToPcm16(new Float32Array(2400).fill(0.2));
    }),
  };
}

function sttWith(written: Buffer[]): STTProvider {
  return {
    name: 'stt',
    streamEncodings: ['pcm16', 'mulaw'],
    transcribe: vi.fn(),
    createStream: vi.fn(() => {
      const stream = new EventEmitter() as EventEmitter & STTStream;
      stream.write = (chunk: Buffer) => {
        written.push(chunk);
      };
      stream.close = async () => ({ text: '' });
      return stream;
    }),
  };
}

const servers: http.Server[] = [];
const agents: VoiceAgent[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  mocks.sessions.length = 0;
});

async function serve(config: Partial<VoiceAgentConfig>, tokens = new TwilioSessionTokens()) {
  const runner: VoiceAgentRunner = {
    run: vi.fn(async (input: string) => ({ content: `You said ${input}` })),
  };
  const voice = new VoiceAgent({
    mode: 'pipeline',
    agent: runner,
    stt: sttWith([]),
    tts: ttsWith({ mulaw: 8000 }),
    ...config,
  } as VoiceAgentConfig);
  agents.push(voice);
  const server = http.createServer();
  servers.push(server);
  voice.attachTwilio(server, {
    authToken: AUTH_TOKEN,
    streamUrl: STREAM_URL,
    tokens,
    dtmfInput: (digit) => `pressed ${digit}`,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { voice, runner, tokens, port };
}

function dial(
  port: number,
  signature = twilioSignature(AUTH_TOKEN, STREAM_URL)
): Promise<FakeCall> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio`, {
      headers: { 'X-Twilio-Signature': signature },
    });
    sockets.push(ws);
    const call = new FakeCall(ws);
    ws.on('open', () => resolve(call));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

describe('VoiceAgent with Twilio media streams', () => {
  it('refuses an upgrade without a valid Twilio signature', async () => {
    const { port } = await serve({});
    await expect(dial(port, 'bogus')).rejects.toThrow('status 403');
    await expect(dial(port, twilioSignature('other-token', STREAM_URL))).rejects.toThrow(
      'status 403'
    );
  });

  it('refuses a stream whose token is missing or was used before', async () => {
    const { port, tokens, voice } = await serve({});
    const starts = vi.fn();
    voice.on('session_start', starts);

    const anonymous = await dial(port);
    anonymous.start({});
    await vi.waitFor(() => expect(anonymous.closeCode).toBe(1008));

    const token = tokens.issue();
    const first = await dial(port);
    first.start({ [TWILIO_SESSION_TOKEN_PARAMETER]: token });
    await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(1));

    const replay = await dial(port);
    replay.start({ [TWILIO_SESSION_TOKEN_PARAMETER]: token });
    await vi.waitFor(() => expect(replay.closeCode).toBe(1008));
    expect(starts).toHaveBeenCalledTimes(1);
  });

  it('starts a call session, feeds μ-law to the STT and answers key presses', async () => {
    const written: Buffer[] = [];
    const { port, tokens, voice, runner } = await serve({ stt: sttWith(written) });
    const calls: TwilioCall[] = [];
    const digits: Array<[string, string]> = [];
    voice.on('call_start', (call) => calls.push(call));
    voice.on('dtmf', (sessionId, digit) => digits.push([sessionId, digit]));

    const call = await dial(port);
    call.start({
      [TWILIO_SESSION_TOKEN_PARAMETER]: tokens.issue({ from: '+15550001' }),
      lang: 'en',
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      callSid: 'CA0001',
      streamSid: STREAM_SID,
      accountSid: 'AC0001',
      customParameters: { lang: 'en' },
      grant: { metadata: { from: '+15550001' } },
    });

    call.media(Buffer.alloc(160, 0x7f));
    await vi.waitFor(() => expect(written).toEqual([Buffer.alloc(160, 0x7f)]));

    call.send({
      event: 'dtmf',
      streamSid: STREAM_SID,
      dtmf: { track: 'inbound_track', digit: '5' },
    });
    await vi.waitFor(() => expect(call.of('mark')).toHaveLength(1));
    expect(digits).toEqual([[calls[0]!.sessionId, '5']]);
    expect(runner.run).toHaveBeenCalledWith(
      'pressed 5',
      expect.objectContaining({
        sessionId: calls[0]!.sessionId,
      })
    );
    expect(call.outboundAudio().toString()).toBe('You said pressed 5');
    expect(call.received.at(-1)!.event).toBe('mark');
  });

  it('transcodes PCM16 from a TTS without μ-law into 20 ms μ-law frames', async () => {
    const { port, tokens, voice } = await serve({ tts: ttsWith({ pcm16: 24000 }) });
    const call = await dial(port);
    call.start({ [TWILIO_SESSION_TOKEN_PARAMETER]: tokens.issue() });
    await vi.waitFor(() => expect(voice.activeSessions).toBe(1));
    call.send({ event: 'dtmf', streamSid: STREAM_SID, dtmf: { digit: '1' } });
    await vi.waitFor(() => expect(call.of('mark')).toHaveLength(1));
    const frames = call
      .of('media')
      .map((m) => Buffer.from((m.media as { payload: string }).payload, 'base64').length);
    expect(frames.reduce((a, b) => a + b, 0)).toBe(800);
    expect(frames.every((length) => length === 160)).toBe(true);
  });

  it('ends the session when Twilio stops the stream', async () => {
    const { port, tokens, voice } = await serve({});
    const ended = vi.fn();
    voice.on('session_end', ended);
    const call = await dial(port);
    call.start({ [TWILIO_SESSION_TOKEN_PARAMETER]: tokens.issue() });
    await vi.waitFor(() => expect(voice.activeSessions).toBe(1));
    call.send({ event: 'stop', streamSid: STREAM_SID, stop: { callSid: 'CA0001' } });
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(voice.activeSessions).toBe(0);
  });

  it('refuses configurations that cannot serve a call', () => {
    const voice = new VoiceAgent({
      mode: 'pipeline',
      agent: { run: vi.fn() },
      stt: sttWith([]),
      tts: ttsWith(undefined),
    });
    const server = http.createServer();
    expect(() =>
      voice.attachTwilio(server, {
        authToken: AUTH_TOKEN,
        streamUrl: STREAM_URL,
        tokens: new TwilioSessionTokens(),
      })
    ).toThrow('rawSampleRates');
    expect(() =>
      voice.attachTwilio(server, { authToken: AUTH_TOKEN, streamUrl: STREAM_URL })
    ).toThrow('tokens or authorize');
    expect(() =>
      voice.attachTwilio(server, {
        authToken: '',
        streamUrl: STREAM_URL,
        tokens: new TwilioSessionTokens(),
      })
    ).toThrow('authToken');
  });

  it('runs a realtime session in μ-law, clearing on barge-in and marking each turn', async () => {
    const { port, tokens } = await serve({
      mode: 'realtime',
      realtimeProvider: 'openai',
      realtimeApiKey: 'key',
    });
    const call = await dial(port);
    call.start({ [TWILIO_SESSION_TOKEN_PARAMETER]: tokens.issue() });
    await vi.waitFor(() => expect(mocks.sessions).toHaveLength(1));
    const session = mocks.sessions[0]!;
    expect(session.config.audioFormat).toBe('pcmu');

    call.media(Buffer.alloc(160, 0x10));
    await vi.waitFor(() => expect(session.pushAudio).toHaveBeenCalledWith(Buffer.alloc(160, 0x10)));

    session.emit('audio', Buffer.alloc(320, 0x20));
    session.emit('speech_start');
    await vi.waitFor(() => expect(call.of('clear')).toHaveLength(1));
    expect(call.outboundAudio()).toEqual(Buffer.alloc(320, 0x20));

    session.emit('audio', Buffer.alloc(100, 0x30));
    session.emit('turn_end');
    await vi.waitFor(() => expect(call.of('mark')).toHaveLength(1));
    expect(call.received.map((m) => m.event)).toEqual(['media', 'media', 'clear', 'media', 'mark']);
  });

  it('serves a stream accepted by a server of the caller with handleTwilio', async () => {
    const voice = new VoiceAgent({
      mode: 'pipeline',
      agent: { run: vi.fn(async () => ({ content: 'ok' })) },
      stt: sttWith([]),
      tts: ttsWith({ mulaw: 8000 }),
    });
    agents.push(voice);
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const authorize = vi.fn(
      (start: { customParameters: Record<string, string> }) =>
        start.customParameters.key === 'secret'
    );
    wss.on('connection', (ws) => voice.handleTwilio(ws, { authorize }));
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(ws);
      const call = new FakeCall(ws);
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));
      call.start({ key: 'secret' });
      await vi.waitFor(() => expect(voice.activeSessions).toBe(1));
      expect(authorize).toHaveBeenCalledTimes(1);
    } finally {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
