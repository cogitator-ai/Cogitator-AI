import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { RealtimeSessionConfig, STTProvider, TTSProvider } from '../types';

const mocks = await vi.hoisted(async () => {
  const { EventEmitter: EE } = await import('node:events');
  const state = {
    sessions: [] as Array<InstanceType<typeof MockRealtimeSession>>,
    connectImpl: async (): Promise<void> => {},
  };
  class MockRealtimeSession extends EE {
    readonly config: RealtimeSessionConfig;
    pushAudio = vi.fn();
    sendText = vi.fn();
    interrupt = vi.fn();
    close = vi.fn();
    connect = vi.fn(() => state.connectImpl());
    constructor(config: RealtimeSessionConfig) {
      super();
      this.config = config;
      state.sessions.push(this);
    }
  }
  return { state, MockRealtimeSession };
});

const realtimeSessions = mocks.state.sessions;

vi.mock('../realtime/realtime-session.js', () => ({ RealtimeSession: mocks.MockRealtimeSession }));

import { VoiceAgent } from '../voice-agent';

function createSTT(): STTProvider {
  return {
    name: 'stt',
    transcribe: vi.fn(),
    createStream: vi.fn(() => {
      const stream = new EventEmitter() as EventEmitter & {
        write: (c: Buffer) => void;
        close: () => Promise<{ text: string }>;
      };
      stream.write = vi.fn();
      stream.close = vi.fn().mockResolvedValue({ text: 'spoken words' });
      return stream as never;
    }),
  };
}

function createTTS(): TTSProvider {
  return {
    name: 'tts',
    synthesize: vi.fn(),
    streamSynthesize: vi.fn(async function* (text: string) {
      yield Buffer.from(`pcm:${text}`);
    }),
  };
}

interface Received {
  messages: Array<Record<string, unknown>>;
  audio: Buffer[];
}

function connect(port: number): Promise<{ ws: WebSocket; received: Received }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const received: Received = { messages: [], audio: [] };
    ws.on('message', (data, isBinary) => {
      if (isBinary) received.audio.push(data as Buffer);
      else received.messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    ws.on('open', () => resolve({ ws, received }));
    ws.on('error', reject);
  });
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('VoiceAgent control protocol and realtime wiring', () => {
  let voice: VoiceAgent | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) ws.terminate();
    sockets.length = 0;
    await voice?.close();
    voice = undefined;
    realtimeSessions.length = 0;
    mocks.state.connectImpl = async () => {};
  });

  async function start(config: ConstructorParameters<typeof VoiceAgent>[0]) {
    voice = new VoiceAgent(config);
    await voice.listen(0);
    const conn = await connect(voice.port!);
    sockets.push(conn.ws);
    return conn;
  }

  it('runs a text turn from a { type: "text" } control message in pipeline mode', async () => {
    const agent = { run: vi.fn().mockResolvedValue({ content: 'hello back' }) };
    const { ws, received } = await start({
      mode: 'pipeline',
      agent,
      stt: createSTT(),
      tts: createTTS(),
    });

    ws.send(JSON.stringify({ type: 'text', text: 'hello' }));

    await vi.waitFor(() => expect(received.messages).toContainEqual({ type: 'turn_end' }));
    expect(agent.run).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ sessionId: expect.any(String) })
    );
    expect(received.messages).toContainEqual({ type: 'agent_response', text: 'hello back' });
    expect(received.audio.map((b) => b.toString())).toEqual(['pcm:hello back']);
  });

  it('commits buffered audio on { type: "end_of_speech" } without a VAD', async () => {
    const agent = { run: vi.fn().mockResolvedValue({ content: 'ok' }) };
    const { ws, received } = await start({
      mode: 'pipeline',
      agent,
      stt: createSTT(),
      tts: createTTS(),
    });

    ws.send(Buffer.alloc(32));
    await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ type: 'end_of_speech' }));

    await vi.waitFor(() => expect(received.messages).toContainEqual({ type: 'turn_end' }));
    expect(agent.run).toHaveBeenCalledWith('spoken words', expect.anything());
  });

  it('interrupts the pipeline turn on { type: "interrupt" }', async () => {
    let signal: AbortSignal | undefined;
    const agent = {
      run: vi.fn(
        (_input: string, ctx?: { signal?: AbortSignal }) =>
          new Promise<{ content: string }>(() => {
            signal = ctx?.signal;
          })
      ),
    };
    const { ws } = await start({ mode: 'pipeline', agent, stt: createSTT(), tts: createTTS() });

    ws.send(JSON.stringify({ type: 'text', text: 'long question' }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    ws.send(JSON.stringify({ type: 'interrupt' }));

    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
  });

  it('reports invalid control messages through the error event', async () => {
    const errors: Error[] = [];
    voice = new VoiceAgent({
      mode: 'pipeline',
      agent: { run: vi.fn() },
      stt: createSTT(),
      tts: createTTS(),
    });
    voice.on('error', (err) => errors.push(err));
    await voice.listen(0);
    const { ws } = await connect(voice.port!);
    sockets.push(ws);

    ws.send(JSON.stringify({ type: 'dance' }));
    ws.send(JSON.stringify({ type: 'text', text: '' }));
    ws.send('not json');

    await vi.waitFor(() => expect(errors).toHaveLength(3));
    expect(errors[0]!.message).toContain('Unknown control message type: dance');
    expect(errors[1]!.message).toContain('non-empty text');
    expect(errors[2]!.message).toContain('Invalid JSON');
  });

  it('does not crash when a client misbehaves and no error listener is attached', async () => {
    const { ws } = await start({
      mode: 'pipeline',
      agent: { run: vi.fn() },
      stt: createSTT(),
      tts: createTTS(),
    });

    ws.send('garbage');
    ws.send(JSON.stringify({ type: 'unknown' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(voice!.activeSessions).toBe(1);
  });

  it('emits session_end for every session when closed', async () => {
    voice = new VoiceAgent({
      mode: 'pipeline',
      agent: { run: vi.fn() },
      stt: createSTT(),
      tts: createTTS(),
    });
    const ended: string[] = [];
    voice.on('session_end', (id) => ended.push(id));
    await voice.listen(0);
    const a = await connect(voice.port!);
    const b = await connect(voice.port!);
    sockets.push(a.ws, b.ws);
    await vi.waitFor(() => expect(voice!.activeSessions).toBe(2));

    await voice.close();
    voice = undefined;

    expect(ended).toHaveLength(2);
  });

  it('throws when listen() is called twice', async () => {
    voice = new VoiceAgent({
      mode: 'pipeline',
      agent: { run: vi.fn() },
      stt: createSTT(),
      tts: createTTS(),
    });
    await voice.listen(0);
    await expect(voice.listen(0)).rejects.toThrow('already listening');
  });

  it('can attach to an existing HTTP server', async () => {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, () => r()));
    try {
      voice = new VoiceAgent({
        mode: 'pipeline',
        agent: { run: vi.fn() },
        stt: createSTT(),
        tts: createTTS(),
      });
      voice.attach(server);
      const { ws } = await connect((server.address() as AddressInfo).port);
      sockets.push(ws);
      await vi.waitFor(() => expect(voice!.activeSessions).toBe(1));
      await voice.close();
      voice = undefined;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  describe('realtime mode', () => {
    it('passes instructions (falling back to agent.instructions) and tools to the session', async () => {
      const tools = [{ name: 't', description: 'd', parameters: {}, execute: vi.fn() }];
      await start({
        mode: 'realtime',
        agent: { run: vi.fn(), instructions: 'from agent' },
        realtimeProvider: 'gemini',
        realtimeApiKey: 'key',
        realtimeModel: 'm',
        voice: 'Kore',
        tools,
      });
      await vi.waitFor(() => expect(realtimeSessions).toHaveLength(1));

      expect(realtimeSessions[0]!.config).toEqual({
        provider: 'gemini',
        apiKey: 'key',
        model: 'm',
        voice: 'Kore',
        instructions: 'from agent',
        tools,
      });
    });

    it('prefers explicit instructions over agent.instructions', async () => {
      await start({
        mode: 'realtime',
        agent: { run: vi.fn(), instructions: 'from agent' },
        instructions: 'explicit',
        realtimeProvider: 'openai',
        realtimeApiKey: 'key',
      });
      await vi.waitFor(() => expect(realtimeSessions).toHaveLength(1));
      expect(realtimeSessions[0]!.config.instructions).toBe('explicit');
    });

    it('routes text and interrupt control messages and forwards turn_end', async () => {
      const { ws, received } = await start({
        mode: 'realtime',
        agent: { run: vi.fn() },
        realtimeProvider: 'openai',
        realtimeApiKey: 'key',
      });
      await vi.waitFor(() => expect(realtimeSessions).toHaveLength(1));
      const session = realtimeSessions[0]!;

      ws.send(JSON.stringify({ type: 'text', text: 'hi' }));
      ws.send(JSON.stringify({ type: 'interrupt' }));
      await vi.waitFor(() => expect(session.interrupt).toHaveBeenCalledOnce());
      expect(session.sendText).toHaveBeenCalledWith('hi');

      session.emit('turn_end');
      await vi.waitFor(() => expect(received.messages).toContainEqual({ type: 'turn_end' }));
    });

    it('closes the client with 1011 when the realtime connection fails', async () => {
      mocks.state.connectImpl = async () => {
        throw new Error('401 invalid api key');
      };
      voice = new VoiceAgent({
        mode: 'realtime',
        agent: { run: vi.fn() },
        realtimeProvider: 'openai',
        realtimeApiKey: 'bad',
      });
      const errors: Error[] = [];
      voice.on('error', (err) => errors.push(err));
      await voice.listen(0);
      const { ws } = await connect(voice.port!);
      sockets.push(ws);

      const result = await closed(ws);
      expect(result.code).toBe(1011);
      expect(result.reason).toContain('Realtime connect failed: 401 invalid api key');
      expect(errors.map((e) => e.message)).toEqual(['401 invalid api key']);
    });

    it('closes the client with 1011 when the provider disconnects', async () => {
      const { ws } = await start({
        mode: 'realtime',
        agent: { run: vi.fn() },
        realtimeProvider: 'gemini',
        realtimeApiKey: 'key',
      });
      await vi.waitFor(() => expect(realtimeSessions).toHaveLength(1));
      const done = closed(ws);

      realtimeSessions[0]!.emit('disconnected', 1008, 'policy violation');

      const result = await done;
      expect(result.code).toBe(1011);
      expect(result.reason).toBe('Realtime provider disconnected (1008): policy violation');
      await vi.waitFor(() => expect(realtimeSessions[0]!.close).toHaveBeenCalled());
    });
  });
});
