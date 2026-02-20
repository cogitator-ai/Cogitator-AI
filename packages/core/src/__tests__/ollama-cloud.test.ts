import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaBackend } from '../llm/ollama';

describe('OllamaBackend Cloud Support', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'qwen3.5:cloud',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'Hello' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    });
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends Authorization header when apiKey is set', async () => {
    const backend = new OllamaBackend({
      baseUrl: 'https://ollama.com',
      apiKey: 'test-key-123',
    });

    await backend.chat({
      model: 'qwen3.5:cloud',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-key-123',
    });
  });

  it('does not send Authorization header without apiKey', async () => {
    const backend = new OllamaBackend({
      baseUrl: 'http://localhost:11434',
    });

    await backend.chat({
      model: 'llama3.2:3b',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).not.toHaveProperty('Authorization');
  });
});
