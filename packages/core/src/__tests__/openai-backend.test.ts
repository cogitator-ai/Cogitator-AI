import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIBackend } from '../llm/openai';

const mockCreate = vi.fn();

class MockAPIError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = 'APIError';
    Object.setPrototypeOf(this, MockAPIError.prototype);
  }
}

vi.mock('openai', () => {
  class APIError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
      this.name = 'APIError';
      Object.setPrototypeOf(this, APIError.prototype);
    }
  }

  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
    baseURL = 'https://api.openai.com/v1';
    static APIError = APIError;
  }

  return {
    default: MockOpenAI,
  };
});

describe('OpenAIBackend (Chat Completions wire API)', () => {
  let backend: OpenAIBackend;

  beforeEach(() => {
    backend = new OpenAIBackend({ apiKey: 'test-api-key', api: 'chat-completions' });
    mockCreate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates instance with api key', () => {
      expect(backend.provider).toBe('openai');
    });

    it('accepts custom baseUrl', () => {
      const customBackend = new OpenAIBackend({
        apiKey: 'test-key',
        baseUrl: 'https://custom.api.com',
      });
      expect(customBackend.provider).toBe('openai');
    });
  });

  describe('chat', () => {
    it('makes correct API request', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await backend.chat({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
          ],
        })
      );
    });

    it('sends reasoning effort and reads reasoning text and cache usage', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-1',
        choices: [
          {
            message: { role: 'assistant', content: '42', reasoning_content: 'Six times seven.' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          total_tokens: 130,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      });

      const result = await backend.chat({
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: '6*7?' }],
        reasoning: { effort: 'low' },
      });

      expect(mockCreate.mock.calls[0][0]).toMatchObject({ reasoning_effort: 'low' });
      expect(result.reasoning).toBe('Six times seven.');
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
        cachedInputTokens: 64,
        reasoningTokens: 20,
      });
    });

    it('streams reasoning deltas', async () => {
      mockCreate.mockResolvedValueOnce(
        (async function* () {
          yield { id: 'c', choices: [{ index: 0, delta: { reasoning: 'Hmm, ' } }] };
          yield { id: 'c', choices: [{ index: 0, delta: { reasoning: 'yes.' } }] };
          yield {
            id: 'c',
            choices: [{ index: 0, delta: { content: 'Yes' }, finish_reason: 'stop' }],
          };
        })()
      );

      const chunks = [];
      for await (const chunk of backend.chatStream({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: '?' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks.map((c) => c.delta.reasoning).filter(Boolean)).toEqual(['Hmm, ', 'yes.']);
    });

    it('passes abort signal to SDK request options', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      const controller = new AbortController();

      await backend.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        signal: controller.signal,
      });

      expect(mockCreate).toHaveBeenCalledWith(expect.any(Object), {
        signal: controller.signal,
      });
    });

    it('returns correct response structure', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const response = await backend.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.id).toBe('chatcmpl-123');
      expect(response.content).toBe('Hello!');
      expect(response.finishReason).toBe('stop');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
      expect(response.usage.totalTokens).toBe(15);
    });

    it('handles tool calls', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Tokyo"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
      });

      const response = await backend.chat({
        model: 'gpt-4o-mini',
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
        id: 'call_123',
        name: 'get_weather',
        arguments: { city: 'Tokyo' },
      });
      expect(response.finishReason).toBe('tool_calls');
    });

    it('includes tools in request', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });

      await backend.chat({
        model: 'gpt-4o-mini',
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
              type: 'function',
              function: {
                name: 'my_tool',
                description: 'A test tool',
                parameters: {
                  type: 'object',
                  properties: { param1: { type: 'string' } },
                },
              },
            },
          ],
        })
      );
    });

    it('includes generation config', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });

      await backend.chat({
        model: 'gpt-4o-mini',
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
          max_completion_tokens: 1000,
          stop: ['END'],
        })
      );
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('max_tokens');
    });

    it('uses max_tokens for OpenAI-compatible endpoints', async () => {
      const compatible = new OpenAIBackend({
        apiKey: 'test-api-key',
        baseUrl: 'https://openrouter.example/v1',
      });
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await compatible.chat({
        model: 'some-model',
        messages: [{ role: 'user', content: 'Test' }],
        maxTokens: 50,
      });

      expect(mockCreate.mock.calls[0][0]).toMatchObject({ max_tokens: 50 });
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('max_completion_tokens');
    });

    it('treats empty tool call arguments as an empty object', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '' } },
                {
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'get_date', arguments: 'null' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      const response = await backend.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Time?' }],
      });

      expect(response.toolCalls?.map((tc) => tc.arguments)).toEqual([{}, {}]);
    });

    it('rejects non-object tool call arguments', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'x', arguments: '[1,2]' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await expect(
        backend.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] })
      ).rejects.toThrow('must be a JSON object');
    });

    it('handles tool results in messages', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'The weather is sunny.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      });

      await backend.chat({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          { role: 'assistant', content: '' },
          {
            role: 'tool',
            content: '{"temperature": 25, "condition": "sunny"}',
            toolCallId: 'call_123',
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
              role: 'tool',
              content: '{"temperature": 25, "condition": "sunny"}',
              tool_call_id: 'call_123',
            },
          ],
        })
      );
    });

    it('follows the tool messages of a turn with the images their results returned', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const screenshot = (id: string) => ({
        role: 'tool' as const,
        content: [
          { type: 'text' as const, text: '{"image":"(image attached)"}' },
          {
            type: 'image_base64' as const,
            image_base64: { data: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' as const },
          },
        ],
        toolCallId: id,
        name: 'screenshot',
      });

      await backend.chat({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'Look' },
          { role: 'assistant', content: '' },
          screenshot('call_1'),
          screenshot('call_2'),
          { role: 'user', content: 'And?' },
        ],
      });

      const sent = mockCreate.mock.calls[0][0].messages;
      expect(sent.map((m: { role: string }) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'user',
        'user',
      ]);
      expect(sent[2]).toEqual({
        role: 'tool',
        content: '{"image":"(image attached)"}',
        tool_call_id: 'call_1',
      });
      const image = {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
      };
      expect(sent[4].content).toEqual([
        { type: 'text', text: 'Images returned by the tool calls above:' },
        image,
        image,
      ]);
    });

    it('handles rate limit errors', async () => {
      mockCreate.mockRejectedValueOnce(new MockAPIError('Rate limit exceeded', 429));

      await expect(
        backend.chat({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('handles auth errors', async () => {
      mockCreate.mockRejectedValueOnce(new MockAPIError('Invalid API key', 401));

      await expect(
        backend.chat({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow(/Authentication failed/);
    });

    it('handles server errors', async () => {
      mockCreate.mockRejectedValueOnce(new MockAPIError('Internal server error', 500));

      await expect(
        backend.chat({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow(/Internal server error/);
    });

    it('maps finish reasons correctly', async () => {
      const testCases = [
        { reason: 'stop', expected: 'stop' },
        { reason: 'tool_calls', expected: 'tool_calls' },
        { reason: 'length', expected: 'length' },
      ];

      for (const { reason, expected } of testCases) {
        mockCreate.mockResolvedValueOnce({
          id: 'chatcmpl-123',
          choices: [
            {
              message: { role: 'assistant', content: 'OK' },
              finish_reason: reason,
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        });

        const response = await backend.chat({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Test' }],
        });

        expect(response.finishReason).toBe(expected);
      }
    });

    it('handles response format - text', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });

      await backend.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test' }],
        responseFormat: { type: 'text' },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'text' },
        })
      );
    });

    it('handles response format - json_object', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: '{"result": "ok"}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      });

      await backend.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test' }],
        responseFormat: { type: 'json_object' },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        })
      );
    });

    it('handles tool choice - auto', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });

      await backend.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test' }],
        toolChoice: 'auto',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_choice: 'auto',
        })
      );
    });

    it('handles tool choice - specific function', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });

      await backend.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test' }],
        toolChoice: { type: 'function', function: { name: 'get_weather' } },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
        })
      );
    });

    it('handles multimodal content', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [
          {
            message: { role: 'assistant', content: 'I see an image.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      });

      await backend.chat({
        model: 'gpt-4o',
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
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
              ],
            },
          ],
        })
      );
    });
  });

  describe('chatStream', () => {
    it('streams text responses', async () => {
      const mockStream = (async function* () {
        yield {
          id: 'chatcmpl-123',
          choices: [{ delta: { content: 'Hello' } }],
        };
        yield {
          id: 'chatcmpl-123',
          choices: [{ delta: { content: ' world' } }],
        };
        yield {
          id: 'chatcmpl-123',
          choices: [{ delta: { content: '!' }, finish_reason: 'stop' }],
        };
        yield {
          id: 'chatcmpl-123',
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        };
      })();

      mockCreate.mockResolvedValueOnce(mockStream);

      const results: string[] = [];
      for await (const chunk of backend.chatStream({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.delta.content) {
          results.push(chunk.delta.content);
        }
      }

      expect(results).toEqual(['Hello', ' world', '!']);
    });

    it('streams tool calls', async () => {
      const mockStream = (async function* () {
        yield {
          id: 'chatcmpl-123',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    function: { name: 'get_weather', arguments: '{"ci' },
                  },
                ],
              },
            },
          ],
        };
        yield {
          id: 'chatcmpl-123',
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: 'ty":"Tok' } }],
              },
            },
          ],
        };
        yield {
          id: 'chatcmpl-123',
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: 'yo"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        };
      })();

      mockCreate.mockResolvedValueOnce(mockStream);

      const toolCalls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Weather?' }],
      })) {
        if (chunk.delta.toolCalls) {
          toolCalls.push(...chunk.delta.toolCalls);
        }
      }

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        id: 'call_123',
        name: 'get_weather',
        arguments: { city: 'Tokyo' },
      });
    });

    it('includes stream options', async () => {
      const mockStream = (async function* () {
        yield {
          id: 'chatcmpl-123',
          choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }],
        };
      })();

      mockCreate.mockResolvedValueOnce(mockStream);

      for await (const _ of backend.chatStream({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test' }],
      })) {
        /* consume stream */
      }

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
          stream_options: { include_usage: true },
        })
      );
    });

    it('handles streaming errors', async () => {
      mockCreate.mockRejectedValueOnce(new MockAPIError('Rate limit exceeded', 429));

      await expect(async () => {
        for await (const _ of backend.chatStream({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Test' }],
        })) {
          /* consume stream */
        }
      }).rejects.toThrow('Rate limit exceeded');
    });

    it('yields usage in final chunk', async () => {
      const mockStream = (async function* () {
        yield {
          id: 'chatcmpl-123',
          choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
        };
        yield {
          id: 'chatcmpl-123',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        };
      })();

      mockCreate.mockResolvedValueOnce(mockStream);

      let finalUsage;
      for await (const chunk of backend.chatStream({
        model: 'gpt-4o-mini',
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

    it('keeps usage reported on the finishing choice chunk', async () => {
      const mockStream = (async function* () {
        yield {
          id: 'chatcmpl-123',
          choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        };
      })();

      mockCreate.mockResolvedValueOnce(mockStream);

      const chunks = [];
      for await (const chunk of backend.chatStream({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0].usage).toEqual({ inputTokens: 7, outputTokens: 2, totalTokens: 9 });
    });
  });
});
