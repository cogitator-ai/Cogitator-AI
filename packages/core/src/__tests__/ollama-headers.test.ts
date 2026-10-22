import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMBackend } from '@cogitator-ai/types';
import { createLLMBackend } from '../llm';
import { OllamaBackend } from '../llm/ollama';

const fetchSpy = vi.fn<typeof fetch>();

async function requestChat(backend: LLMBackend, stream: boolean): Promise<void> {
  const request = {
    model: 'llama3.2',
    messages: [{ role: 'user' as const, content: 'Hi' }],
  };

  if (stream) {
    for await (const chunk of backend.chatStream(request)) {
      expect(chunk).toBeDefined();
    }
  } else {
    await backend.chat(request);
  }
}

describe('Ollama header validation', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { name: 'Invalid Header', value: 'secret', message: /invalid header name/i },
    { name: 'X-Gateway-Key', value: '€', message: /ByteString|255/i },
  ])('rejects invalid headers at construction (%j)', ({ name, value, message }) => {
    const createBackend = () =>
      new OllamaBackend({ baseUrl: 'http://localhost:11434', headers: { [name]: value } });

    expect(createBackend).toThrow(TypeError);
    expect(createBackend).toThrow(message);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe.each([false, true])('Ollama request headers (stream: %s)', (stream) => {
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'Hello' },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
        }) + '\n'
      )
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['', '/', '//', '////'])(
    'passes custom headers through the factory and trims trailing slashes (%j)',
    async (suffix) => {
      const backend = createLLMBackend('ollama', {
        providers: {
          ollama: {
            baseUrl: `http://host:11434${suffix}`,
            headers: { 'X-Gateway-Key': 'gateway-secret', 'X-Team': 'research' },
          },
        },
      });

      await requestChat(backend, stream);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://host:11434/api/chat');
      const headers = new Headers(options?.headers);
      expect(headers.get('x-gateway-key')).toBe('gateway-secret');
      expect(headers.get('x-team')).toBe('research');
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(options?.body as string)).toMatchObject({ stream });
    }
  );

  it.each(['Authorization', 'authorization', 'AUTHORIZATION'])(
    'lets apiKey override the custom %s header case-insensitively',
    async (headerName) => {
      const backend = new OllamaBackend({
        baseUrl: 'https://ollama.example.com',
        apiKey: 'ollama-secret',
        headers: { [headerName]: 'Bearer gateway-secret' },
      });

      await requestChat(backend, stream);

      const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
      expect(headers.get('authorization')).toBe('Bearer ollama-secret');
    }
  );

  it('preserves custom authorization when no apiKey is configured', async () => {
    const backend = new OllamaBackend({
      baseUrl: 'https://ollama.example.com',
      headers: { Authorization: 'Bearer gateway-secret' },
    });

    await requestChat(backend, stream);

    const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer gateway-secret');
  });

  it.each(['Content-Type', 'content-type'])(
    'keeps the JSON content type when custom headers contain %s',
    async (headerName) => {
      const backend = new OllamaBackend({
        baseUrl: 'http://localhost:11434',
        headers: { [headerName]: 'text/plain' },
      });

      await requestChat(backend, stream);

      const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
      expect(headers.get('content-type')).toBe('application/json');
    }
  );
});
