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

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('node:events');
  class MockWS extends EE {
    static OPEN = 1;
    send = vi.fn();
    close = vi.fn();
    readyState = 1;
    OPEN = 1;

    constructor(url: string) {
      super();
      capturedUrl = url;
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
    it('opens WebSocket with correct URL including API key', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      expect(capturedUrl).toBe(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=test-gemini-key'
      );
    });

    it('sends setup message with model, voice, and response modalities', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();

      const setupCall = mockWs.send.mock.calls[0]![0] as string;
      const sent = JSON.parse(setupCall);

      expect(sent.setup.model).toBe('models/gemini-live-2.5-flash-native-audio');
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
      expect(sent.realtimeInput.mediaChunks).toEqual([
        {
          mimeType: 'audio/pcm;rate=16000',
          data: audio.toString('base64'),
        },
      ]);
    });
  });

  describe('sendText()', () => {
    it('sends clientContent with user turn', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      adapter.sendText('Hello Gemini');

      expect(mockWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.clientContent).toEqual({
        turns: [{ role: 'user', parts: [{ text: 'Hello Gemini' }] }],
        turnComplete: true,
      });
    });
  });

  describe('interrupt()', () => {
    it('sends empty clientContent to signal interruption', async () => {
      adapter = new GeminiRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      adapter.interrupt();

      expect(mockWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.clientContent).toEqual({ turnComplete: true });
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

    it('emits transcript when serverContent contains text', async () => {
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

      expect(handler).toHaveBeenCalledWith('The weather is sunny.', 'assistant');
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
          response: { result: JSON.stringify({ temperature: 22, unit: 'celsius' }) },
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
      expect(sent.toolResponse.functionResponses[0].response.result).toContain('Tool exploded');
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
