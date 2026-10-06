import { describe, it, expect, vi, afterEach } from 'vitest';
import * as clack from '@clack/prompts';
import {
  hasOllamaModel,
  listOllamaModels,
  pullOllamaModel,
  resolveOllamaUrl,
} from '../utils/ollama.js';
import { collectOptions } from '../prompts.js';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(clack.select).mockReset();
  vi.mocked(clack.confirm).mockReset();
});

describe('resolveOllamaUrl', () => {
  it('uses the variable the generated code reads, then OLLAMA_HOST, then the default', () => {
    expect(resolveOllamaUrl({ OLLAMA_BASE_URL: 'http://gpu:11434/' })).toBe('http://gpu:11434');
    expect(resolveOllamaUrl({ OLLAMA_HOST: '0.0.0.0:11500' })).toBe('http://0.0.0.0:11500');
    expect(resolveOllamaUrl({})).toBe('http://localhost:11434');
  });
});

describe('listOllamaModels', () => {
  it('returns the installed model names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ models: [{ name: 'qwen3.5:9b', size: 6_600_000_000 }] }))
    );

    expect(await listOllamaModels('http://localhost:11434')).toEqual([
      { name: 'qwen3.5:9b', size: 6_600_000_000 },
    ]);
  });

  it('returns undefined when Ollama is not reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    expect(await listOllamaModels('http://localhost:11434')).toBeUndefined();
  });
});

describe('hasOllamaModel', () => {
  const installed = [
    { name: 'llama3.2:latest', size: 1 },
    { name: 'qwen3.5:9b', size: 1 },
  ];

  it('matches an exact tag and the implicit latest tag', () => {
    expect(hasOllamaModel(installed, 'qwen3.5:9b')).toBe(true);
    expect(hasOllamaModel(installed, 'llama3.2')).toBe(true);
    expect(hasOllamaModel(installed, 'qwen3:8b')).toBe(false);
  });
});

describe('pullOllamaModel', () => {
  it('reports progress and resolves on success', async () => {
    const body = [
      '{"status":"pulling manifest"}',
      '{"status":"downloading","completed":50,"total":100}',
      '{"status":"success"}',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    const progress: string[] = [];

    await pullOllamaModel('http://localhost:11434', 'qwen3.5:9b', (status) =>
      progress.push(status)
    );

    expect(progress).toEqual(['pulling manifest', 'downloading 50%', 'success']);
  });

  it('throws the error Ollama streams back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"pull model manifest: file does not exist"}\n'))
    );

    await expect(pullOllamaModel('http://localhost:11434', 'nope:1b', () => {})).rejects.toThrow(
      /file does not exist/
    );
  });
});

describe('choosing an Ollama model interactively', () => {
  it('offers the recommended model and the installed ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ models: [{ name: 'qwen2.5:0.5b', size: 397_000_000 }] }))
    );
    vi.mocked(clack.select).mockResolvedValueOnce('qwen2.5:0.5b');
    vi.mocked(clack.confirm).mockResolvedValue(false);

    const options = await collectOptions({
      name: 'my-agents',
      template: 'basic',
      provider: 'ollama',
      packageManager: 'pnpm',
    });

    const modelPrompt = vi.mocked(clack.select).mock.calls[0][0];
    expect(modelPrompt.options.map((o) => o.value)).toEqual(['qwen3.5:9b', 'qwen2.5:0.5b']);
    expect(options.model).toBe('qwen2.5:0.5b');
  });

  it('does not ask when Ollama is not running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    vi.mocked(clack.confirm).mockResolvedValue(false);

    const options = await collectOptions({
      name: 'my-agents',
      template: 'basic',
      provider: 'ollama',
      packageManager: 'pnpm',
    });

    expect(clack.select).not.toHaveBeenCalled();
    expect(options.model).toBeUndefined();
  });
});
