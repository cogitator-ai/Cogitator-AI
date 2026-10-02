import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RealtimeSessionConfig } from '../../types.js';

type MockWebSocket = EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
  OPEN: number;
};

let mockWs: MockWebSocket;
let capturedUrl: string;
let capturedOptions: Record<string, unknown> | undefined;

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('node:events');
  class MockWS extends EE {
    static OPEN = 1;
    send = vi.fn();
    close = vi.fn();
    readyState = 1;
    OPEN = 1;

    constructor(url: string, options?: Record<string, unknown>) {
      super();
      capturedUrl = url;
      capturedOptions = options;
      mockWs = this as unknown as MockWebSocket;
      setTimeout(() => {
        this.emit('open');
        setTimeout(() => {
          this.emit('message', JSON.stringify({ setupComplete: {} }));
        }, 0);
      }, 0);
    }
  }
  return { WebSocket: MockWS };
});

import { GeminiRealtimeAdapter } from '../../realtime/gemini-realtime.js';

function createConfig(overrides?: Partial<RealtimeSessionConfig>): RealtimeSessionConfig {
  return {
    provider: 'gemini',
    apiKey: 'test-gemini-key',
    ...overrides,
  };
}

describe('GeminiRealtimeAdapter', () => {
  let adapter: GeminiRealtimeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    adapter?.close();
  });

  describe('connect()', () => {
    it('opens WebSocket and authenticates via x-goog-api-key header (key not in URL)', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      expect(capturedUrl).toBe(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
      );
      expect(capturedOptions).toEqual({ headers: { 'x-goog-api-key': 'test-gemini-key' } });
    });

    it('enables input and output audio transcription in setup', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.setup.inputAudioTranscription).toEqual({});
      expect(sent.setup.outputAudioTranscription).toEqual({});
    });

    it('rejects connect() on server error before setupComplete without emitting error', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      const errorHandler = vi.fn();
      adapter.on('error', errorHandler);
      const promise = adapter.connect();
      mockWs.emit('message', JSON.stringify({ error: { code: 400, message: 'bad model' } }));
      await expect(promise).rejects.toThrow('bad model');
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('emits disconnected only after a successful connection', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      const disconnected = vi.fn();
      adapter.on('disconnected', disconnected);
      await adapter.connect();
      expect(adapter.isConnected).toBe(true);

      mockWs.emit('close', 1011, Buffer.from('internal'));
      expect(disconnected).toHaveBeenCalledWith(1011, 'internal');
      expect(adapter.isConnected).toBe(false);
    });

    it('sends setup message with model, voice, and response modalities', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const setupCall = mockWs.send.mock.calls[0]![0] as string;
      const sent = JSON.parse(setupCall);

      expect(sent.setup.model).toBe('models/gemini-3.8-live');
      expect(sent.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
      expect(
        sent.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName
      ).toBe('Puck');
    });

    it('uses custom model', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig({ model: 'gemini-2.0-flash-live' }));
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.setup.model).toBe('models/gemini-2.0-flash-live');
    });

    it('uses custom voice', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig({ voice: 'Kore' }));
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(
        sent.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName
      ).toBe('Kore');
    });

    it('includes system instruction when provided', async () => {
      adapter = new GeminiRealtimeAdapter(
        createConfig({ instructions: 'You are a pirate assistant' })
      );
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.setup.systemInstruction).toEqual({
        parts: [{ text: 'You are a pirate assistant' }],
      });
    });

    it('does not include systemInstruction when no instructions provided', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.setup.systemInstruction).toBeUndefined();
    });

    it('maps tools to Gemini functionDeclarations format', async () => {
      const tools = [
        {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          execute: vi.fn(),
        },
      ];

      adapter = new GeminiRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.setup.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get current weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        },
      ]);
    });

    it('waits for setupComplete before resolving', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());

      let resolved = false;
      const promise = adapter.connect().then(() => {
        resolved = true;
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(resolved).toBe(false);

      await promise;
      expect(resolved).toBe(true);
    });

    it('emits connected event', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      const handler = vi.fn();
      adapter.on('connected', handler);

      await adapter.connect();

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('pushAudio()', () => {
    it('sends realtimeInput with base64 audio', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      const audio = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      adapter.pushAudio(audio);

      expect(mockWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.realtimeInput).toEqual({
        audio: { mimeType: 'audio/pcm;rate=16000', data: audio.toString('base64') },
      });
    });
  });

  describe('sendText()', () => {
    it('sends realtimeInput text', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      adapter.sendText('Hello Gemini');

      expect(mockWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent).toEqual({ realtimeInput: { text: 'Hello Gemini' } });
    });
  });

  describe('interrupt()', () => {
    const audioMessage = JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }] },
      },
    });

    it('is a no-op when no model turn is in progress (does not drop the next turn)', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const audioChunks: Buffer[] = [];
      adapter.on('audio', (chunk) => audioChunks.push(chunk));

      adapter.interrupt();
      mockWs.emit('message', audioMessage);
      mockWs.emit('message', audioMessage);

      expect(audioChunks).toHaveLength(2);
    });

    it('drops inbound audio until turnComplete', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const audioChunks: Buffer[] = [];
      adapter.on('audio', (chunk) => audioChunks.push(chunk));

      mockWs.emit('message', audioMessage);
      expect(audioChunks).toHaveLength(1);
      audioChunks.length = 0;

      adapter.interrupt();

      mockWs.emit(
        'message',
        JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }] },
          },
        })
      );
      expect(audioChunks).toHaveLength(0);

      mockWs.emit('message', JSON.stringify({ serverContent: { turnComplete: true } }));

      mockWs.emit(
        'message',
        JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }] },
          },
        })
      );
      expect(audioChunks).toHaveLength(1);
    });
  });

  describe('incoming events', () => {
    it('emits audio when serverContent contains inlineData', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('audio', handler);

      const audioData = Buffer.from('gemini-audio').toString('base64');
      mockWs.emit(
        'message',
        JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audioData } }],
            },
          },
        })
      );

      expect(handler).toHaveBeenCalledOnce();
      const received = handler.mock.calls[0]![0] as Buffer;
      expect(Buffer.isBuffer(received)).toBe(true);
      expect(received.toString()).toBe('gemini-audio');
    });

    it('emits assistant text parts as a transcript on turnComplete', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('transcript', handler);

      mockWs.emit(
        'message',
        JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [{ text: 'The weather is sunny.' }],
            },
          },
        })
      );
      expect(handler).not.toHaveBeenCalled();

      mockWs.emit('message', JSON.stringify({ serverContent: { turnComplete: true } }));
      expect(handler).toHaveBeenCalledWith('The weather is sunny.', 'assistant');
    });

    it('ignores thought parts (native-audio thinking is not a transcript)', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('transcript', handler);

      mockWs.emit(
        'message',
        JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ text: '**Thinking about it**', thought: true }] },
          },
        })
      );
      mockWs.emit(
        'message',
        JSON.stringify({ serverContent: { outputTranscription: { text: 'Four.' } } })
      );
      mockWs.emit('message', JSON.stringify({ serverContent: { turnComplete: true } }));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('Four.', 'assistant');
    });

    it('accumulates streamed transcriptions and emits user before assistant', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      const turnEnd = vi.fn();
      adapter.on('transcript', handler);
      adapter.on('turn_end', turnEnd);

      const send = (serverContent: Record<string, unknown>) =>
        mockWs.emit('message', JSON.stringify({ serverContent }));

      send({ inputTranscription: { text: 'What is' } });
      send({ inputTranscription: { text: ' two plus two?' } });
      send({ outputTranscription: { text: 'Two plus' } });
      send({ outputTranscription: { text: ' two is four.' } });
      send({ turnComplete: true });

      expect(handler.mock.calls).toEqual([
        ['What is two plus two?', 'user'],
        ['Two plus two is four.', 'assistant'],
      ]);
      expect(turnEnd).toHaveBeenCalledOnce();
    });

    it('emits speech_start and flushes the partial transcript when interrupted', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const transcripts = vi.fn();
      const speechStart = vi.fn();
      adapter.on('transcript', transcripts);
      adapter.on('speech_start', speechStart);

      mockWs.emit(
        'message',
        JSON.stringify({ serverContent: { outputTranscription: { text: 'Once upon' } } })
      );
      mockWs.emit('message', JSON.stringify({ serverContent: { interrupted: true } }));

      expect(speechStart).toHaveBeenCalledOnce();
      expect(transcripts).toHaveBeenCalledWith('Once upon', 'assistant');
    });

    it('emits error on WebSocket error', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('error', handler);

      mockWs.emit('error', new Error('Connection lost'));

      expect(handler).toHaveBeenCalledOnce();
      const err = handler.mock.calls[0]![0] as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Connection lost');
    });
  });

  describe('tool execution', () => {
    it('executes tool and sends toolResponse back', async () => {
      const executeFn = vi.fn().mockResolvedValue({ temperature: 22, unit: 'celsius' });
      const tools = [
        {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          execute: executeFn,
        },
      ];

      adapter = new GeminiRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();
      mockWs.send.mockClear();

      const toolCallHandler = vi.fn();
      adapter.on('tool_call', toolCallHandler);

      mockWs.emit(
        'message',
        JSON.stringify({
          toolCall: {
            functionCalls: [
              {
                id: 'call_gem_123',
                name: 'get_weather',
                args: { city: 'London' },
              },
            ],
          },
        })
      );

      await vi.waitFor(() => expect(executeFn).toHaveBeenCalledWith({ city: 'London' }));

      expect(toolCallHandler).toHaveBeenCalledWith('get_weather', { city: 'London' });

      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(1));

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.toolResponse.functionResponses).toEqual([
        {
          id: 'call_gem_123',
          name: 'get_weather',
          response: { result: { temperature: 22, unit: 'celsius' } },
        },
      ]);
    });

    it('sends error result when tool execution fails', async () => {
      const tools = [
        {
          name: 'failing_tool',
          description: 'A tool that fails',
          parameters: {},
          execute: vi.fn().mockRejectedValue(new Error('Tool exploded')),
        },
      ];

      adapter = new GeminiRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();
      mockWs.send.mockClear();

      mockWs.emit(
        'message',
        JSON.stringify({
          toolCall: {
            functionCalls: [
              {
                id: 'call_fail',
                name: 'failing_tool',
                args: {},
              },
            ],
          },
        })
      );

      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(1));

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.toolResponse.functionResponses[0].response).toEqual({ error: 'Tool exploded' });
    });

    it('responds with an error for unknown tools and null for undefined results', async () => {
      const tools = [
        {
          name: 'void_tool',
          description: 'Returns nothing',
          parameters: {},
          execute: vi.fn().mockResolvedValue(undefined),
        },
      ];

      adapter = new GeminiRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();
      mockWs.send.mockClear();

      mockWs.emit(
        'message',
        JSON.stringify({
          toolCall: {
            functionCalls: [
              { id: 'a', name: 'void_tool', args: {} },
              { id: 'b', name: 'missing_tool' },
            ],
          },
        })
      );

      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(1));
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.toolResponse.functionResponses).toEqual([
        { id: 'a', name: 'void_tool', response: { result: null } },
        { id: 'b', name: 'missing_tool', response: { error: 'Unknown tool: missing_tool' } },
      ]);
    });
  });

  describe('close()', () => {
    it('closes the WebSocket', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      adapter.close();

      expect(mockWs.close).toHaveBeenCalledOnce();
    });

    it('is safe to call without connecting', () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      expect(() => adapter.close()).not.toThrow();
    });
  });

  describe('error resilience', () => {
    it('emits error on malformed JSON messages', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const errorHandler = vi.fn();
      adapter.on('error', errorHandler);

      mockWs.emit('message', 'not valid json {{{');

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler.mock.calls[0]![0].message).toBe('Failed to parse WebSocket message');
    });

    it('does not send when WebSocket is not open', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      mockWs.readyState = 3;

      adapter.sendText('should not send');
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });
});
