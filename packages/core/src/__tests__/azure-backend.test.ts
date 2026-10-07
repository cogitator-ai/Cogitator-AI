import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzureOpenAIBackend } from '../llm/azure';

const mockCreate = vi.fn();
const azureOptions: Array<Record<string, unknown>> = [];

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
    constructor(options: Record<string, unknown>) {
      azureOptions.push(options);
    }
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

  describe('turn outcome', () => {
    it('reports an answer stopped by the Azure content filter as content_filter', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      });

      const response = await backend.chat({
        model: '',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(response.finishReason).toBe('content_filter');
    });

    it('reports tool calls answered with finish_reason stop as a tool turn', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'purge', arguments: '{}' } },
              ],
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      const response = await backend.chat({
        model: '',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(response.finishReason).toBe('tool_calls');
    });
  });

  describe('reasoning deployments', () => {
    const answer = {
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const sent = () => mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const request = {
      messages: [{ role: 'user' as const, content: 'x' }],
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 500,
    };

    it('sends a deployment named after a reasoning model no sampling and max_completion_tokens', async () => {
      mockCreate.mockResolvedValueOnce(answer);

      await backend.chat({ model: 'gpt-5', ...request });

      expect(sent()).toMatchObject({ max_completion_tokens: 500 });
      expect(sent()).not.toHaveProperty('max_tokens');
      expect(sent()).not.toHaveProperty('temperature');
      expect(sent()).not.toHaveProperty('top_p');
    });

    it('reads the model family from the model hint when the deployment name does not say', async () => {
      const hinted = new AzureOpenAIBackend({
        endpoint: 'https://my-resource.openai.azure.com',
        apiKey: 'k',
        deployment: 'prod-chat',
        model: 'o4-mini',
      });
      mockCreate.mockResolvedValueOnce(answer);

      await hinted.chat({ model: '', ...request });

      expect(sent()).toMatchObject({ model: 'prod-chat', max_completion_tokens: 500 });
      expect(sent()).not.toHaveProperty('temperature');
    });

    it('keeps sampling and max_tokens for other deployments', async () => {
      mockCreate.mockResolvedValueOnce(answer);

      await backend.chat({ model: 'gpt-4o', ...request });

      expect(sent()).toMatchObject({ temperature: 0.7, top_p: 0.9, max_tokens: 500 });
    });

    it('defaults to an API version that serves reasoning models', () => {
      azureOptions.length = 0;
      new AzureOpenAIBackend({ endpoint: 'https://my-resource.openai.azure.com', apiKey: 'k' });

      expect(azureOptions[0]).toMatchObject({ apiVersion: '2025-04-01-preview' });
    });
  });
});
