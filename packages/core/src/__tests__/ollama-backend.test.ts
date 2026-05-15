import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaBackend } from '../llm/ollama';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../utils/image-fetch', () => ({
  fetchImageAsBase64: vi
    .fn()
    .mockResolvedValue({ data: 'base64imagedata', mediaType: 'image/png' }),
}));

describe('OllamaBackend', () => {
  let backend: OllamaBackend;

  beforeEach(() => {
    backend = new OllamaBackend({ baseUrl: 'http://localhost:11434' });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates instance with baseUrl', () => {
      expect(backend.provider).toBe('ollama');
    });

    it('strips trailing slash from baseUrl', () => {
      const backendWithSlash = new OllamaBackend({ baseUrl: 'http://localhost:11434/' });
      expect(backendWithSlash.provider).toBe('ollama');
    });
  });

  describe('chat', () => {
    it('makes correct API request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'Hello!' },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
        }),
      });

      await backend.chat({
        model: 'llama3.2',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:11434/api/chat');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body as string);
      expect(body.model).toBe('llama3.2');
      expect(body.messages).toHaveLength(2);
      expect(body.stream).toBe(false);
    });

    it('passes abort signal to fetch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'Hello!' },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
        }),
      });
      const controller = new AbortController();

      await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Hello' }],
        signal: controller.signal,
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.signal).toBe(controller.signal);
    });

    it('returns correct response structure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'Hello!' },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
        }),
      });

      const response = await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.content).toBe('Hello!');
      expect(response.finishReason).toBe('stop');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
      expect(response.usage.totalTokens).toBe(15);
    });

    it('handles tool calls', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2024-01-01T00:00:00Z',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'get_weather',
                  arguments: { city: 'Tokyo' },
                },
              },
            ],
          },
          done: true,
          prompt_eval_count: 20,
          eval_count: 15,
        }),
      });

      const response = await backend.chat({
        model: 'llama3.2',
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
      expect(response.toolCalls![0].name).toBe('get_weather');
      expect(response.toolCalls![0].arguments).toEqual({ city: 'Tokyo' });
      expect(response.finishReason).toBe('tool_calls');
    });

    it('includes tools in request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'OK' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llama3.2',
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

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.tools).toEqual([
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
      ]);
    });

    it('includes generation options', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'OK' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1000,
        stop: ['END'],
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.options).toEqual({
        temperature: 0.7,
        top_p: 0.9,
        num_predict: 1000,
        stop: ['END'],
      });
    });

    it('handles connection errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        backend.chat({
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow(/Failed to connect to Ollama/);
    });

    it('handles API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Model not found',
      });

      await expect(
        backend.chat({
          model: 'nonexistent-model',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow();
    });

    it('handles json_object response format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: '{"result": "ok"}' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Test' }],
        responseFormat: { type: 'json_object' },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.format).toBe('json');
    });

    it('handles json_schema response format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: '{"name": "John"}' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Test' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'person',
            schema: {
              type: 'object',
              properties: { name: { type: 'string' } },
            },
          },
        },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.format).toEqual({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
    });

    it('handles tool choice - auto', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'OK' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [{ name: 'tool1', description: 'Tool 1', parameters: { type: 'object' } }],
        toolChoice: 'auto',
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.tools).toHaveLength(1);
    });

    it('handles tool choice - none', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'OK' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [{ name: 'tool1', description: 'Tool 1', parameters: { type: 'object' } }],
        toolChoice: 'none',
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.tools).toBeUndefined();
    });

    it('handles tool choice - specific function', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'OK' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [
          { name: 'tool1', description: 'Tool 1', parameters: { type: 'object' } },
          { name: 'tool2', description: 'Tool 2', parameters: { type: 'object' } },
        ],
        toolChoice: { function: { name: 'tool2' } },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].function.name).toBe('tool2');
    });

    it('handles multimodal content with base64 images', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llava',
          message: { role: 'assistant', content: 'I see an image.' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llava',
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

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.messages[0].content).toBe('What is this?');
      expect(body.messages[0].images).toEqual(['base64data']);
    });

    it('handles multimodal content with image URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llava',
          message: { role: 'assistant', content: 'I see an image.' },
          done: true,
        }),
      });

      await backend.chat({
        model: 'llava',
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

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.messages[0].content).toBe('What is this?');
      expect(body.messages[0].images).toEqual(['base64imagedata']);
    });

    it('handles missing usage metrics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'OK' },
          done: true,
        }),
      });

      const response = await backend.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Test' }],
      });

      expect(response.usage.inputTokens).toBe(0);
      expect(response.usage.outputTokens).toBe(0);
      expect(response.usage.totalTokens).toBe(0);
    });
  });

  describe('chatStream', () => {
    it('streams text responses', async () => {
      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'Hello' },
          done: false,
        }) + '\n',
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: ' world!' },
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
        }) + '\n',
      ];

      let chunkIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (chunkIndex < chunks.length) {
            return { done: false, value: encoder.encode(chunks[chunkIndex++]) };
          }
          return { done: true, value: undefined };
        }),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      const results: string[] = [];
      for await (const chunk of backend.chatStream({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.delta.content) {
          results.push(chunk.delta.content);
        }
      }

      expect(results).toEqual(['Hello', ' world!']);
    });

    it('streams tool calls', async () => {
      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({
          model: 'llama3.2',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'get_weather',
                  arguments: { city: 'Tokyo' },
                },
              },
            ],
          },
          done: true,
          prompt_eval_count: 10,
          eval_count: 8,
        }) + '\n',
      ];

      let chunkIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (chunkIndex < chunks.length) {
            return { done: false, value: encoder.encode(chunks[chunkIndex++]) };
          }
          return { done: true, value: undefined };
        }),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      const toolCalls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Weather?' }],
      })) {
        if (chunk.delta.toolCalls) {
          toolCalls.push(...chunk.delta.toolCalls);
        }
      }

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        name: 'get_weather',
        arguments: { city: 'Tokyo' },
      });
    });

    it('yields usage in final chunk', async () => {
      const encoder = new TextEncoder();
      const chunks = [
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'Hi' },
          done: true,
          prompt_eval_count: 10,
          eval_count: 1,
        }) + '\n',
      ];

      let chunkIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (chunkIndex < chunks.length) {
            return { done: false, value: encoder.encode(chunks[chunkIndex++]) };
          }
          return { done: true, value: undefined };
        }),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      let finalUsage;
      for await (const chunk of backend.chatStream({
        model: 'llama3.2',
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

    it('uses correct streaming endpoint', async () => {
      const mockReader = {
        read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });

      for await (const _ of backend.chatStream({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Test' }],
      })) {
        /* consume stream */
      }

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:11434/api/chat');
      const body = JSON.parse(options.body as string);
      expect(body.stream).toBe(true);
    });

    it('handles streaming errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(async () => {
        for await (const _ of backend.chatStream({
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'Test' }],
        })) {
          /* consume stream */
        }
      }).rejects.toThrow(/Failed to connect to Ollama/);
    });

    it('handles missing response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: null,
      });

      await expect(async () => {
        for await (const _ of backend.chatStream({
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'Test' }],
        })) {
          /* consume stream */
        }
      }).rejects.toThrow(/No response body/);
    });
  });
});
