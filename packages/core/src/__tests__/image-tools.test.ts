import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalyzeImageTool } from '../tools/image-analyze';
import { createGenerateImageTool } from '../tools/image-generate';
import type { LLMBackend, ChatResponse } from '@cogitator-ai/types';

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
      const result = await tool.execute({
        image: 'https://example.com/cat.jpg',
        prompt: 'What animal is this?',
      });

      expect(result.analysis).toBe('This is a photo of a cat.');
      expect(mockLlm.chat).toHaveBeenCalledWith({
        model: 'gpt-4o',
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
      const result = await tool.execute({
        image: { data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      });

      expect(result.analysis).toBe('A landscape photo.');
      expect(mockLlm.chat).toHaveBeenCalledWith({
        model: 'gpt-4o',
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

      const tool = createAnalyzeImageTool({ llm: mockLlm, defaultModel: 'gpt-4-turbo' });
      await tool.execute({
        image: 'https://example.com/image.jpg',
        model: 'claude-3-opus',
      });

      expect(mockLlm.chat).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3-opus' })
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
      await tool.execute({
        image: 'https://example.com/chart.png',
        detail: 'high',
      });

      expect(mockLlm.chat).toHaveBeenCalledWith({
        model: 'gpt-4o',
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

    it('generates image with default parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            created: 1234567890,
            data: [
              {
                url: 'https://oaidalleapi.blob.core.windows.net/image.png',
                revised_prompt: 'A cute fluffy cat sitting on a windowsill',
              },
            ],
          }),
      });

      const tool = createGenerateImageTool();
      const result = await tool.execute({ prompt: 'A cute cat' });

      expect(result.url).toBe('https://oaidalleapi.blob.core.windows.net/image.png');
      expect(result.revisedPrompt).toBe('A cute fluffy cat sitting on a windowsill');
      expect(result.size).toBe('1024x1024');
      expect(result.quality).toBe('standard');
      expect(result.style).toBe('vivid');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/images/generations',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        })
      );
    });

    it('uses custom parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            created: 1234567890,
            data: [{ url: 'https://example.com/image.png' }],
          }),
      });

      const tool = createGenerateImageTool();
      const result = await tool.execute({
        prompt: 'A landscape',
        size: '1792x1024',
        quality: 'hd',
        style: 'natural',
      });

      expect(result.size).toBe('1792x1024');
      expect(result.quality).toBe('hd');
      expect(result.style).toBe('natural');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.size).toBe('1792x1024');
      expect(callBody.quality).toBe('hd');
      expect(callBody.style).toBe('natural');
    });

    it('throws when API key is missing', async () => {
      delete process.env.OPENAI_API_KEY;

      const tool = createGenerateImageTool();
      await expect(tool.execute({ prompt: 'test' })).rejects.toThrow('OpenAI API key required');
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad request'),
      });

      const tool = createGenerateImageTool();
      await expect(tool.execute({ prompt: 'test' })).rejects.toThrow(
        'Image generation failed: 400'
      );
    });

    it('uses provided API key over environment', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            created: 1234567890,
            data: [{ url: 'https://example.com/image.png' }],
          }),
      });

      const tool = createGenerateImageTool({ apiKey: 'custom-key' });
      await tool.execute({ prompt: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer custom-key',
          }),
        })
      );
    });
  });
});
