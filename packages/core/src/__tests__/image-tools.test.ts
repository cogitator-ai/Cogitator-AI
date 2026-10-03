import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalyzeImageTool } from '../tools/image-analyze';
import { createGenerateImageTool } from '../tools/image-generate';
import type { LLMBackend, ChatResponse } from '@cogitator-ai/types';

const mockContext = {
  agentId: 'test-agent',
  runId: 'test-run',
  signal: new AbortController().signal,
};

describe('image tools', () => {
  describe('createAnalyzeImageTool', () => {
    const mockLlm: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(),
      chatStream: vi.fn(),
    };

    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('creates tool with correct metadata', () => {
      const tool = createAnalyzeImageTool({ llm: mockLlm });

      expect(tool.name).toBe('analyzeImage');
      expect(tool.description).toContain('Analyze an image');
    });

    it('analyzes image from URL', async () => {
      const mockResponse: ChatResponse = {
        id: 'test-id',
        content: 'This is a photo of a cat.',
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      };
      (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

      const tool = createAnalyzeImageTool({ llm: mockLlm });
      const result = await tool.execute(
        {
          image: 'https://example.com/cat.jpg',
          prompt: 'What animal is this?',
        },
        mockContext
      );

      expect(result.analysis).toBe('This is a photo of a cat.');
      expect(mockLlm.chat).toHaveBeenCalledWith({
        model: 'gpt-6.1-sol',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What animal is this?' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/cat.jpg', detail: 'auto' },
              },
            ],
          },
        ],
      });
    });

    it('analyzes image from base64', async () => {
      const mockResponse: ChatResponse = {
        id: 'test-id',
        content: 'A landscape photo.',
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      };
      (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

      const tool = createAnalyzeImageTool({ llm: mockLlm });
      const result = await tool.execute(
        {
          image: { data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        },
        mockContext
      );

      expect(result.analysis).toBe('A landscape photo.');
      expect(mockLlm.chat).toHaveBeenCalledWith({
        model: 'gpt-6.1-sol',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: expect.stringContaining('Describe this image') },
              {
                type: 'image_base64',
                image_base64: { data: 'iVBORw0KGgo=', media_type: 'image/png' },
              },
            ],
          },
        ],
      });
    });

    it('uses custom model when specified', async () => {
      const mockResponse: ChatResponse = {
        id: 'test-id',
        content: 'Analysis result',
        finishReason: 'stop',
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      };
      (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

      const tool = createAnalyzeImageTool({ llm: mockLlm, defaultModel: 'gpt-4.1' });
      await tool.execute(
        {
          image: 'https://example.com/image.jpg',
          model: 'claude-opus-4-5',
        },
        mockContext
      );

      expect(mockLlm.chat).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-5' })
      );
    });

    it('uses high detail when specified', async () => {
      const mockResponse: ChatResponse = {
        id: 'test-id',
        content: 'Detailed analysis',
        finishReason: 'stop',
        usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
      };
      (mockLlm.chat as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

      const tool = createAnalyzeImageTool({ llm: mockLlm });
      await tool.execute(
        {
          image: 'https://example.com/chart.png',
          detail: 'high',
        },
        mockContext
      );

      expect(mockLlm.chat).toHaveBeenCalledWith({
        model: 'gpt-6.1-sol',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: expect.any(String) },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/chart.png', detail: 'high' },
              },
            ],
          },
        ],
      });
    });
  });

  describe('createGenerateImageTool', () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;
    const originalEnv = process.env.OPENAI_API_KEY;

    beforeEach(() => {
      global.fetch = mockFetch;
      process.env.OPENAI_API_KEY = 'test-api-key';
    });

    afterEach(() => {
      global.fetch = originalFetch;
      process.env.OPENAI_API_KEY = originalEnv;
      mockFetch.mockReset();
    });

    it('creates tool with correct metadata', () => {
      const tool = createGenerateImageTool();

      expect(tool.name).toBe('generateImage');
      expect(tool.description).toContain('Generate an image');
      expect(tool.sideEffects).toContain('network');
    });

    it('generates image with gpt-image-2.5-flare by default and returns base64 data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            created: 1234567890,
            data: [{ b64_json: 'aW1hZ2U=' }],
            output_format: 'png',
          }),
      });

      const tool = createGenerateImageTool();
      const result = await tool.execute({ prompt: 'A cute cat' }, mockContext);

      expect(result).toEqual({
        imageBase64: 'aW1hZ2U=',
        mimeType: 'image/png',
        revisedPrompt: undefined,
        model: 'gpt-image-2.5-flare',
        size: 'auto',
        quality: 'auto',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/images/generations',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        })
      );

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody).toEqual({
        model: 'gpt-image-2.5-flare',
        prompt: 'A cute cat',
        n: 1,
        size: 'auto',
        quality: 'auto',
      });
    });

    it('maps legacy DALL-E quality values and drops unsupported style for gpt-image', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            created: 1234567890,
            data: [{ b64_json: 'aW1hZ2U=' }],
          }),
      });

      const tool = createGenerateImageTool();
      const result = await tool.execute(
        {
          prompt: 'A landscape',
          size: '1792x1024',
          quality: 'hd',
          style: 'natural',
        },
        mockContext
      );

      expect(result.size).toBe('1792x1024');
      expect(result.quality).toBe('high');
      expect(result.style).toBeUndefined();

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.size).toBe('1792x1024');
      expect(callBody.quality).toBe('high');
      expect(callBody.style).toBeUndefined();
      expect(callBody.response_format).toBeUndefined();
    });

    it('maps "standard" quality to medium and forwards output format and background', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ created: 1, data: [{ b64_json: 'd2VicA==' }] }),
      });

      const tool = createGenerateImageTool();
      const result = await tool.execute(
        {
          prompt: 'A logo',
          quality: 'standard',
          outputFormat: 'webp',
          background: 'transparent',
        },
        mockContext
      );

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.quality).toBe('medium');
      expect(callBody.output_format).toBe('webp');
      expect(callBody.background).toBe('transparent');
      expect(result.mimeType).toBe('image/webp');
      expect(result.imageBase64).toBe('d2VicA==');
    });

    it('keeps the legacy DALL-E request shape for dall-e models', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            created: 1234567890,
            data: [
              {
                url: 'https://example.com/image.png',
                revised_prompt: 'A cute fluffy cat sitting on a windowsill',
              },
            ],
          }),
      });

      const tool = createGenerateImageTool({
        model: 'dall-e-3',
        baseUrl: 'http://localhost:8080/v1',
      });
      const result = await tool.execute({ prompt: 'A cute cat', style: 'natural' }, mockContext);

      expect(result.url).toBe('https://example.com/image.png');
      expect(result.imageBase64).toBeUndefined();
      expect(result.revisedPrompt).toBe('A cute fluffy cat sitting on a windowsill');
      expect(result.size).toBe('1024x1024');
      expect(result.quality).toBe('standard');
      expect(result.style).toBe('natural');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody).toEqual({
        model: 'dall-e-3',
        prompt: 'A cute cat',
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        style: 'natural',
        response_format: 'url',
      });
    });

    it('throws when the response contains no image', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ created: 1, data: [] }),
      });

      const tool = createGenerateImageTool();
      await expect(tool.execute({ prompt: 'test' }, mockContext)).rejects.toThrow(
        'Image generation failed: response contained no image'
      );
    });

    it('throws when API key is missing', async () => {
      delete process.env.OPENAI_API_KEY;

      const tool = createGenerateImageTool();
      await expect(tool.execute({ prompt: 'test' }, mockContext)).rejects.toThrow(
        'OpenAI API key required'
      );
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      });

      const tool = createGenerateImageTool();
      await expect(tool.execute({ prompt: 'test' }, mockContext)).rejects.toThrow(
        'Image generation failed: 400'
      );
    });

    it('uses provided API key over environment', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            created: 1234567890,
            data: [{ b64_json: 'aW1hZ2U=' }],
          }),
      });

      const tool = createGenerateImageTool({ apiKey: 'custom-key' });
      await tool.execute({ prompt: 'test' }, mockContext);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer custom-key',
          }),
        })
      );
    });

    it('honors the tool context abort signal', async () => {
      const controller = new AbortController();
      controller.abort();
      mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(true);
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      const tool = createGenerateImageTool({ apiKey: 'custom-key' });

      await expect(
        tool.execute({ prompt: 'test' }, { ...mockContext, signal: controller.signal })
      ).rejects.toThrow('Image generation request aborted');
    });
  });
});
