import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tool-1',
                name: 'get_weather',
                arguments: { city: 'Berlin' },
              },
            ],
          },
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
        { stopReason: 'tool_use', expected: 'tool_calls' },
        { stopReason: 'max_tokens', expected: 'length' },
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
});
