import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { checkDocker, findDockerCompose, composePs } = vi.hoisted(() => ({
  checkDocker: vi.fn(),
  findDockerCompose: vi.fn(),
  composePs: vi.fn(),
}));

vi.mock('../utils/docker.js', () => ({
  checkDocker,
  findDockerCompose,
  composePs,
}));

import { modelsCommand } from '../commands/models.js';
import { collectStatus } from '../commands/status.js';

function headersOf(fetcher: ReturnType<typeof vi.fn>, index = 0): Record<string, string> {
  const init = fetcher.mock.calls[index]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('Ollama command authorization', () => {
  let dir: string;
  let cwd: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-ollama-auth-'));
    cwd = process.cwd();
    process.chdir(dir);
    for (const key of Object.keys(process.env)) {
      if (/^(COGITATOR_|OLLAMA_)/.test(key)) delete process.env[key];
    }
    writeFileSync(
      join(dir, 'cogitator.yml'),
      [
        'llm:',
        '  defaultModel: ollama/qwen3:8b',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://config.example',
        '      apiKey: config-key',
        '      headers:',
        '        X-Gateway-Key: secret',
        '        authorization: Bearer custom',
        '',
      ].join('\n')
    );
    checkDocker.mockReturnValue(false);
    findDockerCompose.mockReturnValue(null);
    composePs.mockReturnValue([]);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('models sends config credentials and lets the config apiKey replace custom authorization', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await modelsCommand.parseAsync(['--json'], { from: 'user' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://config.example/api/tags',
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(headersOf(fetchMock)).toEqual({
      'X-Gateway-Key': 'secret',
      Authorization: 'Bearer config-key',
    });
  });

  it('status sends config credentials and lets the config apiKey replace custom authorization', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    const report = await collectStatus();

    expect(report.ollama).toEqual({ url: 'http://config.example', running: true });
    expect(headersOf(fetchMock)).toEqual({
      'X-Gateway-Key': 'secret',
      Authorization: 'Bearer config-key',
    });
  });

  it('models --url uses the override without sending config credentials to another server', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await modelsCommand.parseAsync(['--url', 'http://other.example', '--json'], { from: 'user' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://other.example/api/tags');
    expect(headersOf(fetchMock)).toEqual({});
  });

  it('models --url sends OLLAMA_API_KEY from the environment without leaking config apiKey or custom headers', async () => {
    process.env.OLLAMA_API_KEY = 'env-key';
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await modelsCommand.parseAsync(['--url', 'http://other.example', '--json'], { from: 'user' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://other.example/api/tags');
    expect(headersOf(fetchMock)).toEqual({
      Authorization: 'Bearer env-key',
    });
  });

  it('models --url reads no config at all, not even the one COGITATOR_CONFIG names', async () => {
    process.env.COGITATOR_CONFIG = 'missing.yml';
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await modelsCommand.parseAsync(['--url', 'http://other.example', '--json'], { from: 'user' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://other.example/api/tags');
    expect(headersOf(fetchMock)).toEqual({});
  });

  it('status and models warn on stderr and emit valid JSON on stdout when config is invalid', async () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      ['limits:', '  maxConcurrentRuns: not-a-number', ''].join('\n')
    );
    process.env.OLLAMA_BASE_URL = 'http://env.example';
    process.env.OLLAMA_API_KEY = 'env-key';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await modelsCommand.parseAsync(['--json'], { from: 'user' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://env.example/api/tags');
    expect(headersOf(fetchMock)).toEqual({ Authorization: 'Bearer env-key' });
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
      ok: true,
      url: 'http://env.example',
      models: [{ name: 'qwen3:8b', size: 1, modifiedAt: '' }],
    });

    const report = await collectStatus();

    expect(report.ollama).toEqual({ url: 'http://env.example', running: true });
    expect(headersOf(fetchMock, 1)).toEqual({ Authorization: 'Bearer env-key' });
    expect(errSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('limits.maxConcurrentRuns')
    );
  });
});
