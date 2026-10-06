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
