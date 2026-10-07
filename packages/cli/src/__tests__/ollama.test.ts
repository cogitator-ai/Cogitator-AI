import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  listOllamaModels,
  pullOllamaModel,
  readNdjson,
  resolveOllamaUrl,
  type OllamaPullProgress,
} from '../utils/ollama.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveOllamaUrl', () => {
  it('defaults to localhost', () => {
    expect(resolveOllamaUrl({})).toBe('http://localhost:11434');
  });

  it('prefers configured URL, then OLLAMA_URL, then OLLAMA_HOST', () => {
    const env = { OLLAMA_URL: 'https://a.example', OLLAMA_HOST: 'b:1' };
    expect(resolveOllamaUrl(env, 'https://cfg.example/')).toBe('https://cfg.example');
    expect(resolveOllamaUrl(env)).toBe('https://a.example');
    expect(resolveOllamaUrl({ OLLAMA_HOST: '127.0.0.1:11434' })).toBe('http://127.0.0.1:11434');
  });

  it('ignores blank values', () => {
    expect(resolveOllamaUrl({ OLLAMA_URL: '  ' }, '')).toBe('http://localhost:11434');
  });

  it('reads OLLAMA_HOST the way Ollama does: default port 11434, 0.0.0.0 as localhost', () => {
    expect(resolveOllamaUrl({ OLLAMA_HOST: '0.0.0.0' })).toBe('http://localhost:11434');
    expect(resolveOllamaUrl({ OLLAMA_HOST: 'gpu-box' })).toBe('http://gpu-box:11434');
    expect(resolveOllamaUrl({ OLLAMA_BASE_URL: 'lan-box', OLLAMA_HOST: '0.0.0.0' })).toBe(
      'http://lan-box:11434'
    );
  });
});

describe('readNdjson', () => {
  it('reassembles JSON lines split across chunks', async () => {
    const events: unknown[] = [];
    for await (const event of readNdjson(streamOf(['{"a":', '1}\n{"b"', ':2}\n', '{"c":3}']))) {
      events.push(event);
    }
    expect(events).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('handles multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"s":"привет"}\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 9));
        controller.enqueue(bytes.slice(9));
        controller.close();
      },
    });
    const events: unknown[] = [];
    for await (const event of readNdjson(stream)) events.push(event);
    expect(events).toEqual([{ s: 'привет' }]);
  });
});

describe('listOllamaModels', () => {
  it('returns validated models and sends the API key', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ models: [{ name: 'llama3', size: 10, modified_at: 'x' }, { bogus: true }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = await listOllamaModels('http://h:1', { apiKey: 'k' });
    expect(models).toEqual([{ name: 'llama3', size: 10, modified_at: 'x' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://h:1/api/tags',
      expect.objectContaining({ headers: { Authorization: 'Bearer k' } })
    );
  });

  it('throws on HTTP errors and malformed payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 500 }))
    );
    await expect(listOllamaModels('http://h:1')).rejects.toThrow('HTTP 500');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ nope: 1 }))
    );
    await expect(listOllamaModels('http://h:1')).rejects.toThrow('Unexpected response');
  });
});

describe('pullOllamaModel', () => {
  it('reports progress and resolves on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            streamOf([
              '{"status":"pulling manifest"}\n{"status":"downloading","completed":5,"total":10}\n',
              '{"status":"success"}\n',
            ])
          )
      )
    );
    const progress: OllamaPullProgress[] = [];
    await pullOllamaModel('http://h:1', 'm', (p) => progress.push(p));
    expect(progress.map((p) => p.status)).toEqual(['pulling manifest', 'downloading', 'success']);
    expect(progress[1]).toMatchObject({ completed: 5, total: 10 });
  });

  it('rejects when the stream contains an error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            streamOf(['{"status":"pulling manifest"}\n{"error":"file does not exist"}\n'])
          )
      )
    );
    await expect(pullOllamaModel('http://h:1', 'missing', () => {})).rejects.toThrow(
      'file does not exist'
    );
  });

  it('rejects when the stream ends without success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamOf(['{"status":"pulling manifest"}\n'])))
    );
    await expect(pullOllamaModel('http://h:1', 'm', () => {})).rejects.toThrow(
      'stream ended before completion'
    );
  });

  it('sends the model field in the request body', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(streamOf(['{"status":"success"}']))
    );
    vi.stubGlobal('fetch', fetchMock);
    await pullOllamaModel('http://h:1', 'qwen2.5:0.5b', () => {});
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'qwen2.5:0.5b', stream: true });
  });
});
