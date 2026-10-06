import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolCallMessage } from './helpers/messages';

const mockSend = vi.fn();
let shouldThrowOnConstruct = false;

class MockBedrockRuntimeClient {
  config: Record<string, unknown>;
  constructor(config: Record<string, unknown>) {
    if (shouldThrowOnConstruct) {
      throw new Error('SDK init failed');
    }
    this.config = config;
  }
  send = mockSend;
}

class MockConverseCommand {
  input: unknown;
  constructor(input: unknown) {
    this.input = input;
  }
}

class MockConverseStreamCommand {
  input: unknown;
  constructor(input: unknown) {
    this.input = input;
  }
}

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: MockBedrockRuntimeClient,
  ConverseCommand: MockConverseCommand,
  ConverseStreamCommand: MockConverseStreamCommand,
}));

vi.mock('../utils/image-fetch', () => ({
  fetchImageAsBase64: vi
    .fn()
    .mockResolvedValue({ data: 'base64imagedata', mediaType: 'image/png' }),
}));

import { BedrockBackend } from '../llm/bedrock';
import { getLogger } from '../logger';

describe('BedrockBackend', () => {
  let backend: BedrockBackend;

  beforeEach(() => {
    backend = new BedrockBackend({
      region: 'us-east-1',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
    });
    mockSend.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    shouldThrowOnConstruct = false;
  });

  describe('constructor', () => {
    it('creates instance with config', () => {
      const b = new BedrockBackend({ region: 'eu-west-1' });
      expect(b).toBeInstanceOf(BedrockBackend);
    });

    it('creates instance with empty config', () => {
      const b = new BedrockBackend({});
      expect(b).toBeInstanceOf(BedrockBackend);
    });
  });

  it('provider is bedrock', () => {
    expect(backend.provider).toBe('bedrock');
  });

  describe('chat', () => {
    it('sends request and returns response', async () => {
      mockSend.mockResolvedValueOnce({
        output: {
          message: {
            content: [{ text: 'Hello from Bedrock!' }],
          },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      const response = await backend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('Hello from Bedrock!');
      expect(response.finishReason).toBe('stop');
      expect(response.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0] as MockConverseCommand;
      expect(command).toBeInstanceOf(MockConverseCommand);
    });

    it('sends the image of a tool result inside its toolResult block', async () => {
      mockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'ok' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });

      await backend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [
          { role: 'user', content: 'Look' },
          toolCallMessage([{ id: 't1', name: 'screenshot', arguments: {} }]),
          {
            role: 'tool',
            content: [
              { type: 'text', text: '{"image":"(image attached)"}' },
              {
                type: 'image_base64',
                image_base64: { data: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' },
              },
            ],
            toolCallId: 't1',
            name: 'screenshot',
          },
        ],
      });

      const command = mockSend.mock.calls[0][0] as MockConverseCommand;
      const { messages } = command.input as {
        messages: { content: { toolResult?: { content: unknown[] } }[] }[];
      };
      expect(messages[2].content[0].toolResult?.content).toEqual([
        { text: '{"image":"(image attached)"}' },
        {
          image: {
            format: 'png',
            source: {
              bytes: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUg=='), (c) => c.charCodeAt(0)),
            },
          },
        },
      ]);
    });

    it('passes abort signal to AWS request options', async () => {
      mockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'OK' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      });
      const controller = new AbortController();

      await backend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Hello' }],
        signal: controller.signal,
      });

      expect(mockSend).toHaveBeenCalledWith(expect.any(MockConverseCommand), {
        abortSignal: controller.signal,
      });
    });

    it('extracts system message and sends separately', async () => {
      mockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'OK' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      });

      await backend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      });

      const command = mockSend.mock.calls[0][0] as MockConverseCommand;
      const input = command.input as Record<string, unknown>;
      expect(input.system).toEqual([{ text: 'You are helpful.' }]);
      expect(input.messages as Array<{ role: string }>).toHaveLength(1);
    });

    it('passes inference config', async () => {
      mockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'OK' }] } },
        stopReason: 'end_turn',
        usage: {},
      });

      await backend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.7,
        maxTokens: 500,
        topP: 0.9,
        stop: ['END'],
      });

      const command = mockSend.mock.calls[0][0] as MockConverseCommand;
      const input = command.input as Record<string, unknown>;
      expect(input.inferenceConfig).toEqual({
        temperature: 0.7,
        maxTokens: 500,
        topP: 0.9,
        stopSequences: ['END'],
      });
    });

    describe('sampling parameters per model', () => {
      const respondOk = () =>
        mockSend.mockResolvedValueOnce({
          output: { message: { content: [{ text: 'OK' }] } },
          stopReason: 'end_turn',
          usage: {},
        });

      const sentInferenceConfig = () => {
        const command = mockSend.mock.calls[0][0] as MockConverseCommand;
        return (command.input as Record<string, unknown>).inferenceConfig;
      };

      it.each([
        'anthropic.claude-sonnet-5-5',
        'global.anthropic.claude-sonnet-5-5',
        'us.anthropic.claude-opus-5-5',
        'eu.anthropic.claude-opus-4-7',
        'anthropic.claude-fable-5-1',
        'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8',
      ])('omits temperature and topP for %s', async (model) => {
        respondOk();

        await backend.chat({
          model,
          messages: [{ role: 'user', content: 'Test' }],
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 500,
          stop: ['END'],
        });

        expect(sentInferenceConfig()).toEqual({ maxTokens: 500, stopSequences: ['END'] });
      });

      it('omits inferenceConfig entirely when only sampling params were set', async () => {
        respondOk();

        await backend.chat({
          model: 'anthropic.claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'Test' }],
          temperature: 0.7,
        });

        expect(sentInferenceConfig()).toBeUndefined();
      });

      it.each([
        'anthropic.claude-sonnet-4-6',
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      ])('sends only temperature when both are set for %s', async (model) => {
        respondOk();

        await backend.chat({
          model,
          messages: [{ role: 'user', content: 'Test' }],
          temperature: 0.7,
          topP: 0.9,
        });

        expect(sentInferenceConfig()).toEqual({ temperature: 0.7 });
      });

      it('passes both params through to non-Claude models', async () => {
        respondOk();

        await backend.chat({
          model: 'meta.llama3-3-70b-instruct-v1:0',
          messages: [{ role: 'user', content: 'Test' }],
          temperature: 0.7,
          topP: 0.9,
        });

        expect(sentInferenceConfig()).toEqual({ temperature: 0.7, topP: 0.9 });
      });

      it('omits sampling params from streaming requests to new Claude models', async () => {
        mockSend.mockResolvedValueOnce({
          stream: (async function* () {
            yield { messageStop: { stopReason: 'end_turn' } };
          })(),
        });

        for await (const _ of backend.chatStream({
          model: 'global.anthropic.claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'Hi' }],
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 100,
        })) {
          /* consume stream */
        }

        const command = mockSend.mock.calls[0][0] as MockConverseStreamCommand;
        expect((command.input as Record<string, unknown>).inferenceConfig).toEqual({
          maxTokens: 100,
        });
      });
    });

    it('returns tool calls from response', async () => {
      mockSend.mockResolvedValueOnce({
        output: {
          message: {
            content: [
              {
                toolUse: {
                  toolUseId: 'tool-1',
                  name: 'get_weather',
                  input: { city: 'Berlin' },
                },
              },
            ],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      });

      const response = await backend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Weather in Berlin?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      });

      expect(response.finishReason).toBe('tool_calls');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0]).toEqual({
        id: 'tool-1',
        name: 'get_weather',
        arguments: { city: 'Berlin' },
      });
    });

    it('serializes assistant tool calls before tool results', async () => {
      mockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'The weather is sunny.' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
      });

      await backend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          toolCallMessage([
            {
              id: 'tool-1',
              name: 'get_weather',
              arguments: { city: 'Berlin' },
            },
          ]),
          {
            role: 'tool',
            content: '{"temperature": 25, "condition": "sunny"}',
            toolCallId: 'tool-1',
            name: 'get_weather',
          },
        ],
      });

      const command = mockSend.mock.calls[0][0] as MockConverseCommand;
      const input = command.input as { messages: Array<{ role: string; content: unknown[] }> };
      expect(input.messages[1]).toEqual({
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 'tool-1',
              name: 'get_weather',
              input: { city: 'Berlin' },
            },
          },
        ],
      });
      expect(input.messages[2]).toEqual({
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'tool-1',
              content: [{ text: '{"temperature": 25, "condition": "sunny"}' }],
            },
          },
        ],
      });
    });

    it('handles connection errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('socket hang up'));

      await expect(
        backend.chat({
          model: 'anthropic.claude-3-sonnet-20240229-v1:0',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow(/socket hang up/);
    });

    it('maps stop reasons correctly', async () => {
      const cases = [
        { stopReason: 'end_turn', expected: 'stop' },
        { stopReason: 'tool_use', expected: 'stop' },
        { stopReason: 'max_tokens', expected: 'length' },
        { stopReason: 'stop_sequence', expected: 'stop' },
        { stopReason: 'model_context_window_exceeded', expected: 'length' },
        { stopReason: 'guardrail_intervened', expected: 'content_filter' },
        { stopReason: 'content_filtered', expected: 'content_filter' },
        { stopReason: 'refusal', expected: 'refusal' },
        { stopReason: 'something_else', expected: 'stop' },
      ];

      for (const { stopReason, expected } of cases) {
        mockSend.mockResolvedValueOnce({
          output: { message: { content: [{ text: 'OK' }] } },
          stopReason,
          usage: {},
        });

        const response = await backend.chat({
          model: 'anthropic.claude-3-sonnet-20240229-v1:0',
          messages: [{ role: 'user', content: 'Test' }],
        });

        expect(response.finishReason).toBe(expected);
      }
    });
  });

  describe('chatStream', () => {
    it('yields text chunks', async () => {
      async function* fakeStream() {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } };
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' world' } } };
        yield { messageStop: { stopReason: 'end_turn' } };
        yield { metadata: { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } } };
      }

      mockSend.mockResolvedValueOnce({ stream: fakeStream() });

      const texts: string[] = [];
      for await (const chunk of backend.chatStream({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.delta.content) texts.push(chunk.delta.content);
      }

      expect(texts).toEqual(['Hello', ' world']);
    });

    it('yields tool calls from stream', async () => {
      async function* fakeStream() {
        yield {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 'tc-1', name: 'search' } },
          },
        };
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"query":' } },
          },
        };
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '"cats"}' } },
          },
        };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { messageStop: { stopReason: 'tool_use' } };
      }

      mockSend.mockResolvedValueOnce({ stream: fakeStream() });

      const toolCalls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Search for cats' }],
      })) {
        if (chunk.delta.toolCalls) toolCalls.push(...chunk.delta.toolCalls);
      }

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        id: 'tc-1',
        name: 'search',
        arguments: { query: 'cats' },
      });
    });

    it('yields usage metadata', async () => {
      async function* fakeStream() {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'OK' } } };
        yield { messageStop: { stopReason: 'end_turn' } };
        yield { metadata: { usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } };
      }

      mockSend.mockResolvedValueOnce({ stream: fakeStream() });

      let finalUsage;
      for await (const chunk of backend.chatStream({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Test' }],
      })) {
        if (chunk.usage) finalUsage = chunk.usage;
      }

      expect(finalUsage).toEqual({ inputTokens: 5, outputTokens: 1, totalTokens: 6 });
    });
  });

  describe('client initialization', () => {
    it('failed client init is NOT cached forever', async () => {
      const freshBackend = new BedrockBackend({ region: 'us-east-1' });

      shouldThrowOnConstruct = true;
      await expect(
        freshBackend.chat({
          model: 'anthropic.claude-3-sonnet-20240229-v1:0',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow(/AWS SDK not installed/);

      shouldThrowOnConstruct = false;
      mockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'OK' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });

      const response = await freshBackend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Test' }],
      });

      expect(response.content).toBe('OK');
    });
  });

  describe('audit regressions', () => {
    const okResponse = {
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };

    it('merges parallel tool results into one user turn and joins system prompts', async () => {
      mockSend.mockResolvedValueOnce(okResponse);

      await backend.chat({
        model: 'anthropic.claude-3-sonnet',
        messages: [
          { role: 'system', content: 'Base' },
          { role: 'user', content: 'Weather?' },
          toolCallMessage([
            { id: 't1', name: 'weather', arguments: { city: 'Tokyo' } },
            { id: 't2', name: 'weather', arguments: { city: 'Paris' } },
          ]),
          { role: 'tool', content: 'sunny', toolCallId: 't1', name: 'weather' },
          { role: 'tool', content: 'rainy', toolCallId: 't2', name: 'weather' },
          { role: 'system', content: 'Reflection' },
        ],
      });

      const input = mockSend.mock.calls[0][0].input as {
        system: Array<{ text: string }>;
        messages: Array<{ role: string; content: unknown[] }>;
      };
      expect(input.system).toEqual([{ text: 'Base\n\nReflection' }]);
      expect(input.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(input.messages[2].content).toEqual([
        { toolResult: { toolUseId: 't1', content: [{ text: 'sunny' }] } },
        { toolResult: { toolUseId: 't2', content: [{ text: 'rainy' }] } },
      ]);
    });

    it('wraps errors thrown while iterating the stream', async () => {
      async function* failingStream() {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi' } } };
        throw new Error('ThrottlingException: Rate exceeded');
      }
      mockSend.mockResolvedValueOnce({ stream: failingStream() });

      const consume = async () => {
        for await (const _ of backend.chatStream({
          model: 'anthropic.claude-3-sonnet',
          messages: [{ role: 'user', content: 'x' }],
        })) {
          /* consume stream */
        }
      };

      await expect(consume()).rejects.toMatchObject({ name: 'LLMError' });
    });

    it('treats empty streamed tool input as empty arguments', async () => {
      async function* toolStream() {
        yield {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 't1', name: 'now' } },
          },
        };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { messageStop: { stopReason: 'tool_use' } };
      }
      mockSend.mockResolvedValueOnce({ stream: toolStream() });

      const calls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'anthropic.claude-3-sonnet',
        messages: [{ role: 'user', content: 'x' }],
      })) {
        if (chunk.delta.toolCalls) calls.push(...chunk.delta.toolCalls);
      }

      expect(calls).toEqual([{ id: 't1', name: 'now', arguments: {} }]);
    });
  });

  describe('current model compatibility', () => {
    const personSchema = {
      name: 'person',
      description: 'A person object',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 50 },
          tags: { type: 'array', items: { type: 'string' }, minItems: 2 },
        },
        required: ['name'],
      },
    };

    const tool1 = {
      name: 'tool1',
      description: 'Tool 1',
      parameters: { type: 'object' as const, properties: {} },
    };

    const respondText = (text: string) =>
      mockSend.mockResolvedValueOnce({
        output: { message: { content: [{ text }] } },
        stopReason: 'end_turn',
        usage: {},
      });

    const sentInput = (index = 0) => {
      const command = mockSend.mock.calls[index][0] as MockConverseCommand;
      return command.input as Record<string, unknown>;
    };

    describe('forced tool choice', () => {
      it.each([
        ['global.anthropic.claude-sonnet-5-5', 'required', undefined],
        ['us.anthropic.claude-opus-5-5', 'required', undefined],
        ['anthropic.claude-fable-5-1', { type: 'function', function: { name: 'tool1' } }, 'tool1'],
      ] as const)('%s downgrades %o to auto with an instruction', async (model, choice, name) => {
        respondText('ok');

        await backend.chat({
          model,
          messages: [
            { role: 'system', content: 'Base.' },
            { role: 'user', content: 'Test' },
          ],
          tools: [tool1],
          toolChoice: choice,
        });

        const input = sentInput();
        expect(input.toolConfig).toMatchObject({ toolChoice: { auto: {} } });
        expect(input.system).toEqual([
          {
            text: name
              ? `Base.\n\nYou must respond by calling the "${name}" tool.`
              : 'Base.\n\nYou must respond by calling one of the provided tools.',
          },
        ]);
      });

      it.each([
        ['anthropic.claude-opus-5', 'required', { any: {} }],
        ['us.anthropic.claude-sonnet-4-6', 'required', { any: {} }],
        [
          'anthropic.claude-3-5-sonnet-20241022-v2:0',
          { type: 'function', function: { name: 'tool1' } },
          { tool: { name: 'tool1' } },
        ],
        ['meta.llama3-3-70b-instruct-v1:0', 'required', { any: {} }],
      ] as const)('%s keeps forced tool choice %o', async (model, choice, expected) => {
        respondText('ok');

        await backend.chat({
          model,
          messages: [{ role: 'user', content: 'Test' }],
          tools: [tool1],
          toolChoice: choice,
        });

        const input = sentInput();
        expect(input.toolConfig).toMatchObject({ toolChoice: expected });
        expect(input.system).toBeUndefined();
      });

      it('warns once per model and choice kind', async () => {
        const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
        respondText('ok');
        respondText('ok');

        for (let i = 0; i < 2; i++) {
          await backend.chat({
            model: 'global.anthropic.claude-sonnet-5-5',
            messages: [{ role: 'user', content: 'Test' }],
            tools: [tool1],
            toolChoice: 'required',
          });
        }

        const forcedWarnings = warn.mock.calls.filter(([message]) =>
          message.includes('does not support forced tool use')
        );
        expect(forcedWarnings).toHaveLength(1);
        warn.mockRestore();
      });
    });

    describe('response format', () => {
      it.each([
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'global.anthropic.claude-opus-4-6-v1',
      ])('uses outputConfig.textFormat for %s', async (model) => {
        respondText('{"name":"John"}');

        const response = await backend.chat({
          model,
          messages: [{ role: 'user', content: 'Test' }],
          responseFormat: { type: 'json_schema', jsonSchema: personSchema },
        });

        const input = sentInput();
        const outputConfig = input.outputConfig as {
          textFormat: {
            type: string;
            structure: { jsonSchema: { schema: string; name: string; description: string } };
          };
        };
        expect(outputConfig.textFormat.type).toBe('json_schema');
        expect(outputConfig.textFormat.structure.jsonSchema.name).toBe('person');
        expect(outputConfig.textFormat.structure.jsonSchema.description).toBe('A person object');
        expect(JSON.parse(outputConfig.textFormat.structure.jsonSchema.schema)).toEqual({
          type: 'object',
          properties: {
            name: { type: 'string', description: '{maxLength: 50}' },
            tags: { type: 'array', items: { type: 'string' }, description: '{minItems: 2}' },
          },
          required: ['name'],
          additionalProperties: false,
        });
        expect(input.system).toBeUndefined();
        expect(response.content).toBe('{"name":"John"}');
      });

      it.each([
        'global.anthropic.claude-sonnet-5-5',
        'anthropic.claude-opus-4-7',
        'anthropic.claude-fable-5-1',
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'meta.llama3-3-70b-instruct-v1:0',
      ])('falls back to a schema instruction for %s', async (model) => {
        respondText('{"name":"John"}');

        await backend.chat({
          model,
          messages: [{ role: 'user', content: 'Test' }],
          responseFormat: { type: 'json_schema', jsonSchema: personSchema },
        });

        const input = sentInput();
        expect(input.outputConfig).toBeUndefined();
        const [system] = input.system as Array<{ text: string }>;
        expect(system.text).toContain('You must respond with valid JSON only');
        expect(system.text).toContain(JSON.stringify(personSchema.schema));
      });

      it('adds a JSON instruction for json_object', async () => {
        respondText('{"ok":true}');

        await backend.chat({
          model: 'global.anthropic.claude-sonnet-5-5',
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'Test' },
          ],
          responseFormat: { type: 'json_object' },
        });

        const input = sentInput();
        expect(input.outputConfig).toBeUndefined();
        expect(input.system).toEqual([
          {
            text: 'Be terse.\n\nYou must respond with valid JSON only. Do not include any text before or after the JSON object.',
          },
        ]);
      });

      it('sends outputConfig on streaming requests', async () => {
        mockSend.mockResolvedValueOnce({
          stream: (async function* () {
            yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"name":"J"}' } } };
            yield { messageStop: { stopReason: 'end_turn' } };
          })(),
        });

        let content = '';
        for await (const chunk of backend.chatStream({
          model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          messages: [{ role: 'user', content: 'Test' }],
          responseFormat: { type: 'json_schema', jsonSchema: personSchema },
        })) {
          content += chunk.delta.content ?? '';
        }

        const command = mockSend.mock.calls[0][0] as MockConverseStreamCommand;
        expect((command.input as Record<string, unknown>).outputConfig).toMatchObject({
          textFormat: { type: 'json_schema' },
        });
        expect(content).toBe('{"name":"J"}');
      });
    });
  });

  describe('turn outcome', () => {
    function toolStream(input: string, stopReason: string) {
      return (async function* () {
        yield {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 't1', name: 'purge' } },
          },
        };
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input } } } };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { messageStop: { stopReason } };
        yield { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } };
      })();
    }
    const collect = async () => {
      const finishReasons: unknown[] = [];
      const toolCalls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Clean up' }],
      })) {
        if (chunk.finishReason) finishReasons.push(chunk.finishReason);
        if (chunk.delta.toolCalls) toolCalls.push(...chunk.delta.toolCalls);
      }
      return { finishReasons, toolCalls };
    };

    it('streams a turn cut at max_tokens inside a tool call as truncated, without the call', async () => {
      mockSend.mockResolvedValueOnce({ stream: toolStream('{"olderThanDays": 3', 'max_tokens') });

      const { finishReasons, toolCalls } = await collect();

      expect(finishReasons).toEqual(['length']);
      expect(toolCalls).toEqual([]);
    });

    it('fails a finished turn whose streamed tool input is not valid JSON', async () => {
      mockSend.mockResolvedValueOnce({ stream: toolStream('{"olderThanDays": 3', 'tool_use') });

      await expect(collect()).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
    });

    it('drops the tool call of a turn cut at max_tokens', async () => {
      mockSend.mockResolvedValueOnce({
        output: {
          message: { content: [{ toolUse: { toolUseId: 't1', name: 'purge', input: {} } }] },
        },
        stopReason: 'max_tokens',
        usage: {},
      });

      const response = await backend.chat({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [{ role: 'user', content: 'Clean up' }],
      });

      expect(response.finishReason).toBe('length');
      expect(response.toolCalls).toBeUndefined();
    });
  });
});
