import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { STTProvider, TTSProvider } from '../types';

function createMockSTT(): STTProvider {
  return {
    name: 'mock-stt',
    transcribe: vi.fn().mockResolvedValue({ text: 'hello' }),
    createStream: vi.fn().mockReturnValue({
      write: vi.fn(),
      close: vi.fn().mockResolvedValue({ text: 'hello' }),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
    }),
  };
}

function createMockTTS(): TTSProvider {
  return {
    name: 'mock-tts',
    synthesize: vi.fn().mockResolvedValue(Buffer.from('audio')),
    streamSynthesize: vi.fn().mockImplementation(async function* () {
      yield Buffer.from('chunk');
    }),
  };
}

function createMockAgent() {
  return { run: vi.fn().mockResolvedValue({ content: 'response' }) };
}

function connectWs(port: number, path = '/voice'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on('close', () => resolve());
    ws.close();
  });
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { VoiceAgent } from '../voice-agent';

describe('VoiceAgent', () => {
  let agent: VoiceAgent;
  const openSockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets.length = 0;
    if (agent) await agent.close();
  });

  async function connect(port: number, path = '/voice'): Promise<WebSocket> {
    const ws = await connectWs(port, path);
    openSockets.push(ws);
    return ws;
  }

  describe('constructor validation', () => {
    it('throws if pipeline mode is missing stt', () => {
      expect(
        () =>
          new VoiceAgent({
            agent: createMockAgent(),
            mode: 'pipeline',
            tts: createMockTTS(),
          })
      ).toThrow(/stt.*required/i);
    });

    it('throws if pipeline mode is missing tts', () => {
      expect(
        () =>
          new VoiceAgent({
            agent: createMockAgent(),
            mode: 'pipeline',
            stt: createMockSTT(),
          })
      ).toThrow(/tts.*required/i);
    });

    it('throws if realtime mode is missing realtimeProvider', () => {
      expect(
        () =>
          new VoiceAgent({
            agent: createMockAgent(),
            mode: 'realtime',
            realtimeApiKey: 'key',
          })
      ).toThrow(/realtimeProvider.*required/i);
    });

    it('throws if realtime mode is missing realtimeApiKey', () => {
      expect(
        () =>
          new VoiceAgent({
            agent: createMockAgent(),
            mode: 'realtime',
            realtimeProvider: 'openai',
          })
      ).toThrow(/realtimeApiKey.*required/i);
    });

    it('accepts valid pipeline config', () => {
      const a = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      expect(a).toBeInstanceOf(VoiceAgent);
    });

    it('accepts valid realtime config', () => {
      const a = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'realtime',
        realtimeProvider: 'openai',
        realtimeApiKey: 'test-key',
      });
      expect(a).toBeInstanceOf(VoiceAgent);
    });
  });

  describe('listen() and port', () => {
    it('starts transport and exposes port', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });

      await agent.listen(0);
      expect(agent.port).toBeTypeOf('number');
      expect(agent.port).toBeGreaterThan(0);
    });

    it('port is undefined before listen', () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });

      expect(agent.port).toBeUndefined();
    });

    it('accepts ws connections after listen', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      await agent.listen(0);

      const ws = await connect(agent.port!);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('session lifecycle', () => {
    it('emits session_start on client connection', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      await agent.listen(0);

      const sessionPromise = new Promise<string>((resolve) => {
        agent.on('session_start', (id: string) => resolve(id));
      });

      await connect(agent.port!);
      const sessionId = await sessionPromise;
      expect(sessionId).toBeTypeOf('string');
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('emits session_end on client disconnect', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      await agent.listen(0);

      const startPromise = new Promise<string>((resolve) => {
        agent.on('session_start', (id: string) => resolve(id));
      });
      const endPromise = new Promise<string>((resolve) => {
        agent.on('session_end', (id: string) => resolve(id));
      });

      const ws = await connect(agent.port!);
      const startId = await startPromise;

      await closeWs(ws);
      openSockets.length = 0;
      const endId = await endPromise;

      expect(endId).toBe(startId);
    });

    it('tracks activeSessions count', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      await agent.listen(0);
      expect(agent.activeSessions).toBe(0);

      const ws1 = await connect(agent.port!);
      await waitFor(50);
      expect(agent.activeSessions).toBe(1);

      const ws2 = await connect(agent.port!);
      await waitFor(50);
      expect(agent.activeSessions).toBe(2);

      await closeWs(ws1);
      openSockets.splice(openSockets.indexOf(ws1), 1);
      await waitFor(50);
      expect(agent.activeSessions).toBe(1);

      await closeWs(ws2);
      openSockets.splice(openSockets.indexOf(ws2), 1);
      await waitFor(50);
      expect(agent.activeSessions).toBe(0);
    });
  });

  describe('pipeline mode wiring', () => {
    it('forwards client audio to pipeline session', async () => {
      const stt = createMockSTT();
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt,
        tts: createMockTTS(),
      });
      await agent.listen(0);

      const sessionPromise = new Promise<void>((resolve) => {
        agent.on('session_start', () => resolve());
      });
      const ws = await connect(agent.port!);
      await sessionPromise;

      ws.send(Buffer.alloc(320));
      await waitFor(100);

      expect(stt.createStream).toHaveBeenCalled();
    });

    it('creates separate pipeline session per client', async () => {
      const stt = createMockSTT();
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt,
        tts: createMockTTS(),
      });
      await agent.listen(0);

      await connect(agent.port!);
      await connect(agent.port!);
      await waitFor(50);

      expect(agent.activeSessions).toBe(2);
    });
  });

  describe('close()', () => {
    it('shuts down transport', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      await agent.listen(0);
      const port = agent.port!;

      await agent.close();

      await expect(connectWs(port)).rejects.toThrow();
    });

    it('disconnects active clients', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      await agent.listen(0);

      const ws = await connect(agent.port!);
      await waitFor(50);

      const closePromise = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });

      await agent.close();
      await closePromise;

      expect(ws.readyState).toBe(WebSocket.CLOSED);
      openSockets.length = 0;
    });

    it('resets activeSessions to 0', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      await agent.listen(0);

      await connect(agent.port!);
      await waitFor(50);
      expect(agent.activeSessions).toBe(1);

      await agent.close();
      expect(agent.activeSessions).toBe(0);
    });
  });

  describe('error handling', () => {
    it('emits error when session encounters an error', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
      });
      await agent.listen(0);

      agent.on('error', () => {});

      await connect(agent.port!);
      await waitFor(50);
    });
  });

  describe('transport config passthrough', () => {
    it('passes transport config to WebSocketTransport', async () => {
      agent = new VoiceAgent({
        agent: createMockAgent(),
        mode: 'pipeline',
        stt: createMockSTT(),
        tts: createMockTTS(),
        transport: { path: '/custom', maxConnections: 5 },
      });
      await agent.listen(0);

      await expect(connectWs(agent.port!, '/voice')).rejects.toThrow();

      const ws = await connect(agent.port!, '/custom');
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });
  });
});
