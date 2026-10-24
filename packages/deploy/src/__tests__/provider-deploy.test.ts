import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GeneratedArtifacts } from '@cogitator-ai/types';
import { DockerProvider } from '../providers/docker';
import { FlyProvider } from '../providers/fly';
import { isCommandAvailable, run, type ExecResult } from '../utils/exec';

vi.mock('../utils/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec')>();
  return { ...actual, run: vi.fn(), isCommandAvailable: vi.fn() };
});

const runMock = vi.mocked(run);
const commandAvailable = vi.mocked(isCommandAvailable);
const artifacts: GeneratedArtifacts = { files: [], outputDir: '.cogitator' };
const ok = (output = ''): ExecResult => ({ success: true, output });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-provider-'));
  commandAvailable.mockImplementation((command) => command === 'docker' || command === 'fly');
});
afterEach(() => {
  vi.resetAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('DockerProvider.deploy', () => {
  function dockerRuns(inspect: string) {
    runMock.mockImplementation((_command, args) => {
      if (args.includes('ps') && args.includes('-q')) return ok('c0ffee');
      if (args[0] === 'inspect') return ok(inspect);
      if (args.includes('logs')) return ok('Error: Missing environment variable ANTHROPIC_API_KEY');
      return ok();
    });
  }

  it('fails a deploy whose container exits right after starting, with its logs', async () => {
    dockerRuns('restarting 3 1');
    const provider = new DockerProvider({ startupCheckMs: 0 });

    const result = await provider.deploy({ kind: 'worker', image: 'bot' }, artifacts, dir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('restarting');
    expect(result.error).toContain('Missing environment variable ANTHROPIC_API_KEY');
  });

  it('reports a running worker without an HTTP endpoint', async () => {
    dockerRuns('running 0 0');
    const provider = new DockerProvider({ startupCheckMs: 0 });

    const result = await provider.deploy({ kind: 'worker', image: 'bot' }, artifacts, dir);

    expect(result).toEqual({ success: true });
  });

  it('reports the URL and health endpoint of a running server', async () => {
    dockerRuns('running 0 0');
    const provider = new DockerProvider({ startupCheckMs: 0 });

    const result = await provider.deploy(
      { kind: 'server', server: 'express', port: 8080, image: 'api' },
      artifacts,
      dir
    );

    expect(result).toEqual({
      success: true,
      url: 'http://localhost:8080',
      endpoints: { api: 'http://localhost:8080', health: 'http://localhost:8080/cogitator/health' },
    });
  });
});

describe('DockerProvider.deploy with Ollama', () => {
  it('shows the last lines of the model download when compose up fails', async () => {
    runMock.mockImplementation((_command, args) => {
      if (args.includes('up')) {
        return {
          success: false,
          output: '',
          error: 'service "ollama-pull" didn\'t complete successfully: exit 1',
        };
      }
      if (args.includes('logs')) return ok('Error: pull model manifest: file does not exist');
      return ok();
    });

    const result = await new DockerProvider({ startupCheckMs: 0 }).deploy(
      {
        kind: 'worker',
        image: 'bot',
        services: { ollama: true },
        ollama: { models: ['qwen9:nope'] },
      },
      artifacts,
      dir
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ollama-pull');
    expect(result.error).toContain('pull model manifest: file does not exist');
    const logs = runMock.mock.calls.find(([, args]) => args.includes('logs'))?.[1];
    expect(logs?.slice(-4)).toEqual(['--no-color', '--tail', '30', 'ollama-pull']);
  });

  it('reads no pull logs for a stack without models to pull', async () => {
    runMock.mockImplementation((_command, args) =>
      args.includes('up')
        ? { success: false, output: '', error: 'port is already allocated' }
        : ok()
    );

    const result = await new DockerProvider({ startupCheckMs: 0 }).deploy(
      { kind: 'worker', image: 'bot' },
      artifacts,
      dir
    );

    expect(result.error).toBe('docker compose up failed: port is already allocated');
    expect(runMock.mock.calls.some(([, args]) => args.includes('logs'))).toBe(false);
  });
});

describe('FlyProvider.deploy', () => {
  function flyCalls(): (readonly string[])[] {
    return runMock.mock.calls.map(([, args]) => args);
  }

  it('creates the volume the app mounts before deploying', async () => {
    runMock.mockImplementation((_command, args) =>
      args[0] === 'volumes' && args[1] === 'list' ? ok('[]') : ok()
    );

    const result = await new FlyProvider().deploy(
      { kind: 'worker', image: 'bot', region: 'ams', volumes: [{ path: 'data', size: 3 }] },
      artifacts,
      dir
    );

    expect(result.success).toBe(true);
    const calls = flyCalls();
    const create = calls.findIndex((args) => args[0] === 'volumes' && args[1] === 'create');
    const deploy = calls.findIndex((args) => args[0] === 'deploy');
    expect(calls[create]).toEqual([
      'volumes',
      'create',
      'data',
      '--app',
      'bot',
      '--region',
      'ams',
      '--size',
      '3',
      '--yes',
    ]);
    expect(create).toBeLessThan(deploy);
    expect(result.url).toBeUndefined();
  });

  it('creates the app from deploy.app in deploy.org', async () => {
    runMock.mockImplementation((_command, args) =>
      args[0] === 'status' ? { success: false, output: '', error: 'not found' } : ok()
    );

    const result = await new FlyProvider().deploy(
      { kind: 'worker', image: 'bot', app: 'acme-bot', org: 'acme' },
      artifacts,
      dir
    );

    expect(result.success).toBe(true);
    const calls = flyCalls();
    expect(calls).toContainEqual(['apps', 'create', 'acme-bot', '--org', 'acme']);
    expect(calls.find((args) => args[0] === 'deploy')).toEqual(
      expect.arrayContaining(['--app', 'acme-bot'])
    );
  });

  it('creates the app in the default organization without deploy.org', async () => {
    runMock.mockImplementation((_command, args) =>
      args[0] === 'status' ? { success: false, output: '', error: 'not found' } : ok()
    );

    await new FlyProvider().deploy({ kind: 'worker', image: 'bot' }, artifacts, dir);

    expect(flyCalls()).toContainEqual(['apps', 'create', 'bot']);
  });

  it('reuses an existing volume', async () => {
    runMock.mockImplementation((_command, args) =>
      args[0] === 'volumes' && args[1] === 'list'
        ? ok(JSON.stringify([{ name: 'data', region: 'iad' }]))
        : ok()
    );

    await new FlyProvider().deploy(
      { kind: 'worker', image: 'bot', volumes: [{ path: 'data' }] },
      artifacts,
      dir
    );

    expect(flyCalls().some((args) => args[0] === 'volumes' && args[1] === 'create')).toBe(false);
  });
});
