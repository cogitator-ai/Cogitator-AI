import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicBackend } from '../llm/anthropic';

const mockCreate = vi.fn();
const mockStream = vi.fn();

class MockAPIError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = 'APIError';
    Object.setPrototypeOf(this, MockAPIError.prototype);
  }
}

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
      this.name = 'APIError';
      Object.setPrototypeOf(this, APIError.prototype);
    }
  }

  class MockAnthropic {
    messages = {
      create: mockCreate,
      stream: mockStream,
    };
    static APIError = APIError;
  }

  return {
    default: MockAnthropic,
  };
});

describe('AnthropicBackend', () => {
  let backend: AnthropicBackend;

  beforeEach(() => {
    backend = new AnthropicBackend({ apiKey: 'test-api-key' });
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates instance with api key', () => {
      expect(backend.provider).toBe('anthropic');
    });
  });

  describe('chat', () => {
    it('makes correct API request', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514',
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'Hello' }],
        })
      );
    });

    it('returns correct response structure', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.id).toBe('msg_123');
      expect(response.content).toBe('Hello!');
      expect(response.finishReason).toBe('stop');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
      expect(response.usage.totalTokens).toBe(15);
    });

    it('handles tool calls', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_123',
            name: 'get_weather',
            input: { city: 'Tokyo' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 15 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      });

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0]).toEqual({
        id: 'toolu_123',
        name: 'get_weather',
        arguments: { city: 'Tokyo' },
      });
      expect(response.finishReason).toBe('tool_calls');
    });

    it('includes tools in request', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [
          {
            name: 'my_tool',
            description: 'A test tool',
            parameters: {
              type: 'object',
              properties: { param1: { type: 'string' } },
            },
          },
        ],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              name: 'my_tool',
              description: 'A test tool',
              input_schema: {
                type: 'object',
                properties: { param1: { type: 'string' } },
              },
            },
          ],
        })
      );
    });

    it('includes generation config', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1000,
        stop: ['END'],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 1000,
          stop_sequences: ['END'],
        })
      );
    });

    it('uses default maxTokens when not specified', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          max_tokens: 4096,
        })
      );
    });

    it('handles tool results in messages', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'The weather is sunny.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 10 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          { role: 'assistant', content: '' },
          {
            role: 'tool',
            content: '{"temperature": 25, "condition": "sunny"}',
            toolCallId: 'toolu_123',
            name: 'get_weather',
          },
        ],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'What is the weather?' },
            { role: 'assistant', content: '' },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_123',
                  content: '{"temperature": 25, "condition": "sunny"}',
                },
              ],
            },
          ],
        })
      );
    });

    it('handles rate limit errors', async () => {
      mockCreate.mockRejectedValueOnce(new MockAPIError('Rate limit exceeded', 429));

      await expect(
        backend.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('handles auth errors', async () => {
      mockCreate.mockRejectedValueOnce(new MockAPIError('Invalid API key', 401));

      await expect(
        backend.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow(/Authentication failed/);
    });

    it('handles server errors', async () => {
      mockCreate.mockRejectedValueOnce(new MockAPIError('Internal server error', 500));

      await expect(
        backend.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow(/Internal server error/);
    });

    it('maps stop reasons correctly', async () => {
      const testCases = [
        { reason: 'end_turn', expected: 'stop' },
        { reason: 'tool_use', expected: 'tool_calls' },
        { reason: 'max_tokens', expected: 'length' },
      ];

      for (const { reason, expected } of testCases) {
        mockCreate.mockResolvedValueOnce({
          id: 'msg_123',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: reason,
          usage: { input_tokens: 5, output_tokens: 2 },
        });

        const response = await backend.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Test' }],
        });

        expect(response.finishReason).toBe(expected);
      }
    });

    it('handles json_object response format', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: '{"result": "ok"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        responseFormat: { type: 'json_object' },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('valid JSON only'),
        })
      );
    });

    it('handles json_schema response format using tool trick', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_123',
            name: '__json_response',
            input: { name: 'John', age: 30 },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 15 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'person',
            description: 'A person object',
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                age: { type: 'number' },
              },
              required: ['name'],
            },
          },
        },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: '__json_response',
            }),
          ]),
          tool_choice: { type: 'tool', name: '__json_response' },
        })
      );

      expect(response.content).toBe('{"name":"John","age":30}');
      expect(response.toolCalls).toBeUndefined();
    });

    it('handles tool choice - auto', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [
          {
            name: 'tool1',
            description: 'Tool 1',
            parameters: { type: 'object', properties: {} },
          },
        ],
        toolChoice: 'auto',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_choice: { type: 'auto' },
        })
      );
    });

    it('handles tool choice - required', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'tool_use', id: 'toolu_123', name: 'tool1', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [
          {
            name: 'tool1',
            description: 'Tool 1',
            parameters: { type: 'object', properties: {} },
          },
        ],
        toolChoice: 'required',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_choice: { type: 'any' },
        })
      );
    });

    it('handles tool choice - specific function', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'tool_use', id: 'toolu_123', name: 'get_weather', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: {} },
          },
        ],
        toolChoice: { function: { name: 'get_weather' } },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_choice: { type: 'tool', name: 'get_weather' },
        })
      );
    });

    it('handles multimodal content', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'I see an image.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 5 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
            ],
          },
        ],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What is this?' },
                { type: 'image', source: { type: 'url', url: 'https://example.com/image.jpg' } },
              ],
            },
          ],
        })
      );
    });

    it('handles base64 images', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'I see an image.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 5 },
      });

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              {
                type: 'image_base64',
                image_base64: { media_type: 'image/png', data: 'base64data' },
              },
            ],
          },
        ],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What is this?' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
                },
              ],
            },
          ],
        })
      );
    });

    it('handles multiple text blocks in response', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [
          { type: 'text', text: 'First part. ' },
          { type: 'text', text: 'Second part.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 10 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
      });

      expect(response.content).toBe('First part. Second part.');
    });
  });

  describe('chatStream', () => {
    it('streams text responses', async () => {
      const mockEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop' },
        { type: 'message_delta', usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];

      mockStream.mockReturnValueOnce(
        (async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        })()
      );

      const results: string[] = [];
      for await (const chunk of backend.chatStream({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.delta.content) {
          results.push(chunk.delta.content);
        }
      }

      expect(results).toEqual(['Hello', ' world']);
    });

    it('streams tool calls', async () => {
      const mockEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'get_weather' },
        },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"ci' } },
        {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: 'ty":"Tokyo"}' },
        },
        { type: 'content_block_stop' },
        { type: 'message_delta', usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];

      mockStream.mockReturnValueOnce(
        (async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        })()
      );

      const toolCalls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Weather?' }],
      })) {
        if (chunk.delta.toolCalls) {
          toolCalls.push(...chunk.delta.toolCalls);
        }
      }

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        id: 'toolu_123',
        name: 'get_weather',
        arguments: { city: 'Tokyo' },
      });
    });

    it('yields usage in final chunk', async () => {
      const mockEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop' },
        { type: 'message_delta', usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];

      mockStream.mockReturnValueOnce(
        (async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        })()
      );

      let finalUsage;
      for await (const chunk of backend.chatStream({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
      })) {
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
      }

      expect(finalUsage).toEqual({
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
      });
    });

    it('handles streaming errors', async () => {
      mockStream.mockImplementationOnce(() => {
        throw new MockAPIError('Rate limit exceeded', 429);
      });

      await expect(async () => {
        for await (const _ of backend.chatStream({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Test' }],
        })) {
          /* consume stream */
        }
      }).rejects.toThrow('Rate limit exceeded');
    });

    it('handles json_schema streaming with tool trick', async () => {
      const mockEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_123', name: '__json_response' },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"name":"John"}' },
        },
        { type: 'content_block_stop' },
        { type: 'message_delta', usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];

      mockStream.mockReturnValueOnce(
        (async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        })()
      );

      const contents: string[] = [];
      for await (const chunk of backend.chatStream({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'person',
            schema: { type: 'object', properties: { name: { type: 'string' } } },
          },
        },
      })) {
        if (chunk.delta.content) {
          contents.push(chunk.delta.content);
        }
      }

      expect(contents).toContain('{"name":"John"}');
    });
  });
});
