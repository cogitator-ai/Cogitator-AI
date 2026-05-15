import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzureOpenAIBackend } from '../llm/azure';

const mockCreate = vi.fn();

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

  class MockAzureOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
    baseURL = 'https://my-resource.openai.azure.com';
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
    AzureOpenAI: MockAzureOpenAI,
  };
});

describe('AzureOpenAIBackend', () => {
  let backend: AzureOpenAIBackend;

  beforeEach(() => {
    backend = new AzureOpenAIBackend({
      endpoint: 'https://my-resource.openai.azure.com',
      apiKey: 'test-azure-key',
      deployment: 'gpt-4o',
    });
    mockCreate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates instance with config', () => {
      const b = new AzureOpenAIBackend({
        endpoint: 'https://my-resource.openai.azure.com',
        apiKey: 'key-123',
        apiVersion: '2024-10-01',
        deployment: 'gpt-4o-mini',
      });
      expect(b).toBeInstanceOf(AzureOpenAIBackend);
    });

    it('uses default apiVersion when not specified', () => {
      const b = new AzureOpenAIBackend({
        endpoint: 'https://my-resource.openai.azure.com',
        apiKey: 'key-123',
      });
      expect(b).toBeInstanceOf(AzureOpenAIBackend);
    });
  });

  it('provider is azure', () => {
    expect(backend.provider).toBe('azure');
  });

  describe('chat', () => {
    it('sends request and returns response', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-azure-123',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from Azure!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });

      const response = await backend.chat({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.id).toBe('chatcmpl-azure-123');
      expect(response.content).toBe('Hello from Azure!');
      expect(response.finishReason).toBe('stop');
      expect(response.usage).toEqual({
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
    });

    it('uses deployment as fallback model when model is empty', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-azure-456',
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });

      await backend.chat({
        model: '',
        messages: [{ role: 'user', content: 'Test' }],
      });

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
    });

    it('handles errors', async () => {
      const err = new Error('Service unavailable') as Error & { status?: number };
      err.status = 503;
      mockCreate.mockRejectedValueOnce(err);

      await expect(
        backend.chat({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test' }],
        })
      ).rejects.toThrow(/Service unavailable/);
    });

    it('passes generation config through', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-azure-789',
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });

      await backend.chat({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.5,
        maxTokens: 200,
        topP: 0.8,
        stop: ['STOP'],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.5,
          max_tokens: 200,
          top_p: 0.8,
          stop: ['STOP'],
        })
      );
    });
  });

  describe('chatStream', () => {
    it('yields chunks', async () => {
      const mockStream = (async function* () {
        yield {
          id: 'chatcmpl-stream-1',
          choices: [{ delta: { content: 'Hello' } }],
        };
        yield {
          id: 'chatcmpl-stream-1',
          choices: [{ delta: { content: ' Azure!' }, finish_reason: 'stop' }],
        };
        yield {
          id: 'chatcmpl-stream-1',
          choices: [],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        };
      })();

      mockCreate.mockResolvedValueOnce(mockStream);

      const results: string[] = [];
      for await (const chunk of backend.chatStream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        if (chunk.delta.content) {
          results.push(chunk.delta.content);
        }
      }

      expect(results).toEqual(['Hello', ' Azure!']);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
    });

    it('handles streaming errors', async () => {
      const err = new Error('Rate limit exceeded') as Error & { status?: number };
      err.status = 429;
      mockCreate.mockRejectedValueOnce(err);

      await expect(async () => {
        for await (const _ of backend.chatStream({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test' }],
        })) {
          /* consume */
        }
      }).rejects.toThrow('Rate limit exceeded');
    });
  });
});
