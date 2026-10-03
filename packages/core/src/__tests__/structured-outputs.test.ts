import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleBackend } from '../llm/google';
import { OllamaBackend } from '../llm/ollama';
import type { LLMResponseFormat } from '@cogitator-ai/types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Structured Outputs / JSON Mode', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GoogleBackend', () => {
    let backend: GoogleBackend;

    beforeEach(() => {
      backend = new GoogleBackend({ apiKey: 'test-key' });
      mockFetch.mockReset();
    });

    it('should include responseMimeType for json_object format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '{"result": "test"}' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
        }),
      });

      await backend.chat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Return JSON' }],
        responseFormat: { type: 'json_object' },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema).toBeUndefined();
    });

    it('should include responseSchema for json_schema format', async () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '{"name": "John", "age": 30}' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 15, totalTokenCount: 20 },
        }),
      });

      await backend.chat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Return person data' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'person',
            description: 'Person information',
            schema,
          },
        },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema).toEqual(schema);
    });

    function geminiReply() {
      return {
        ok: true,
        json: async () => ({
          candidates: [
            { content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      };
    }

    const tools = [
      {
        name: 'lookup',
        description: 'Look up',
        parameters: { type: 'object' as const, properties: { q: { type: 'string' } } },
      },
    ];
    const schemaFormat: LLMResponseFormat = {
      type: 'json_schema',
      jsonSchema: {
        name: 'r',
        schema: {
          type: 'object',
          properties: { a: { type: 'number' } },
          required: ['a'],
          additionalProperties: false,
        },
      },
    };

    it('puts the schema in the instructions for Gemini 2 when tools are present', async () => {
      mockFetch.mockResolvedValueOnce(geminiReply());

      await backend.chat({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'x' },
        ],
        tools,
        responseFormat: schemaFormat,
      });

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.generationConfig?.responseMimeType).toBeUndefined();
      expect(body.systemInstruction.parts[0].text).toMatch(/^Be brief\.\n\n.*valid JSON only/s);
    });

    it('sends the JSON mime type with tools to Gemini 3, without unsupported keywords', async () => {
      mockFetch.mockResolvedValueOnce(geminiReply());

      await backend.chat({
        model: 'gemini-3.5-flash-lite',
        messages: [{ role: 'user', content: 'x' }],
        tools,
        responseFormat: schemaFormat,
      });

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema).toEqual({
        type: 'object',
        properties: { a: { type: 'number' } },
        required: ['a'],
      });
    });

    it('should not include responseFormat for text type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hello!' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        }),
      });

      await backend.chat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Say hello' }],
        responseFormat: { type: 'text' },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.generationConfig?.responseMimeType).toBeUndefined();
    });
  });

  describe('OllamaBackend', () => {
    let backend: OllamaBackend;

    beforeEach(() => {
      backend = new OllamaBackend({ baseUrl: 'http://localhost:11434' });
      mockFetch.mockReset();
    });

    it('should set format to "json" for json_object', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: '{"data": "test"}' },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
        }),
      });

      await backend.chat({
        model: 'llama2',
        messages: [{ role: 'user', content: 'Return JSON' }],
        responseFormat: { type: 'json_object' },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.format).toBe('json');
    });

    it('should set format to schema for json_schema', async () => {
      const schema = {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' } },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: '{"items": ["a", "b"]}' },
          done: true,
          prompt_eval_count: 10,
          eval_count: 8,
        }),
      });

      await backend.chat({
        model: 'llama2',
        messages: [{ role: 'user', content: 'Return items' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'items_list',
            schema,
          },
        },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.format).toEqual(schema);
    });

    it('should not include format for text type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'Hello!' },
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
        }),
      });

      await backend.chat({
        model: 'llama2',
        messages: [{ role: 'user', content: 'Say hello' }],
        responseFormat: { type: 'text' },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.format).toBeUndefined();
    });

    it('should not include format when responseFormat is undefined', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama2',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'Hello!' },
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
        }),
      });

      await backend.chat({
        model: 'llama2',
        messages: [{ role: 'user', content: 'Say hello' }],
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.format).toBeUndefined();
    });
  });

  describe('LLMResponseFormat type', () => {
    it('should accept text format', () => {
      const format: LLMResponseFormat = { type: 'text' };
      expect(format.type).toBe('text');
    });

    it('should accept json_object format', () => {
      const format: LLMResponseFormat = { type: 'json_object' };
      expect(format.type).toBe('json_object');
    });

    it('should accept json_schema format', () => {
      const format: LLMResponseFormat = {
        type: 'json_schema',
        jsonSchema: {
          name: 'test_schema',
          description: 'A test schema',
          schema: {
            type: 'object',
            properties: {},
          },
          strict: true,
        },
      };
      expect(format.type).toBe('json_schema');
      expect(format.jsonSchema.name).toBe('test_schema');
      expect(format.jsonSchema.strict).toBe(true);
    });
  });
});
