import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerComposeAvailable, startServices } from '../kit/services.js';
import { offerServices, servicesToStart } from '../cli/services.js';

const prompts = vi.hoisted(() => ({
  confirm: vi.fn<() => Promise<boolean | symbol>>(),
  spinner: { start: vi.fn(), stop: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  confirm: prompts.confirm,
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => prompts.spinner,
  log: { warn: prompts.warn },
}));

const roots: string[] = [];
const path = process.env.PATH;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cca-services-'));
  roots.push(root);
  return root;
}

/**
 * Puts a `docker` on PATH that records its arguments and answers like Docker:
 * `DOCKER_INFO_EXIT` fails the daemon check, `DOCKER_WAIT_FAIL` fails the
 * waiting start the way a taken port does.
 */
function fakeDocker(): { calls: () => string[] } {
  const bin = tempRoot();
  const log = join(bin, 'calls.log');
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    [
      '#!/bin/sh',
      `echo "$*" >> "${log}"`,
      'case "$*" in',
      '  info*) exit "${DOCKER_INFO_EXIT:-0}" ;;',
      '  *--wait*)',
      '    if [ -n "$DOCKER_WAIT_FAIL" ]; then',
      '      echo "Bind for 0.0.0.0:6379 failed: port is already allocated" >&2',
      '      exit 1',
      '    fi ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n')
  );
  chmodSync(docker, 0o755);
  process.env.PATH = bin;
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : []),
  };
}

const ollamaStack = {
  services: ['redis', 'ollama', 'ollama-pull'],
  oneShotServices: ['ollama-pull'],
};

beforeEach(() => {
  prompts.confirm.mockReset();
  prompts.spinner.start.mockReset();
  prompts.spinner.stop.mockReset();
  prompts.spinner.error.mockReset();
  prompts.warn.mockReset();
});

afterEach(() => {
  process.env.PATH = path;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dockerComposeAvailable', () => {
  it('is true when compose is installed and the daemon answers', async () => {
    const docker = fakeDocker();
    expect(await dockerComposeAvailable(tempRoot())).toBe(true);
    expect(docker.calls()).toEqual(['compose version', 'info --format {{.ServerVersion}}']);
  });

  it('is false when the daemon is not running', async () => {
    fakeDocker();
    vi.stubEnv('DOCKER_INFO_EXIT', '1');
    expect(await dockerComposeAvailable(tempRoot())).toBe(false);
  });

  it('is false without Docker', async () => {
    process.env.PATH = tempRoot();
    expect(await dockerComposeAvailable(tempRoot())).toBe(false);
  });
});

describe('startServices', () => {
  it('waits for the long-running services, then starts the one-shot ones without waiting', async () => {
    const docker = fakeDocker();
    expect(await startServices(tempRoot(), ollamaStack)).toEqual({ status: 'done' });
    expect(docker.calls()).toEqual([
      'compose up --detach --wait --wait-timeout 180 redis ollama',
      'compose up --detach ollama-pull',
    ]);
  });

  it('reports why compose failed and starts nothing more', async () => {
    const docker = fakeDocker();
    vi.stubEnv('DOCKER_WAIT_FAIL', '1');
    const result = await startServices(tempRoot(), ollamaStack);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('docker compose up exited with 1');
      expect(result.error.message).toContain('port is already allocated');
    }
    expect(docker.calls()).toHaveLength(1);
  });

  it('skips a project without services and never calls Docker', async () => {
    const docker = fakeDocker();
    expect(await startServices(tempRoot(), { services: [], oneShotServices: [] })).toEqual({
      status: 'skipped',
      reason: 'the project has no compose services',
    });
    expect(docker.calls()).toEqual([]);
  });

  it('fails instead of throwing when Docker is missing', async () => {
    process.env.PATH = tempRoot();
    const result = await startServices(tempRoot(), { services: ['redis'], oneShotServices: [] });
    expect(result.status).toBe('failed');
  });
});

describe('servicesToStart', () => {
  const tags = () =>
    vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'qwen3.5:4b' }] })));

  it('leaves the Ollama services out when an Ollama already answers', async () => {
    vi.stubGlobal('fetch', tags());
    expect(await servicesToStart(ollamaStack, 'http://localhost:11434')).toEqual({
      services: ['redis'],
      oneShotServices: [],
    });
  });

  it('keeps them when no Ollama answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    expect(await servicesToStart(ollamaStack, 'http://localhost:11434')).toBe(ollamaStack);
  });

  it('does not look for Ollama in a stack without it', async () => {
    const fetch = tags();
    vi.stubGlobal('fetch', fetch);
    const stack = { services: ['postgres'], oneShotServices: [] };
    expect(await servicesToStart(stack, 'http://localhost:11434')).toBe(stack);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('offerServices', () => {
  it('asks, starts the services on a yes and says which ones', async () => {
    const docker = fakeDocker();
    prompts.confirm.mockResolvedValue(true);
    expect(await offerServices(tempRoot(), ollamaStack)).toBe(true);
    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Start redis, ollama with docker compose now?' })
    );
    expect(prompts.spinner.stop).toHaveBeenCalledWith('Started redis, ollama');
    expect(docker.calls()).toContain('compose up --detach ollama-pull');
  });

  it.each([
    ['a no', false],
    ['a cancel', Symbol('cancel')],
  ])('starts nothing on %s', async (_case, answer) => {
    const docker = fakeDocker();
    prompts.confirm.mockResolvedValue(answer);
    expect(await offerServices(tempRoot(), ollamaStack)).toBe(false);
    expect(docker.calls().filter((call) => call.startsWith('compose up'))).toEqual([]);
  });

  it('does not ask when Docker is not running', async () => {
    fakeDocker();
    vi.stubEnv('DOCKER_INFO_EXIT', '1');
    expect(await offerServices(tempRoot(), ollamaStack)).toBe(false);
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it('does not ask when only one-shot services are left', async () => {
    fakeDocker();
    expect(await offerServices(tempRoot(), { services: ['seed'], oneShotServices: ['seed'] })).toBe(
      false
    );
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it('shows why a start failed and reports the services as not started', async () => {
    fakeDocker();
    vi.stubEnv('DOCKER_WAIT_FAIL', '1');
    prompts.confirm.mockResolvedValue(true);
    expect(await offerServices(tempRoot(), ollamaStack)).toBe(false);
    expect(prompts.spinner.error).toHaveBeenCalledWith(
      'Could not start redis, ollama, run "docker compose up -d" once it is fixed'
    );
    expect(prompts.warn).toHaveBeenCalledWith(expect.stringContaining('port is already allocated'));
  });
});
