/**
 * Tests for Google Gemini Backend
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleBackend } from '../llm/google';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GoogleBackend', () => {
  let backend: GoogleBackend;

  beforeEach(() => {
    backend = new GoogleBackend({
      apiKey: 'test-api-key',
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default baseUrl', () => {
      expect(backend.provider).toBe('google');
    });

    it('should accept custom baseUrl', () => {
      const customBackend = new GoogleBackend({
        apiKey: 'test-key',
        baseUrl: 'https://custom.api.com',
      });
      expect(customBackend.provider).toBe('google');
    });
  });

  describe('chat', () => {
    it('should make correct API request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Hello! How can I help you?' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 8,
            totalTokenCount: 18,
          },
        }),
      });

      await backend.chat({
        model: 'gemini-1.5-flash',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('gemini-1.5-flash:generateContent');
      expect(url).toContain('key=test-api-key');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body as string);
      expect(body.systemInstruction).toBeDefined();
      expect(body.contents).toHaveLength(1);
      expect(body.contents[0].role).toBe('user');
    });

    it('should return correct response structure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Hello!' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 3,
            totalTokenCount: 8,
          },
        }),
      });

      const response = await backend.chat({
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.content).toBe('Hello!');
      expect(response.finishReason).toBe('stop');
      expect(response.usage.inputTokens).toBe(5);
      expect(response.usage.outputTokens).toBe(3);
      expect(response.usage.totalTokens).toBe(8);
    });

    it('should handle tool calls', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'get_weather',
                      args: { city: 'Tokyo' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 15,
            totalTokenCount: 35,
          },
        }),
      });

      const response = await backend.chat({
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        ],
      });

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].name).toBe('get_weather');
      expect(response.toolCalls![0].arguments).toEqual({ city: 'Tokyo' });
    });

    it('should include tools in request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            totalTokenCount: 12,
          },
        }),
      });

      await backend.chat({
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [
          {
            name: 'my_tool',
            description: 'A test tool',
            parameters: {
              type: 'object',
              properties: {
                param1: { type: 'string' },
              },
            },
          },
        ],
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.tools).toBeDefined();
      expect(body.tools[0].functionDeclarations).toHaveLength(1);
      expect(body.tools[0].functionDeclarations[0].name).toBe('my_tool');
    });

    it('should handle tool results in messages', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'The weather in Tokyo is sunny.' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 30,
            candidatesTokenCount: 10,
            totalTokenCount: 40,
          },
        }),
      });

      await backend.chat({
        model: 'gemini-1.5-flash',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          { role: 'assistant', content: '' },
          {
            role: 'tool',
            content: '{"temperature": 25, "condition": "sunny"}',
            toolCallId: 'call_1',
            name: 'get_weather',
          },
        ],
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);

      const functionResponseContent = body.contents.find(
        (c: { parts: unknown[] }) =>
          c.parts.some((p) => typeof p === 'object' && p !== null && 'functionResponse' in p)
      );
      expect(functionResponseContent).toBeDefined();
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request: Invalid model',
      });

      await expect(
        backend.chat({
          model: 'invalid-model',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow('Gemini API error: 400');
    });

    it('should normalize model aliases', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 2,
            totalTokenCount: 7,
          },
        }),
      });

      await backend.chat({
        model: 'gemini-flash',
        messages: [{ role: 'user', content: 'Test' }],
      });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('gemini-1.5-flash:generateContent');
    });

    it('should include generation config', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'OK' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 2,
            totalTokenCount: 7,
          },
        }),
      });

      await backend.chat({
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1000,
        stop: ['END'],
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.generationConfig).toEqual({
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 1000,
        stopSequences: ['END'],
      });
    });

    it('should map finish reasons correctly', async () => {
      const testCases = [
        { reason: 'STOP', expected: 'stop' },
        { reason: 'MAX_TOKENS', expected: 'length' },
        { reason: 'SAFETY', expected: 'error' },
      ];

      for (const { reason, expected } of testCases) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'OK' }] },
                finishReason: reason,
              },
            ],
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 2,
              totalTokenCount: 7,
            },
          }),
        });

        const response = await backend.chat({
          model: 'gemini-1.5-flash',
          messages: [{ role: 'user', content: 'Test' }],
        });

        expect(response.finishReason).toBe(expected);
      }
    });
  });

  describe('chatStream', () => {
    it('should stream text responses', async () => {
      const encoder = new TextEncoder();
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
      ];

      let chunkIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (chunkIndex < chunks.length) {
            return { done: false, value: encoder.encode(chunks[chunkIndex++]) };
          }
          return { done: true, value: undefined };
        }),
        releaseLock: vi.fn(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => mockReader,
        },
      });

      const results: string[] = [];
      for await (const chunk of backend.chatStream({
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.delta.content) {
          results.push(chunk.delta.content);
        }
      }

      expect(results).toEqual(['Hello', ' world']);
    });

    it('should stream tool calls', async () => {
      const encoder = new TextEncoder();
      const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Tokyo"}}}]},"finishReason":"STOP"}]}\n\n',
      ];

      let chunkIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (chunkIndex < chunks.length) {
            return { done: false, value: encoder.encode(chunks[chunkIndex++]) };
          }
          return { done: true, value: undefined };
        }),
        releaseLock: vi.fn(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => mockReader,
        },
      });

      const toolCalls: unknown[] = [];
      for await (const chunk of backend.chatStream({
        model: 'gemini-1.5-flash',
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

    it('should use correct streaming endpoint', async () => {
      const mockReader = {
        read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
        releaseLock: vi.fn(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => mockReader,
        },
      });

      for await (const _ of backend.chatStream({
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'Test' }],
      })) { /* consume stream */ }

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('streamGenerateContent');
      expect(url).toContain('alt=sse');
    });

    it('should handle streaming API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(async () => {
        for await (const _ of backend.chatStream({
          model: 'gemini-1.5-flash',
          messages: [{ role: 'user', content: 'Test' }],
        })) { /* consume stream */ }
      }).rejects.toThrow('Gemini API error: 401');
    });
  });
});
