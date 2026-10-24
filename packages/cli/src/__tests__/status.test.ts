import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dirname, join } from 'node:path';

const {
  checkDocker,
  findDockerCompose,
  composePs,
  listOllamaModels,
  resolveOllamaConnection,
  resolveOllamaUrl,
} = vi.hoisted(() => ({
  checkDocker: vi.fn(),
  findDockerCompose: vi.fn(),
  composePs: vi.fn(),
  listOllamaModels: vi.fn(),
  resolveOllamaConnection: vi.fn(),
  resolveOllamaUrl: vi.fn(),
}));

vi.mock('../utils/docker.js', () => ({
  checkDocker,
  findDockerCompose,
  composePs,
}));

vi.mock('../utils/ollama.js', () => ({
  listOllamaModels,
  resolveOllamaConnection,
  resolveOllamaUrl,
}));

import { log } from '../utils/logger.js';
import { collectStatus } from '../commands/status.js';

describe('collectStatus', () => {
  beforeEach(() => {
    checkDocker.mockReset();
    findDockerCompose.mockReset();
    composePs.mockReset();
    listOllamaModels.mockReset();
    resolveOllamaConnection.mockReset().mockReturnValue({ baseUrl: 'http://localhost:11434' });
    resolveOllamaUrl.mockReset().mockReturnValue('http://localhost:11434');
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'dim').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reports Docker unavailable without querying compose', async () => {
    checkDocker.mockReturnValue(false);
    listOllamaModels.mockResolvedValue([]);

    const report = await collectStatus();

    expect(report).toEqual({
      docker: { available: false, services: [] },
      ollama: { url: 'http://localhost:11434', running: true },
    });
    expect(findDockerCompose).not.toHaveBeenCalled();
    expect(composePs).not.toHaveBeenCalled();
  });

  it('skips composePs when Docker is up but no compose file is found', async () => {
    checkDocker.mockReturnValue(true);
    findDockerCompose.mockReturnValue(null);
    listOllamaModels.mockResolvedValue([]);

    const report = await collectStatus();

    expect(report.docker).toEqual({ available: true, services: [] });
    expect(composePs).not.toHaveBeenCalled();
  });

  it('maps running and stopped compose services and keeps health only when present', async () => {
    const composePath = join('proj', 'docker-compose.yml');
    checkDocker.mockReturnValue(true);
    findDockerCompose.mockReturnValue(composePath);
    composePs.mockReturnValue([
      {
        Name: 'api',
        State: 'running',
        Status: 'Up 2 minutes (healthy)',
        Health: 'healthy',
        ports: ['localhost:8080→8080'],
      },
      {
        Name: 'worker',
        State: 'exited',
        Status: 'Exited (0) 1 minute ago',
        ports: [],
      },
    ]);
    listOllamaModels.mockResolvedValue([{ name: 'qwen', size: 1, modified_at: '' }]);

    const report = await collectStatus();

    expect(composePs).toHaveBeenCalledWith(dirname(composePath));
    expect(report.docker).toStrictEqual({
      available: true,
      compose: composePath,
      services: [
        {
          name: 'api',
          state: 'running',
          running: true,
          health: 'healthy',
          status: 'Up 2 minutes (healthy)',
        },
        {
          name: 'worker',
          state: 'exited',
          running: false,
          status: 'Exited (0) 1 minute ago',
        },
      ],
    });
    expect(report.ollama).toEqual({ url: 'http://localhost:11434', running: true });
    expect(report.docker.services?.[1]).not.toHaveProperty('health');
  });

  it('keeps only the first line when composePs throws a multi-line error', async () => {
    const composePath = join('proj', 'compose.yaml');
    checkDocker.mockReturnValue(true);
    findDockerCompose.mockReturnValue(composePath);
    composePs.mockImplementation(() => {
      throw new Error('compose failed\nsecond line\nthird line');
    });
    listOllamaModels.mockResolvedValue([]);

    const report = await collectStatus();

    expect(report.docker).toEqual({
      available: true,
      compose: composePath,
      services: [],
      error: 'compose failed',
    });
  });

  it('marks Ollama as not running when the helper is unreachable', async () => {
    resolveOllamaConnection.mockReturnValue({ baseUrl: 'http://localhost:11434', apiKey: 'k' });
    checkDocker.mockReturnValue(false);
    listOllamaModels.mockRejectedValue(new Error('ECONNREFUSED'));

    const report = await collectStatus();

    expect(report.ollama).toEqual({ url: 'http://localhost:11434', running: false });
    expect(listOllamaModels).toHaveBeenCalledWith('http://localhost:11434', {
      apiKey: 'k',
      headers: undefined,
      timeoutMs: 3000,
    });
  });

  it('forwards the configured Ollama credentials to the reachability probe', async () => {
    const headers = { 'X-Gateway-Key': 'secret' };
    resolveOllamaConnection.mockReturnValue({
      baseUrl: 'http://localhost:11434',
      apiKey: 'config-key',
      headers,
    });
    checkDocker.mockReturnValue(false);
    listOllamaModels.mockResolvedValue([]);

    await collectStatus();

    expect(listOllamaModels).toHaveBeenCalledWith('http://localhost:11434', {
      apiKey: 'config-key',
      headers,
      timeoutMs: 3000,
    });
  });

  it('warns and falls back to the environment when the config cannot be read', async () => {
    resolveOllamaConnection.mockImplementation(() => {
      throw new Error('Invalid configuration:\nlimits.maxConcurrentRuns: Expected number');
    });
    resolveOllamaUrl.mockReturnValue('http://env.example');
    vi.stubEnv('OLLAMA_API_KEY', 'env-key');
    checkDocker.mockReturnValue(false);
    listOllamaModels.mockResolvedValue([]);

    const report = await collectStatus();

    expect(report.ollama).toEqual({ url: 'http://env.example', running: true });
    expect(resolveOllamaUrl).toHaveBeenCalledWith(process.env);
    expect(listOllamaModels).toHaveBeenCalledWith('http://env.example', {
      apiKey: 'env-key',
      headers: undefined,
      timeoutMs: 3000,
    });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Invalid configuration')
    );
  });
});
