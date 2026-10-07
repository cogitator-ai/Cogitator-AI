import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolCallMessage } from './helpers/messages';
import { AnthropicBackend } from '../llm/anthropic';
import { getLogger } from '../logger';

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

    it('passes abort signal to SDK request options', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const controller = new AbortController();

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        signal: controller.signal,
      });

      expect(mockCreate).toHaveBeenCalledWith(expect.any(Object), {
        signal: controller.signal,
      });
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
        model: 'claude-3-5-sonnet-20241022',
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

    describe('sampling parameters per model family', () => {
      const respondOk = () =>
        mockCreate.mockResolvedValueOnce({
          id: 'msg_123',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        });

      const sentParams = () => mockCreate.mock.calls[0][0] as Record<string, unknown>;

      it.each([
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-fable-5-1',
        'claude-mythos-5-1',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-sonnet-5',
      ])('omits temperature and top_p for %s', async (model) => {
        respondOk();

        await backend.chat({
          model,
          messages: [{ role: 'user', content: 'Test' }],
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 1000,
          stop: ['END'],
        });

        const params = sentParams();
        expect(params).not.toHaveProperty('temperature');
        expect(params).not.toHaveProperty('top_p');
        expect(params).toMatchObject({ model, max_tokens: 1000, stop_sequences: ['END'] });
      });

      it.each(['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-5'])(
        'sends only temperature when both are set for %s',
        async (model) => {
          respondOk();

          await backend.chat({
            model,
            messages: [{ role: 'user', content: 'Test' }],
            temperature: 0.7,
            topP: 0.9,
          });

          const params = sentParams();
          expect(params.temperature).toBe(0.7);
          expect(params).not.toHaveProperty('top_p');
        }
      );

      it('sends top_p alone to claude-haiku-4-5 when temperature is unset', async () => {
        respondOk();

        await backend.chat({
          model: 'claude-haiku-4-5',
          messages: [{ role: 'user', content: 'Test' }],
          topP: 0.9,
        });

        const params = sentParams();
        expect(params.top_p).toBe(0.9);
        expect(params).not.toHaveProperty('temperature');
      });

      it('omits sampling params from streaming requests to claude-sonnet-5-5', async () => {
        mockStream.mockReturnValueOnce(
          (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            };
            yield { type: 'message_stop' };
          })()
        );

        for await (const _ of backend.chatStream({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'Hi' }],
          temperature: 0.7,
          topP: 0.9,
        })) {
          /* consume stream */
        }

        const params = mockStream.mock.calls[0][0] as Record<string, unknown>;
        expect(params).not.toHaveProperty('temperature');
        expect(params).not.toHaveProperty('top_p');
      });
    });

    it('falls back to claude-sonnet-5-5 when the model is empty', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_123',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      await backend.chat({ model: '', messages: [{ role: 'user', content: 'Test' }] });

      expect(AnthropicBackend.DEFAULT_MODEL).toBe('claude-sonnet-5-5');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-5-5' })
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
          toolCallMessage([
            {
              id: 'toolu_123',
              name: 'get_weather',
              arguments: { city: 'Tokyo' },
            },
          ]),
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
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_123',
                  name: 'get_weather',
                  input: { city: 'Tokyo' },
                },
              ],
            },
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
        { reason: 'stop_sequence', expected: 'stop' },
        { reason: 'tool_use', expected: 'stop' },
        { reason: 'max_tokens', expected: 'length' },
        { reason: 'model_context_window_exceeded', expected: 'length' },
        { reason: 'pause_turn', expected: 'length' },
        { reason: 'refusal', expected: 'refusal' },
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

    it('keeps real tools callable when an older model needs a JSON schema', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [
          {
            name: 'lookup',
            description: 'Look something up',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'answer',
            schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
          },
        },
      });

      const params = mockCreate.mock.calls[0][0] as {
        tools: Array<{ name: string }>;
        tool_choice?: unknown;
        system: string;
      };
      expect(params.tools.map((t) => t.name)).toEqual(['lookup']);
      expect(params.tool_choice).toBeUndefined();
      expect(params.system).toContain('"required":["a"]');
      expect(response.toolCalls?.[0].name).toBe('lookup');
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
        toolChoice: { type: 'function', function: { name: 'get_weather' } },
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

  describe('audit regressions', () => {
    const okResponse = {
      id: 'msg_1',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    it('keeps the base system prompt when later system messages are present', async () => {
      mockCreate.mockResolvedValueOnce(okResponse);

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
          { role: 'system', content: 'Reflection: be concise.' },
        ],
      });

      expect(mockCreate.mock.calls[0][0].system).toBe(
        'You are helpful.\n\nReflection: be concise.'
      );
    });

    it('omits the system field when there is no system prompt', async () => {
      mockCreate.mockResolvedValueOnce(okResponse);

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(mockCreate.mock.calls[0][0].system).toBeUndefined();
    });

    it('sends the image of a tool result inside its tool_result block', async () => {
      mockCreate.mockResolvedValueOnce(okResponse);

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Look' },
          toolCallMessage([{ id: 'toolu_1', name: 'screenshot', arguments: {} }]),
          {
            role: 'tool',
            content: [
              { type: 'text', text: '{"image":"(image attached)"}' },
              {
                type: 'image_base64',
                image_base64: { data: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' },
              },
            ],
            toolCallId: 'toolu_1',
            name: 'screenshot',
          },
        ],
      });

      expect(mockCreate.mock.calls[0][0].messages[2].content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'text', text: '{"image":"(image attached)"}' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
            },
          ],
        },
      ]);
    });

    it('groups parallel tool results into a single user message', async () => {
      mockCreate.mockResolvedValueOnce(okResponse);

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Weather in Tokyo and Paris?' },
          toolCallMessage([
            { id: 'toolu_1', name: 'weather', arguments: { city: 'Tokyo' } },
            { id: 'toolu_2', name: 'weather', arguments: { city: 'Paris' } },
          ]),
          { role: 'tool', content: '"sunny"', toolCallId: 'toolu_1', name: 'weather' },
          { role: 'tool', content: '"rainy"', toolCallId: 'toolu_2', name: 'weather' },
        ],
      });

      const sent = mockCreate.mock.calls[0][0].messages;
      expect(sent).toHaveLength(3);
      expect(sent[2]).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '"sunny"' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: '"rainy"' },
        ],
      });
    });

    it('maps tool choice none to the none tool choice', async () => {
      mockCreate.mockResolvedValueOnce(okResponse);

      await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
        toolChoice: 'none',
      });

      expect(mockCreate.mock.calls[0][0].tool_choice).toEqual({ type: 'none' });
    });

    it('reports stop (not tool_calls) for json_schema responses', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: '__json_response', input: { a: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hi' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: { name: 'x', schema: { type: 'object', properties: {} } },
        },
      });

      expect(response.content).toBe('{"a":1}');
      expect(response.finishReason).toBe('stop');
      expect(response.toolCalls).toBeUndefined();
    });

    it('wraps errors raised while iterating the stream', async () => {
      mockStream.mockReturnValueOnce(
        (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
          throw new MockAPIError('Overloaded', 529);
        })()
      );

      const consume = async () => {
        for await (const _ of backend.chatStream({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Hi' }],
        })) {
          /* consume stream */
        }
      };

      await expect(consume()).rejects.toMatchObject({
        name: 'LLMError',
        message: expect.stringContaining('Overloaded'),
      });
    });

    it.each([
      ['refusal', 'refusal'],
      ['model_context_window_exceeded', 'length'],
      ['pause_turn', 'length'],
    ])('maps streamed stop reason %s to %s', async (stopReason, expected) => {
      mockStream.mockReturnValueOnce(
        (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
          yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason },
            usage: { output_tokens: 1 },
          };
          yield { type: 'message_stop' };
        })()
      );

      const finishReasons: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.finishReason) finishReasons.push(chunk.finishReason);
      }

      expect(finishReasons).toEqual([expected]);
    });

    it('parses empty streamed tool input as an empty object', async () => {
      mockStream.mockReturnValueOnce(
        (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
          yield {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'now' },
          };
          yield { type: 'content_block_stop' };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 1 },
          };
          yield { type: 'message_stop' };
        })()
      );

      const toolCalls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Time?' }],
      })) {
        if (chunk.delta.toolCalls) toolCalls.push(...chunk.delta.toolCalls);
      }

      expect(toolCalls).toEqual([{ id: 'toolu_1', name: 'now', arguments: {} }]);
    });
  });

  describe('current model compatibility', () => {
    const personSchema = {
      name: 'person',
      description: 'A person object',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          age: { type: 'integer', minimum: 0 },
        },
        required: ['name'],
      },
    };

    const tool1 = {
      name: 'tool1',
      description: 'Tool 1',
      parameters: { type: 'object' as const, properties: {} },
    };

    const textResponse = (text: string, stopReason = 'end_turn') => ({
      id: 'msg_123',
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    const sentParams = (index = 0) => mockCreate.mock.calls[index][0] as Record<string, unknown>;

    describe('json_schema via native structured outputs', () => {
      it.each([
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-fable-5-1',
        'claude-opus-5',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5',
        'claude-opus-4-5-20251101',
      ])('sends output_config.format for %s', async (model) => {
        mockCreate.mockResolvedValueOnce(textResponse('{"name":"John","age":30}'));

        const response = await backend.chat({
          model,
          messages: [{ role: 'user', content: 'Test' }],
          responseFormat: { type: 'json_schema', jsonSchema: personSchema },
        });

        const params = sentParams();
        expect(params.output_config).toEqual({
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              description: 'A person object',
              properties: {
                name: { type: 'string', description: '{minLength: 1}' },
                age: { type: 'integer', description: '{minimum: 0}' },
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
        });
        expect(params.tools).toBeUndefined();
        expect(params.tool_choice).toBeUndefined();
        expect(response.content).toBe('{"name":"John","age":30}');
        expect(response.finishReason).toBe('stop');
        expect(response.toolCalls).toBeUndefined();
      });

      it('keeps user tools and their tool choice alongside structured output', async () => {
        mockCreate.mockResolvedValueOnce(textResponse('{"name":"Ann"}'));

        await backend.chat({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'Test' }],
          tools: [tool1],
          toolChoice: 'auto',
          responseFormat: { type: 'json_schema', jsonSchema: personSchema },
        });

        const params = sentParams();
        expect(params.tools).toEqual([
          { name: 'tool1', description: 'Tool 1', input_schema: tool1.parameters },
        ]);
        expect(params.tool_choice).toEqual({ type: 'auto' });
        expect(params.output_config).toBeDefined();
      });

      it('reports a refusal instead of a successful JSON response', async () => {
        mockCreate.mockResolvedValueOnce(textResponse('', 'refusal'));

        const response = await backend.chat({
          model: 'claude-opus-5-5',
          messages: [{ role: 'user', content: 'Test' }],
          responseFormat: { type: 'json_schema', jsonSchema: personSchema },
        });

        expect(response.finishReason).toBe('refusal');
      });

      it('streams structured output as text deltas', async () => {
        mockStream.mockReturnValueOnce(
          (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 3 } } };
            yield {
              type: 'content_block_start',
              content_block: { type: 'text', text: '' },
            };
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: '{"name":' },
            };
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: '"John"}' },
            };
            yield { type: 'content_block_stop' };
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 4 },
            };
            yield { type: 'message_stop' };
          })()
        );

        let content = '';
        let finishReason: string | undefined;
        for await (const chunk of backend.chatStream({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'Test' }],
          responseFormat: { type: 'json_schema', jsonSchema: personSchema },
        })) {
          content += chunk.delta.content ?? '';
          finishReason = chunk.finishReason ?? finishReason;
        }

        const params = mockStream.mock.calls[0][0] as Record<string, unknown>;
        expect(params.output_config).toMatchObject({ format: { type: 'json_schema' } });
        expect(params.tool_choice).toBeUndefined();
        expect(params.tools).toBeUndefined();
        expect(JSON.parse(content)).toEqual({ name: 'John' });
        expect(finishReason).toBe('stop');
      });
    });

    describe('json_schema via forced tool on older models', () => {
      it.each(['claude-3-5-sonnet-20241022', 'claude-opus-4-1-20250805'])(
        'uses the __json_response tool for %s',
        async (model) => {
          mockCreate.mockResolvedValueOnce({
            id: 'msg_123',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: '__json_response', input: { name: 'J' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 5, output_tokens: 5 },
          });

          const response = await backend.chat({
            model,
            messages: [{ role: 'user', content: 'Test' }],
            responseFormat: { type: 'json_schema', jsonSchema: personSchema },
          });

          const params = sentParams();
          expect(params.output_config).toBeUndefined();
          expect(params.tool_choice).toEqual({ type: 'tool', name: '__json_response' });
          expect(response.content).toBe('{"name":"J"}');
        }
      );
    });

    describe('json_object', () => {
      it.each(['claude-sonnet-5-5', 'claude-3-5-sonnet-20241022'])(
        'uses a system instruction without forcing tools for %s',
        async (model) => {
          mockCreate.mockResolvedValueOnce(textResponse('{"ok":true}'));

          const response = await backend.chat({
            model,
            messages: [
              { role: 'system', content: 'Be terse.' },
              { role: 'user', content: 'Test' },
            ],
            responseFormat: { type: 'json_object' },
          });

          const params = sentParams();
          expect(params.system).toBe(
            'Be terse.\n\nYou must respond with valid JSON only. Do not include any text before or after the JSON object.'
          );
          expect(params.output_config).toBeUndefined();
          expect(params.tool_choice).toBeUndefined();
          expect(response.content).toBe('{"ok":true}');
        }
      );
    });

    describe('forced tool choice', () => {
      it.each([
        ['claude-sonnet-5-5', 'required', undefined],
        ['claude-opus-5-5', 'required', undefined],
        ['claude-fable-5-1', { type: 'function', function: { name: 'tool1' } }, 'tool1'],
        ['claude-mythos-5-1', { type: 'function', function: { name: 'tool1' } }, 'tool1'],
      ] as const)('%s downgrades %o to auto with an instruction', async (model, choice, name) => {
        mockCreate.mockResolvedValueOnce(textResponse('ok'));

        await backend.chat({
          model,
          messages: [
            { role: 'system', content: 'Base.' },
            { role: 'user', content: 'Test' },
          ],
          tools: [tool1],
          toolChoice: choice,
        });

        const params = sentParams();
        expect(params.tool_choice).toEqual({ type: 'auto' });
        expect(params.system).toBe(
          name
            ? `Base.\n\nYou must respond by calling the "${name}" tool.`
            : 'Base.\n\nYou must respond by calling one of the provided tools.'
        );
      });

      it.each([
        ['claude-opus-5', 'required', { type: 'any' }],
        ['claude-sonnet-5', 'required', { type: 'any' }],
        ['claude-fable-5', 'required', { type: 'any' }],
        [
          'claude-opus-4-8',
          { type: 'function', function: { name: 'tool1' } },
          { type: 'tool', name: 'tool1' },
        ],
        [
          'claude-haiku-4-5',
          { type: 'function', function: { name: 'tool1' } },
          { type: 'tool', name: 'tool1' },
        ],
      ] as const)('%s keeps forced tool choice %o', async (model, choice, expected) => {
        mockCreate.mockResolvedValueOnce(textResponse('ok'));

        await backend.chat({
          model,
          messages: [{ role: 'user', content: 'Test' }],
          tools: [tool1],
          toolChoice: choice,
        });

        const params = sentParams();
        expect(params.tool_choice).toEqual(expected);
        expect(params.system).toBeUndefined();
      });

      it('keeps auto and none on models that reject forced tool use', async () => {
        mockCreate.mockResolvedValueOnce(textResponse('ok'));
        mockCreate.mockResolvedValueOnce(textResponse('ok'));

        await backend.chat({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'Test' }],
          tools: [tool1],
          toolChoice: 'none',
        });
        await backend.chat({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'Test' }],
          tools: [tool1],
          toolChoice: 'auto',
        });

        expect(sentParams(0).tool_choice).toEqual({ type: 'none' });
        expect(sentParams(1).tool_choice).toEqual({ type: 'auto' });
      });

      it('warns once per model and choice kind', async () => {
        const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
        for (let i = 0; i < 3; i++) mockCreate.mockResolvedValueOnce(textResponse('ok'));

        for (let i = 0; i < 3; i++) {
          await backend.chat({
            model: 'claude-sonnet-5-5',
            messages: [{ role: 'user', content: 'Test' }],
            tools: [tool1],
            toolChoice: 'required',
          });
        }

        const forcedWarnings = warn.mock.calls.filter(([message]) =>
          message.includes('does not support forced tool use')
        );
        expect(forcedWarnings).toHaveLength(1);
        expect(forcedWarnings[0][1]).toMatchObject({
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          requested: 'required',
        });
        warn.mockRestore();
      });

      it('applies the same downgrade to streaming requests', async () => {
        mockStream.mockReturnValueOnce(
          (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            };
            yield { type: 'message_stop' };
          })()
        );

        for await (const _ of backend.chatStream({
          model: 'claude-opus-5-5',
          messages: [{ role: 'user', content: 'Hi' }],
          tools: [tool1],
          toolChoice: { type: 'function', function: { name: 'tool1' } },
        })) {
          /* consume stream */
        }

        const params = mockStream.mock.calls[0][0] as Record<string, unknown>;
        expect(params.tool_choice).toEqual({ type: 'auto' });
        expect(params.system).toBe('You must respond by calling the "tool1" tool.');
      });
    });
  });

  describe('prompt cache usage', () => {
    it('reports the cache writes made with the 1-hour TTL', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_1',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 },
        },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'x' }],
        cache: { ttl: '1h' },
      });

      expect(response.usage).toMatchObject({
        inputTokens: 510,
        cacheWriteTokens: 500,
        cacheWrite1hTokens: 400,
      });
    });

    it('leaves the 1-hour count out when nothing was written for an hour', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_1',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
        },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(response.usage).not.toHaveProperty('cacheWrite1hTokens');
    });
  });

  describe('turn outcome', () => {
    const purge = {
      name: 'purge',
      description: 'Delete old records',
      parameters: {
        type: 'object' as const,
        properties: { olderThanDays: { type: 'number' } },
      },
    };
    const toolStream = (partialJson: string, stopReason: string) =>
      (async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
        yield {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'purge' },
        };
        yield {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: partialJson },
        };
        yield { type: 'content_block_stop' };
        yield {
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 1 },
        };
        yield { type: 'message_stop' };
      })();
    const collect = async () => {
      const finishReasons: unknown[] = [];
      const toolCalls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Clean up' }],
        tools: [purge],
      })) {
        if (chunk.finishReason) finishReasons.push(chunk.finishReason);
        if (chunk.delta.toolCalls) toolCalls.push(...chunk.delta.toolCalls);
      }
      return { finishReasons, toolCalls };
    };

    it('streams a turn cut at max_tokens inside a tool call as truncated, without the call', async () => {
      mockStream.mockReturnValueOnce(toolStream('{"olderThanDays": 3', 'max_tokens'));

      const { finishReasons, toolCalls } = await collect();

      expect(finishReasons).toEqual(['length']);
      expect(toolCalls).toEqual([]);
    });

    it('fails a finished turn whose streamed tool input is not valid JSON', async () => {
      mockStream.mockReturnValueOnce(toolStream('{"olderThanDays": 3', 'tool_use'));

      await expect(collect()).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
    });

    it('drops the tool call of a turn cut at max_tokens', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'purge', input: {} }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Clean up' }],
        tools: [purge],
      });

      expect(response.finishReason).toBe('length');
      expect(response.toolCalls).toBeUndefined();
    });

    it('reports a json_schema answer cut at max_tokens as truncated', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: '__json_response', input: {} }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Person?' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: { name: 'person', schema: { type: 'object', properties: {} } },
        },
      });

      expect(response.finishReason).toBe('length');
    });

    it.each([
      ['refusal', 'refusal'],
      ['content_filtered', 'content_filter'],
      ['guardrail_intervened', 'content_filter'],
    ])('reports stop reason %s as %s', async (stopReason, expected) => {
      mockCreate.mockResolvedValueOnce({
        id: 'msg_1',
        content: [],
        stop_reason: stopReason,
        usage: { input_tokens: 1, output_tokens: 0 },
      });

      const response = await backend.chat({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(response.finishReason).toBe(expected);
    });
  });
});
