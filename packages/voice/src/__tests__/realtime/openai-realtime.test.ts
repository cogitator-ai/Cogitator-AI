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
let capturedOptions: Record<string, unknown>;

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('node:events');
  class MockWS extends EE {
    static OPEN = 1;
    send = vi.fn();
    close = vi.fn();
    readyState = 1;
    OPEN = 1;

    constructor(url: string, options: Record<string, unknown>) {
      super();
      capturedUrl = url;
      capturedOptions = options;
      mockWs = this as unknown as MockWebSocket;
      setTimeout(() => this.emit('open'), 0);
    }
  }
  return { WebSocket: MockWS };
});

import { OpenAIRealtimeAdapter } from '../../realtime/openai-realtime.js';

function createConfig(overrides?: Partial<RealtimeSessionConfig>): RealtimeSessionConfig {
  return {
    provider: 'openai',
    apiKey: 'test-key-123',
    ...overrides,
  };
}

describe('OpenAIRealtimeAdapter', () => {
  let adapter: OpenAIRealtimeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    adapter?.close();
  });

  describe('connect()', () => {
    it('opens WebSocket with correct URL and default model', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      expect(capturedUrl).toBe(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview'
      );
    });

    it('uses custom model in WebSocket URL', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig({ model: 'gpt-4o-realtime-preview' }));
      await adapter.connect();

      expect(capturedUrl).toBe('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview');
    });

    it('sends auth headers', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      expect(capturedOptions).toEqual(
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-key-123',
            'OpenAI-Beta': 'realtime=v1',
          },
        })
      );
    });

    it('sends session.update on open', async () => {
      adapter = new OpenAIRealtimeAdapter(
        createConfig({
          instructions: 'You are a helpful assistant',
          voice: 'alloy',
        })
      );
      await adapter.connect();

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.type).toBe('session.update');
      expect(sent.session.instructions).toBe('You are a helpful assistant');
      expect(sent.session.voice).toBe('alloy');
      expect(sent.session.input_audio_format).toBe('pcm16');
      expect(sent.session.output_audio_format).toBe('pcm16');
      expect(sent.session.turn_detection).toEqual({ type: 'server_vad' });
    });

    it('uses default voice "coral" when none specified', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.session.voice).toBe('coral');
    });

    it('maps tools to OpenAI function format in session.update', async () => {
      const tools = [
        {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          execute: vi.fn(),
        },
      ];

      adapter = new OpenAIRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.session.tools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get current weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ]);
    });

    it('emits connected event', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      const handler = vi.fn();
      adapter.on('connected', handler);

      await adapter.connect();

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('pushAudio()', () => {
    it('sends input_audio_buffer.append with base64 audio', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      const audio = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      adapter.pushAudio(audio);

      expect(mockWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.type).toBe('input_audio_buffer.append');
      expect(sent.audio).toBe(audio.toString('base64'));
    });
  });

  describe('sendText()', () => {
    it('sends conversation.item.create and response.create', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      adapter.sendText('Hello there');

      expect(mockWs.send).toHaveBeenCalledTimes(2);

      const itemCreate = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(itemCreate.type).toBe('conversation.item.create');
      expect(itemCreate.item.type).toBe('message');
      expect(itemCreate.item.role).toBe('user');
      expect(itemCreate.item.content).toEqual([{ type: 'input_text', text: 'Hello there' }]);

      const responseCreate = JSON.parse(mockWs.send.mock.calls[1]![0] as string);
      expect(responseCreate.type).toBe('response.create');
    });
  });

  describe('interrupt()', () => {
    it('sends response.cancel', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      adapter.interrupt();

      expect(mockWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.type).toBe('response.cancel');
    });
  });

  describe('incoming events', () => {
    it('emits audio on response.audio.delta', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('audio', handler);

      const audioData = Buffer.from('hello-audio').toString('base64');
      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'response.audio.delta',
          delta: audioData,
        })
      );

      expect(handler).toHaveBeenCalledOnce();
      const received = handler.mock.calls[0]![0] as Buffer;
      expect(Buffer.isBuffer(received)).toBe(true);
      expect(received.toString()).toBe('hello-audio');
    });

    it('emits transcript for user input audio transcription', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('transcript', handler);

      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'What is the weather?',
        })
      );

      expect(handler).toHaveBeenCalledWith('What is the weather?', 'user');
    });

    it('emits transcript for assistant when response.audio_transcript.done', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('transcript', handler);

      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'response.audio_transcript.done',
          transcript: 'The weather is sunny.',
        })
      );

      expect(handler).toHaveBeenCalledWith('The weather is sunny.', 'assistant');
    });

    it('emits speech_start on input_audio_buffer.speech_started', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('speech_start', handler);

      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'input_audio_buffer.speech_started',
        })
      );

      expect(handler).toHaveBeenCalledOnce();
    });

    it('emits error on error event', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('error', handler);

      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'error',
          error: { message: 'Something went wrong', code: 'server_error' },
        })
      );

      expect(handler).toHaveBeenCalledOnce();
      const err = handler.mock.calls[0]![0] as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('Something went wrong');
    });
  });

  describe('tool execution', () => {
    it('executes tool and sends result back', async () => {
      const executeFn = vi.fn().mockResolvedValue({ temperature: 22, unit: 'celsius' });
      const tools = [
        {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          execute: executeFn,
        },
      ];

      adapter = new OpenAIRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();
      mockWs.send.mockClear();

      const toolCallHandler = vi.fn();
      adapter.on('tool_call', toolCallHandler);

      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          name: 'get_weather',
          call_id: 'call_abc123',
          arguments: '{"city":"London"}',
        })
      );

      await vi.waitFor(() => expect(executeFn).toHaveBeenCalledWith({ city: 'London' }));

      expect(toolCallHandler).toHaveBeenCalledWith('get_weather', { city: 'London' });

      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));

      const itemCreate = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(itemCreate.type).toBe('conversation.item.create');
      expect(itemCreate.item.type).toBe('function_call_output');
      expect(itemCreate.item.call_id).toBe('call_abc123');
      expect(itemCreate.item.output).toBe(JSON.stringify({ temperature: 22, unit: 'celsius' }));

      const responseCreate = JSON.parse(mockWs.send.mock.calls[1]![0] as string);
      expect(responseCreate.type).toBe('response.create');
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

      adapter = new OpenAIRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();
      mockWs.send.mockClear();

      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          name: 'failing_tool',
          call_id: 'call_fail',
          arguments: '{}',
        })
      );

      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));

      const itemCreate = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(itemCreate.item.output).toContain('Tool exploded');

      const responseCreate = JSON.parse(mockWs.send.mock.calls[1]![0] as string);
      expect(responseCreate.type).toBe('response.create');
    });
  });

  describe('close()', () => {
    it('closes the WebSocket', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      adapter.close();

      expect(mockWs.close).toHaveBeenCalledOnce();
    });

    it('is safe to call without connecting', () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      expect(() => adapter.close()).not.toThrow();
    });
  });

  describe('error resilience', () => {
    it('emits error on malformed JSON messages', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const errorHandler = vi.fn();
      adapter.on('error', errorHandler);

      mockWs.emit('message', 'not valid json {{{');

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler.mock.calls[0]![0].message).toBe('Failed to parse WebSocket message');
    });

    it('does not send when WebSocket is not open', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      mockWs.readyState = 3;

      adapter.sendText('should not send');
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });
});
