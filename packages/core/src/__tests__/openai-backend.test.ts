import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorCode, type ToolSchema } from '@cogitator-ai/types';
import { Stream } from 'openai/streaming';
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

    it('sends a reasoning model no sampling parameters on Chat Completions', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });

      await backend.chat({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 500,
        stop: ['END'],
      });

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(params).toMatchObject({ max_completion_tokens: 500, stop: ['END'] });
      expect(params).not.toHaveProperty('temperature');
      expect(params).not.toHaveProperty('top_p');
    });

    it('sends a reasoning model max_completion_tokens behind an OpenAI proxy too', async () => {
      const proxied = new OpenAIBackend({ apiKey: 'k', baseUrl: 'https://proxy.example/v1' });
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-123',
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });

      await proxied.chat({
        model: 'o4-mini',
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.7,
        maxTokens: 500,
      });

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(params).toMatchObject({ max_completion_tokens: 500 });
      expect(params).not.toHaveProperty('max_tokens');
      expect(params).not.toHaveProperty('temperature');
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

    it('reports a custom provider name for an OpenAI-compatible service', async () => {
      const openRouter = new OpenAIBackend({
        apiKey: 'test-api-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        provider: 'openrouter',
      });
      mockCreate.mockRejectedValueOnce(new MockAPIError('Upstream overloaded', 503));

      expect(openRouter.provider).toBe('openrouter');
      await expect(
        openRouter.chat({
          model: 'deepseek/deepseek-v4-pro',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toMatchObject({ details: expect.objectContaining({ provider: 'openrouter' }) });
      expect(mockCreate).toHaveBeenCalledTimes(1);
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

    it('reports a provider error sent in a successful response, retryable', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-1',
        error: {
          code: 502,
          message: 'Upstream provider returned an error',
          metadata: { provider_name: 'Example' },
        },
      });

      await expect(
        backend.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Test' }] })
      ).rejects.toMatchObject({
        name: 'LLMError',
        code: ErrorCode.LLM_UNAVAILABLE,
        retryable: true,
        message: expect.stringContaining('Upstream provider returned an error') as unknown,
      });
    });

    it('reads a rate limit in the body as a rate limit', async () => {
      mockCreate.mockResolvedValueOnce({
        error: { code: 429, message: 'Rate limited upstream', retry_after: 3 },
      });

      await expect(
        backend.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Test' }] })
      ).rejects.toMatchObject({
        code: ErrorCode.LLM_RATE_LIMITED,
        retryable: true,
        retryAfter: 3000,
      });
    });

    it('keeps a client error in the body from being retried', async () => {
      mockCreate.mockResolvedValueOnce({
        error: { code: 402, message: 'Insufficient credits' },
      });

      await expect(
        backend.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Test' }] })
      ).rejects.toMatchObject({ retryable: false });
    });

    it('treats an error code that is not a status as a bad gateway', async () => {
      mockCreate.mockResolvedValueOnce({
        error: { code: 'server_error', message: 'Something broke' },
      });

      await expect(
        backend.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Test' }] })
      ).rejects.toMatchObject({ code: ErrorCode.LLM_UNAVAILABLE, retryable: true });
    });

    it('rejects a response without choices as invalid', async () => {
      mockCreate.mockResolvedValueOnce({ id: 'gen-2' });

      await expect(
        backend.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Test' }] })
      ).rejects.toMatchObject({
        code: ErrorCode.LLM_INVALID_RESPONSE,
        message: expect.stringContaining('No choices') as unknown,
      });
    });

    it('maps finish reasons correctly', async () => {
      const testCases = [
        { reason: 'stop', expected: 'stop' },
        { reason: 'tool_calls', expected: 'stop' },
        { reason: 'length', expected: 'length' },
        { reason: 'content_filter', expected: 'content_filter' },
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

    it('stops with a retryable error when a chunk it is handed carries a provider error', async () => {
      mockCreate.mockResolvedValueOnce(
        (async function* () {
          yield { id: 'gen-3', choices: [{ delta: { content: 'Hel' }, finish_reason: null }] };
          yield {
            id: 'gen-3',
            error: { code: 503, message: 'Provider overloaded' },
            choices: [{ delta: { content: '' }, finish_reason: 'error' }],
          };
        })()
      );

      const content: string[] = [];
      await expect(async () => {
        for await (const chunk of backend.chatStream({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Test' }],
        })) {
          if (chunk.delta.content) content.push(chunk.delta.content);
        }
      }).rejects.toMatchObject({ code: ErrorCode.LLM_UNAVAILABLE, retryable: true });
      expect(content).toEqual(['Hel']);
    });

    it('makes the provider error the SDK raises mid-stream a retryable error', async () => {
      const events = [
        { id: 'gen-5', choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
        {
          id: 'gen-5',
          error: { code: 503, message: 'Provider overloaded' },
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
        },
      ];
      const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
      mockCreate.mockResolvedValueOnce(
        Stream.fromSSEResponse(
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
          new AbortController()
        )
      );

      const content: string[] = [];
      let failure: unknown;
      try {
        for await (const chunk of backend.chatStream({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Test' }],
        })) {
          if (chunk.delta.content) content.push(chunk.delta.content);
        }
      } catch (error) {
        failure = error;
      }

      expect(content).toEqual(['Hel']);
      expect(failure).toMatchObject({
        name: 'LLMError',
        code: ErrorCode.LLM_UNAVAILABLE,
        retryable: true,
        message: expect.stringContaining('Provider overloaded') as unknown,
      });
      expect((failure as Error).cause).toBeInstanceOf(Error);
    });

    it('lets an abort while reading a stream through as it is', async () => {
      const abort = new DOMException('The operation was aborted.', 'AbortError');
      mockCreate.mockResolvedValueOnce(
        (async function* () {
          yield { id: 'gen-6', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] };
          throw abort;
        })()
      );

      await expect(async () => {
        for await (const _ of backend.chatStream({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Test' }],
        })) {
          /* consume stream */
        }
      }).rejects.toBe(abort);
    });

    it('skips a chunk without choices', async () => {
      mockCreate.mockResolvedValueOnce(
        (async function* () {
          yield { id: 'gen-4' };
          yield { id: 'gen-4', choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] };
        })()
      );

      const content: string[] = [];
      for await (const chunk of backend.chatStream({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test' }],
      })) {
        if (chunk.delta.content) content.push(chunk.delta.content);
      }
      expect(content).toEqual(['Hi']);
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
  describe('structured output with tools', () => {
    const schema = {
      type: 'object',
      properties: { units: { type: 'integer' } },
      required: ['units'],
    };
    const tools: ToolSchema[] = [
      {
        name: 'warehouse_stock',
        description: 'Stock of an item',
        parameters: { type: 'object', properties: { item: { type: 'string' } } },
      },
    ];
    const responseFormat = {
      type: 'json_schema' as const,
      jsonSchema: { name: 'Stock', schema },
    };
    const answer = {
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: '{"units":1}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const openRouter = () =>
      new OpenAIBackend({
        apiKey: 'test-api-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        provider: 'openrouter',
      });
    type SentMessage = { role: string; content: unknown };
    const sent = () =>
      mockCreate.mock.calls[0][0] as { response_format?: unknown; messages: SentMessage[] };

    it('moves the schema into the system prompt for an OpenAI-compatible server', async () => {
      mockCreate.mockResolvedValueOnce(answer);

      await openRouter().chat({
        model: 'deepseek/deepseek-v4-pro',
        messages: [
          { role: 'system', content: 'You manage a warehouse.' },
          { role: 'user', content: 'Stock?' },
        ],
        tools,
        responseFormat,
      });

      expect(sent().response_format).toBeUndefined();
      expect(sent().messages[0]).toEqual({
        role: 'system',
        content: `You manage a warehouse.\n\nWhen you give your final answer, respond with valid JSON only, conforming to this JSON schema:\n${JSON.stringify(schema)}`,
      });
      expect(sent().messages).toHaveLength(2);
    });

    it('adds a system message when the request has none', async () => {
      mockCreate.mockResolvedValueOnce(answer);

      await openRouter().chat({
        model: 'qwen/qwen3.8-flash',
        messages: [{ role: 'user', content: 'Stock?' }],
        tools,
        responseFormat: { type: 'json_object' },
      });

      expect(sent().response_format).toBeUndefined();
      expect(sent().messages[0]).toEqual({
        role: 'system',
        content: 'When you give your final answer, respond with valid JSON only.',
      });
    });

    it('keeps response_format when no tools are offered', async () => {
      mockCreate.mockResolvedValueOnce(answer);

      await openRouter().chat({
        model: 'deepseek/deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Stock?' }],
        responseFormat,
      });

      expect(sent().response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { name: 'Stock', schema },
      });
      expect(sent().messages).toEqual([{ role: 'user', content: 'Stock?' }]);
    });

    it('keeps response_format with tools on the official OpenAI API', async () => {
      mockCreate.mockResolvedValueOnce(answer);

      await backend.chat({
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'Stock?' }],
        tools,
        responseFormat,
      });

      expect(sent().response_format).toMatchObject({ type: 'json_schema' });
      expect(sent().messages).toEqual([{ role: 'user', content: 'Stock?' }]);
    });

    it('moves the schema into the prompt for streamed requests too', async () => {
      mockCreate.mockResolvedValueOnce(
        (async function* () {
          yield {
            id: 'c',
            choices: [{ delta: { content: '{"units":1}' }, finish_reason: 'stop' }],
          };
        })()
      );

      for await (const chunk of openRouter().chatStream({
        model: 'deepseek/deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Stock?' }],
        tools,
        responseFormat,
      })) {
        expect(chunk).toBeDefined();
      }

      expect(sent().response_format).toBeUndefined();
      expect(sent().messages[0]).toMatchObject({ role: 'system' });
    });
  });
  describe('reported cost', () => {
    it('reads the cost an OpenAI-compatible service adds to usage', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 6, completion_tokens: 10, total_tokens: 16, cost: 0.0000246 },
      });

      const response = await backend.chat({
        model: 'deepseek/deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Say hi' }],
      });

      expect(response.usage).toMatchObject({ inputTokens: 6, outputTokens: 10, cost: 0.0000246 });
    });

    it('reads it from the final chunk of a stream', async () => {
      mockCreate.mockResolvedValueOnce(
        (async function* () {
          yield { id: 'c', choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] };
          yield {
            id: 'c',
            choices: [],
            usage: { prompt_tokens: 6, completion_tokens: 10, total_tokens: 16, cost: 0.00003 },
          };
        })()
      );

      const usages = [];
      for await (const chunk of backend.chatStream({
        model: 'deepseek/deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Say hi' }],
      })) {
        if (chunk.usage) usages.push(chunk.usage);
      }

      expect(usages.at(-1)).toMatchObject({ cost: 0.00003 });
    });

    it('leaves cost out when the service reports none or a bad value', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 'free' },
      });

      const response = await backend.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.usage).not.toHaveProperty('cost');
    });
  });

  describe('turn outcome', () => {
    const vllm = () =>
      new OpenAIBackend({ apiKey: 'k', baseUrl: 'http://gpu:8000/v1', provider: 'vllm' });
    const completion = (message: Record<string, unknown>, finish_reason: string) => ({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: null, ...message }, finish_reason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const call = (args: string) => ({
      id: 'call_1',
      type: 'function',
      function: { name: 'purge', arguments: args },
    });
    const streamOf = (chunks: unknown[]) =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    const collect = async (b: OpenAIBackend) => {
      const chunks: Array<{ finishReason?: string; toolCalls?: unknown[]; content?: string }> = [];
      for await (const chunk of b.chatStream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      })) {
        chunks.push({
          finishReason: chunk.finishReason,
          toolCalls: chunk.delta.toolCalls,
          content: chunk.delta.content,
        });
      }
      return chunks;
    };

    it('reports tool calls answered with finish_reason stop as a tool turn', async () => {
      mockCreate.mockResolvedValueOnce(completion({ tool_calls: [call('{"days":3}')] }, 'stop'));

      const response = await vllm().chat({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(response.finishReason).toBe('tool_calls');
      expect(response.toolCalls).toEqual([{ id: 'call_1', name: 'purge', arguments: { days: 3 } }]);
    });

    it('reports a turn cut inside a tool call as truncated instead of failing on its arguments', async () => {
      mockCreate.mockResolvedValueOnce(completion({ tool_calls: [call('{"days":')] }, 'length'));

      const response = await vllm().chat({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(response.finishReason).toBe('length');
      expect(response.toolCalls).toBeUndefined();
    });

    it('streams a turn cut inside a tool call as truncated', async () => {
      mockCreate.mockResolvedValueOnce(
        streamOf([
          {
            id: 'c',
            choices: [{ delta: { tool_calls: [{ index: 0, ...call('{"days":') }] } }],
          },
          { id: 'c', choices: [{ delta: {}, finish_reason: 'length' }] },
        ])
      );

      const chunks = await collect(vllm());

      expect(chunks.at(-1)).toMatchObject({ finishReason: 'length', toolCalls: undefined });
    });

    it('reports a content filter stop as content_filter', async () => {
      mockCreate.mockResolvedValueOnce(completion({ content: '' }, 'content_filter'));

      const response = await backend.chat({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(response.finishReason).toBe('content_filter');
    });

    it('reports a refusal with its explanation', async () => {
      mockCreate.mockResolvedValueOnce(completion({ refusal: 'I cannot help with that.' }, 'stop'));

      const response = await backend.chat({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(response).toMatchObject({
        finishReason: 'refusal',
        content: 'I cannot help with that.',
      });
    });

    it('streams a refusal with its explanation', async () => {
      mockCreate.mockResolvedValueOnce(
        streamOf([
          { id: 'c', choices: [{ delta: { refusal: 'I cannot ' } }] },
          { id: 'c', choices: [{ delta: { refusal: 'help.' }, finish_reason: 'stop' }] },
        ])
      );

      const chunks = await collect(backend);

      expect(chunks.map((c) => c.content ?? '').join('')).toBe('I cannot help.');
      expect(chunks.at(-1)?.finishReason).toBe('refusal');
    });
  });
  describe('prompt caching of Claude on OpenRouter', () => {
    const answer = (
      usage: Record<string, unknown> = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    ) => ({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage,
    });
    const openRouter = (provider: 'openrouter' | 'gateway' = 'openrouter') =>
      new OpenAIBackend({
        apiKey: 'test-api-key',
        baseUrl: 'https://openrouter.ai/api/v1',
        provider,
      });
    const messages = [{ role: 'user' as const, content: 'Hi' }];
    const sentCacheControl = (call = 0) =>
      (mockCreate.mock.calls[call][0] as { cache_control?: unknown }).cache_control;

    it('marks a Claude request for caching, with the TTL when one is set', async () => {
      mockCreate.mockResolvedValueOnce(answer()).mockResolvedValueOnce(answer());

      await openRouter().chat({ model: 'anthropic/claude-sonnet-5.5', messages, cache: {} });
      await openRouter().chat({
        model: 'anthropic/claude-sonnet-5.5',
        messages,
        cache: { ttl: '1h' },
      });

      expect(sentCacheControl(0)).toEqual({ type: 'ephemeral' });
      expect(sentCacheControl(1)).toEqual({ type: 'ephemeral', ttl: '1h' });
    });

    it('marks a streamed Claude request too', async () => {
      mockCreate.mockResolvedValueOnce(
        (async function* () {
          yield { id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        })()
      );

      const chunks = [];
      for await (const chunk of openRouter().chatStream({
        model: 'anthropic/claude-haiku-4.5',
        messages,
        cache: {},
      }))
        chunks.push(chunk);

      expect(chunks.length).toBeGreaterThan(0);
      expect(sentCacheControl()).toEqual({ type: 'ephemeral' });
    });

    it('sends no cache_control when caching is off, for other models, or to other servers', async () => {
      mockCreate.mockResolvedValue(answer());

      await openRouter().chat({ model: 'anthropic/claude-sonnet-5.5', messages, cache: false });
      await openRouter().chat({ model: 'openai/gpt-6-luna', messages, cache: {} });
      await openRouter().chat({ model: 'google/gemini-3.5-flash', messages, cache: {} });
      await new OpenAIBackend({
        apiKey: 'test-api-key',
        baseUrl: 'https://llm-gateway.internal/v1',
        provider: 'gateway',
      }).chat({ model: 'anthropic/claude-sonnet-5.5', messages, cache: {} });
      await backend.chat({ model: 'gpt-4o-mini', messages, cache: {} });

      expect(mockCreate.mock.calls.length).toBe(5);
      for (let call = 0; call < 5; call++) expect(sentCacheControl(call)).toBeUndefined();
    });

    it('recognizes OpenRouter by its host when the provider has another name', async () => {
      mockCreate.mockResolvedValueOnce(answer());

      await openRouter('gateway').chat({
        model: 'anthropic/claude-sonnet-5.5',
        messages,
        cache: {},
      });

      expect(sentCacheControl()).toEqual({ type: 'ephemeral' });
    });

    it('reports cache reads and writes from the usage', async () => {
      mockCreate.mockResolvedValueOnce(
        answer({
          prompt_tokens: 13517,
          completion_tokens: 5,
          total_tokens: 13522,
          cost: 0.016751295,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 13514 },
        })
      );
      mockCreate.mockResolvedValueOnce(
        answer({
          prompt_tokens: 13517,
          completion_tokens: 5,
          total_tokens: 13522,
          cost: 0.001365606,
          prompt_tokens_details: { cached_tokens: 13514, cache_write_tokens: 0 },
        })
      );

      const first = await openRouter().chat({
        model: 'anthropic/claude-haiku-4.5',
        messages,
        cache: {},
      });
      const second = await openRouter().chat({
        model: 'anthropic/claude-haiku-4.5',
        messages,
        cache: {},
      });

      expect(first.usage).toMatchObject({ cacheWriteTokens: 13514, cost: 0.016751295 });
      expect(first.usage.cachedInputTokens).toBeUndefined();
      expect(second.usage).toMatchObject({ cachedInputTokens: 13514, cost: 0.001365606 });
      expect(second.usage.cacheWriteTokens).toBeUndefined();
    });
  });
});
