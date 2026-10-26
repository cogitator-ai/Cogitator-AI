import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  resolveOllamaConnection,
  resolveOllamaUrl,
  listOllamaModels,
  pullOllamaModel,
  environmentConnection,
} = vi.hoisted(() => {
  const resolveOllamaUrl = vi.fn();
  return {
    resolveOllamaConnection: vi.fn(),
    resolveOllamaUrl,
    listOllamaModels: vi.fn(),
    pullOllamaModel: vi.fn(),
    environmentConnection: vi.fn((env, url) => {
      const apiKey = (env ?? process.env).OLLAMA_API_KEY;
      return {
        baseUrl: resolveOllamaUrl(env, url),
        ...(apiKey ? { apiKey } : {}),
      };
    }),
  };
});

vi.mock('../utils/ollama.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/ollama.js')>();
  return {
    ...actual,
    resolveOllamaConnection,
    resolveOllamaUrl,
    listOllamaModels,
    pullOllamaModel,
    environmentConnection,
  };
});

import { log } from '../utils/logger.js';
import { formatSize, formatDate, modelsCommand } from '../commands/models.js';

const DAY = 1000 * 60 * 60 * 24;
const NOW = new Date('2026-10-02T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  resolveOllamaConnection.mockReturnValue({ baseUrl: 'http://localhost:11434' });
  resolveOllamaUrl.mockReturnValue('http://localhost:11434');
  listOllamaModels.mockResolvedValue([]);
  pullOllamaModel.mockResolvedValue(undefined);
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(log, 'dim').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('modelsCommand', () => {
  it('forwards configured Ollama credentials when listing models', async () => {
    const headers = { 'X-Gateway-Key': 'secret' };
    resolveOllamaConnection.mockReturnValue({
      baseUrl: 'http://localhost:11434',
      apiKey: 'config-key',
      headers,
    });

    await modelsCommand.parseAsync(['--json'], { from: 'user' });

    expect(listOllamaModels).toHaveBeenCalledWith('http://localhost:11434', {
      apiKey: 'config-key',
      headers,
    });
  });

  it('forwards configured Ollama credentials when pulling a model', async () => {
    const headers = { 'X-Gateway-Key': 'secret' };
    resolveOllamaConnection.mockReturnValue({
      baseUrl: 'http://localhost:11434',
      apiKey: 'config-key',
      headers,
    });

    await modelsCommand.parseAsync(['--pull', 'qwen3:8b', '--json'], { from: 'user' });

    expect(pullOllamaModel).toHaveBeenCalledWith(
      'http://localhost:11434',
      'qwen3:8b',
      expect.any(Function),
      { apiKey: 'config-key', headers }
    );
  });

  it('passes an explicit --url to the shared config helper', async () => {
    resolveOllamaConnection.mockReturnValue({ baseUrl: 'http://other.example' });

    await modelsCommand.parseAsync(['--url', 'http://other.example', '--json'], { from: 'user' });

    expect(resolveOllamaConnection).toHaveBeenCalledWith({ url: 'http://other.example' });
    expect(listOllamaModels).toHaveBeenCalledWith(
      'http://other.example',
      expect.objectContaining({})
    );
  });

  it('warns on stderr and emits valid JSON on stdout when the config cannot be read', async () => {
    resolveOllamaConnection.mockImplementation(() => {
      throw new Error('COGITATOR_CONFIG points to a missing file: missing.yml');
    });
    resolveOllamaUrl.mockReturnValue('http://env.example');
    vi.stubEnv('OLLAMA_API_KEY', 'env-key');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await modelsCommand.parseAsync(['--json'], { from: 'user' });

    expect(resolveOllamaUrl).toHaveBeenCalledWith(process.env, undefined);
    expect(listOllamaModels).toHaveBeenCalledWith('http://env.example', {
      apiKey: 'env-key',
      headers: undefined,
    });
    expect(errSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('COGITATOR_CONFIG points to a missing file')
    );
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
      ok: true,
      url: 'http://env.example',
      models: [],
    });
  });

  it('fails safely on pull when the config cannot be read instead of falling back to another server', async () => {
    resolveOllamaConnection.mockImplementation(() => {
      throw new Error('Invalid configuration:\nlimits.maxConcurrentRuns: Expected number');
    });

    await expect(
      modelsCommand.parseAsync(['--pull', 'qwen3:8b'], { from: 'user' })
    ).rejects.toThrow(
      'Cannot read the Ollama configuration: Invalid configuration: limits.maxConcurrentRuns: Expected number'
    );

    expect(pullOllamaModel).not.toHaveBeenCalled();
  });
});

describe('formatSize', () => {
  it('formats bytes less than 1 GB as MB', () => {
    expect(formatSize(512 * 1024 * 1024)).toBe('512 MB');
  });

  it('formats bytes >= 1 GB as GB', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  it('formats fractional GB', () => {
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});

describe('formatDate', () => {
  it('returns "today" for same day', () => {
    expect(formatDate(ago(0), NOW)).toBe('today');
  });

  it('returns "yesterday" for 1 day ago', () => {
    expect(formatDate(ago(1), NOW)).toBe('yesterday');
  });

  it('returns "N days ago" for 2-6 days', () => {
    expect(formatDate(ago(3), NOW)).toBe('3 days ago');
  });

  it('uses singular week/month/year', () => {
    expect(formatDate(ago(7), NOW)).toBe('1 week ago');
    expect(formatDate(ago(35), NOW)).toBe('1 month ago');
    expect(formatDate(ago(400), NOW)).toBe('1 year ago');
  });

  it('uses plural units', () => {
    expect(formatDate(ago(14), NOW)).toBe('2 weeks ago');
    expect(formatDate(ago(60), NOW)).toBe('2 months ago');
    expect(formatDate(ago(800), NOW)).toBe('2 years ago');
  });

  it('treats future timestamps as today', () => {
    expect(formatDate(ago(-3), NOW)).toBe('today');
  });

  it('returns "unknown" for invalid dates', () => {
    expect(formatDate('not-a-date', NOW)).toBe('unknown');
    expect(formatDate('', NOW)).toBe('unknown');
  });
});
