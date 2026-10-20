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

function functionCallsDone(calls: Array<[name: string, callId: string, args: string]>): string {
  return JSON.stringify({
    type: 'response.done',
    response: {
      status: 'completed',
      output: calls.map(([name, call_id, args]) => ({
        type: 'function_call',
        name,
        call_id,
        arguments: args,
      })),
    },
  });
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

      expect(capturedUrl).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
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
      expect(sent.session).toEqual({
        type: 'realtime',
        instructions: 'You are a helpful assistant',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-live-transcribe' },
            turn_detection: { type: 'server_vad' },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: 'alloy',
          },
        },
      });
    });

    it('uses default voice "marin" when none specified', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.session.audio.output.voice).toBe('marin');
    });

    it('URL-encodes the model name', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig({ model: 'a&b=c' }));
      await adapter.connect();
      expect(capturedUrl).toBe('wss://api.openai.com/v1/realtime?model=a%26b%3Dc');
    });

    it('emits disconnected only after a successful connection', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      const disconnected = vi.fn();
      adapter.on('disconnected', disconnected);
      await adapter.connect();

      mockWs.emit('close', 1006, Buffer.from(''));
      expect(disconnected).toHaveBeenCalledWith(1006, 'connection closed');
      expect(adapter.isConnected).toBe(false);
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
    it('sends response.cancel while a response is active', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      mockWs.emit('message', JSON.stringify({ type: 'response.created', response: {} }));
      adapter.interrupt();

      expect(mockWs.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(sent.type).toBe('response.cancel');
    });

    it('does not send response.cancel when no response is active', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();
      mockWs.send.mockClear();

      adapter.interrupt();
      mockWs.emit('message', JSON.stringify({ type: 'response.created', response: {} }));
      mockWs.emit(
        'message',
        JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [] } })
      );
      adapter.interrupt();

      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe('incoming events', () => {
    it('emits audio on response.output_audio.delta', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('audio', handler);

      const audioData = Buffer.from('hello-audio').toString('base64');
      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'response.output_audio.delta',
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

    it('emits transcript for assistant on response.output_audio_transcript.done', async () => {
      adapter = new OpenAIRealtimeAdapter(createConfig());
      await adapter.connect();

      const handler = vi.fn();
      adapter.on('transcript', handler);

      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'response.output_audio_transcript.done',
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
        functionCallsDone([['get_weather', 'call_abc123', '{"city":"London"}']])
      );

      await vi.waitFor(() =>
        expect(executeFn).toHaveBeenCalledWith(
          { city: 'London' },
          { callId: 'call_abc123', signal: expect.any(AbortSignal) }
        )
      );

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

    describe('a result made of parts', () => {
      const PNG =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const screenshotTool = () => ({
        name: 'screenshot',
        description: 'Screenshot a page',
        parameters: {},
        execute: vi.fn().mockResolvedValue({
          type: 'tool-content',
          content: [
            { type: 'text', text: 'Screenshot of example.com' },
            { type: 'json', value: { width: 1 } },
            { type: 'image', data: PNG, mediaType: 'image/png' },
          ],
        }),
      });

      const sentEvents = () =>
        mockWs.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>);

      it('reaches the model as the text of its parts, the image described', async () => {
        adapter = new OpenAIRealtimeAdapter(createConfig({ tools: [screenshotTool()] }));
        await adapter.connect();
        mockWs.send.mockClear();

        mockWs.emit('message', functionCallsDone([['screenshot', 'call_s', '{}']]));
        await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));

        const [output, response] = sentEvents();
        expect((output!.item as { output: string }).output).toBe(
          'Screenshot of example.com\n{"width":1}\n[image/png image, 70 B]'
        );
        expect(JSON.stringify(output)).not.toContain(PNG);
        expect(response!.type).toBe('response.create');
      });

      it('sends the images as input_image parts with toolImages', async () => {
        adapter = new OpenAIRealtimeAdapter(
          createConfig({ tools: [screenshotTool()], toolImages: true })
        );
        await adapter.connect();
        mockWs.send.mockClear();

        mockWs.emit('message', functionCallsDone([['screenshot', 'call_s', '{}']]));
        await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(3));

        const [output, images, response] = sentEvents();
        expect((output!.item as { type: string }).type).toBe('function_call_output');
        expect(images!.item).toEqual({
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Images returned by the screenshot tool:' },
            { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
          ],
        });
        expect(response!.type).toBe('response.create');
      });

      it('keeps images in formats a model does not take out of the input_image parts', async () => {
        const tools = [
          {
            name: 'draw',
            description: 'Draw',
            parameters: {},
            execute: vi.fn().mockResolvedValue({
              type: 'tool-content',
              content: [{ type: 'image', data: 'PHN2Zz4=', mediaType: 'image/svg+xml' }],
            }),
          },
        ];
        adapter = new OpenAIRealtimeAdapter(createConfig({ tools, toolImages: true }));
        await adapter.connect();
        mockWs.send.mockClear();

        mockWs.emit('message', functionCallsDone([['draw', 'call_svg', '{}']]));
        await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));

        const [output, response] = sentEvents();
        expect((output!.item as { output: string }).output).toBe('[image/svg+xml image, 5 B]');
        expect(response!.type).toBe('response.create');
      });

      it('cuts a huge error message like a result', async () => {
        const tools = [
          {
            name: 'boom',
            description: 'Boom',
            parameters: {},
            maxResultLength: 200,
            execute: vi.fn().mockRejectedValue(new Error(`stderr: ${'e'.repeat(10_000)}`)),
          },
        ];
        adapter = new OpenAIRealtimeAdapter(createConfig({ tools }));
        await adapter.connect();
        mockWs.send.mockClear();

        mockWs.emit('message', functionCallsDone([['boom', 'call_boom', '{}']]));
        await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));

        const output = JSON.parse((sentEvents()[0]!.item as { output: string }).output) as {
          error: string;
        };
        expect(output.error.length).toBeLessThan(300);
        expect(output.error).toContain('were left out');
      });

      it.each([0, -1, 2.5, Number.NaN])(
        'refuses a tool with maxResultLength %s when the session is created',
        (maxResultLength) => {
          const tools = [
            { name: 't', description: 'd', parameters: {}, execute: vi.fn(), maxResultLength },
          ];
          expect(() => new OpenAIRealtimeAdapter(createConfig({ tools }))).toThrow(
            /maxResultLength of realtime tool "t" must be a positive integer/
          );
        }
      );

      it('answers null for a result JSON cannot hold', async () => {
        const tools = [
          {
            name: 'odd',
            description: 'Odd',
            parameters: {},
            execute: vi.fn().mockResolvedValue(() => 'a function'),
          },
        ];
        adapter = new OpenAIRealtimeAdapter(createConfig({ tools }));
        await adapter.connect();
        mockWs.send.mockClear();

        mockWs.emit('message', functionCallsDone([['odd', 'call_odd', '{}']]));
        await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));

        expect((sentEvents()[0]!.item as { output: string }).output).toBe('null');
      });

      it("cuts a long result to the tool's maxResultLength", async () => {
        const tools = [
          {
            name: 'dump',
            description: 'Dump',
            parameters: {},
            maxResultLength: 100,
            execute: vi.fn().mockResolvedValue('x'.repeat(5000)),
          },
        ];
        adapter = new OpenAIRealtimeAdapter(createConfig({ tools }));
        await adapter.connect();
        mockWs.send.mockClear();

        mockWs.emit('message', functionCallsDone([['dump', 'call_d', '{}']]));
        await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));

        const output = (sentEvents()[0]!.item as { output: string }).output;
        expect(output.length).toBeLessThan(200);
        expect(output).toContain('characters of this tool result were left out');
      });
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

      mockWs.emit('message', functionCallsDone([['failing_tool', 'call_fail', '{}']]));

      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));

      const itemCreate = JSON.parse(mockWs.send.mock.calls[0]![0] as string);
      expect(itemCreate.item.output).toContain('Tool exploded');

      const responseCreate = JSON.parse(mockWs.send.mock.calls[1]![0] as string);
      expect(responseCreate.type).toBe('response.create');
    });

    it('answers all calls of a response before a single response.create', async () => {
      const tools = [
        {
          name: 'echo',
          description: 'Echo',
          parameters: {},
          execute: vi.fn().mockImplementation(async (args: unknown) => args),
        },
      ];
      adapter = new OpenAIRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();
      mockWs.send.mockClear();
      const turnEnd = vi.fn();
      adapter.on('turn_end', turnEnd);

      mockWs.emit(
        'message',
        functionCallsDone([
          ['echo', 'c1', '{"n":1}'],
          ['unknown_tool', 'c2', '{}'],
          ['echo', 'c3', 'not json'],
        ])
      );

      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(4));
      const sent = mockWs.send.mock.calls.map((c) => JSON.parse(c[0] as string));
      expect(sent.slice(0, 3).map((m) => [m.item.call_id, JSON.parse(m.item.output)])).toEqual([
        ['c1', { n: 1 }],
        ['c2', { error: 'Unknown tool: unknown_tool' }],
        ['c3', { error: 'Invalid JSON arguments for tool echo' }],
      ]);
      expect(sent[3].type).toBe('response.create');
      expect(turnEnd).not.toHaveBeenCalled();
    });

    it('serializes undefined tool results as null', async () => {
      const tools = [
        {
          name: 'noop',
          description: 'Noop',
          parameters: {},
          execute: vi.fn().mockResolvedValue(undefined),
        },
      ];
      adapter = new OpenAIRealtimeAdapter(createConfig({ tools }));
      await adapter.connect();
      mockWs.send.mockClear();

      mockWs.emit('message', functionCallsDone([['noop', 'c1', '{}']]));

      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(2));
      expect(JSON.parse(mockWs.send.mock.calls[0]![0] as string).item.output).toBe('null');
    });

    it('does not execute tools from cancelled responses and emits turn_end', async () => {
      const execute = vi.fn();
      adapter = new OpenAIRealtimeAdapter(
        createConfig({ tools: [{ name: 'x', description: 'x', parameters: {}, execute }] })
      );
      await adapter.connect();
      const turnEnd = vi.fn();
      adapter.on('turn_end', turnEnd);

      mockWs.emit(
        'message',
        JSON.stringify({
          type: 'response.done',
          response: {
            status: 'cancelled',
            output: [{ type: 'function_call', name: 'x', call_id: 'c', arguments: '{}' }],
          },
        })
      );

      expect(execute).not.toHaveBeenCalled();
      expect(turnEnd).toHaveBeenCalledOnce();
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
