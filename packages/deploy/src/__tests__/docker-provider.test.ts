import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerProvider } from '../providers/docker';
import { writeArtifacts } from '../providers/artifacts';
import { isCommandAvailable, run } from '../utils/exec';
import { isRegistryAuthenticated } from '../utils/registry-auth';

vi.mock('../utils/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec')>();
  return { ...actual, run: vi.fn(), isCommandAvailable: vi.fn() };
});

vi.mock('../utils/registry-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/registry-auth')>();
  return { ...actual, isRegistryAuthenticated: vi.fn() };
});

const runMock = vi.mocked(run);
const commandAvailable = vi.mocked(isCommandAvailable);
const registryAuthenticated = vi.mocked(isRegistryAuthenticated);

beforeEach(() => {
  commandAvailable.mockReturnValue(true);
  runMock.mockReturnValue({ success: true, output: '' });
  registryAuthenticated.mockReturnValue(false);
});

afterEach(() => vi.resetAllMocks());

const checksByName = (checks: { name: string; passed: boolean }[]) =>
  Object.fromEntries(checks.map((c) => [c.name, c.passed]));

describe('DockerProvider', () => {
  const provider = new DockerProvider();

  it('has correct name', () => {
    expect(provider.name).toBe('docker');
  });

  it('passes preflight when docker, its daemon and compose are available', async () => {
    const result = await provider.preflight({ target: 'docker', port: 3000 }, process.cwd());

    expect(checksByName(result.checks)).toEqual({
      'Docker installed': true,
      'Docker daemon running': true,
      'Docker Compose available': true,
    });
    expect(result.passed).toBe(true);
    expect(runMock).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('reports a missing docker install with a fix and skips the daemon checks', async () => {
    commandAvailable.mockReturnValue(false);

    const result = await provider.preflight({ target: 'docker', port: 3000 }, process.cwd());

    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'Docker installed',
        passed: false,
        fix: expect.stringContaining('docs.docker.com'),
      }),
    ]);
    expect(result.passed).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('reports a stopped docker daemon', async () => {
    runMock.mockImplementation((_command, args) => ({
      success: args[0] !== 'info',
      output: '',
    }));

    const result = await provider.preflight({ target: 'docker', port: 3000 }, process.cwd());

    expect(checksByName(result.checks)).toMatchObject({
      'Docker daemon running': false,
      'Docker Compose available': true,
    });
    expect(result.passed).toBe(false);
  });

  it('checks registry authentication only when a registry is configured', async () => {
    const withoutRegistry = await provider.preflight({ target: 'docker' }, process.cwd());
    expect(checksByName(withoutRegistry.checks)).not.toHaveProperty('Registry authentication');

    const result = await provider.preflight(
      { target: 'docker', registry: 'ghcr.io/test' },
      process.cwd()
    );
    expect(registryAuthenticated).toHaveBeenCalledWith('ghcr.io/test');
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'Registry authentication',
        passed: false,
        fix: 'Run: docker login ghcr.io',
      })
    );
  });
});

describe('DockerProvider without a deployment', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-docker-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports not running when no compose file was generated', async () => {
    expect(await new DockerProvider().status({}, dir)).toEqual({ running: false });
  });

  it('refuses to destroy a deployment that does not exist', async () => {
    await expect(new DockerProvider().destroy({}, dir)).rejects.toThrow(
      'No docker deployment found'
    );
  });

  it('checks secrets against the project .env file', async () => {
    writeFileSync(join(dir, '.env'), 'COGITATOR_TEST_SECRET_FROM_FILE=1\n');
    const result = await new DockerProvider().preflight(
      { secrets: ['COGITATOR_TEST_SECRET_FROM_FILE', 'COGITATOR_TEST_SECRET_MISSING'] },
      dir
    );
    const byName = checksByName(result.checks);
    expect(byName['Secret: COGITATOR_TEST_SECRET_FROM_FILE']).toBe(true);
    expect(byName['Secret: COGITATOR_TEST_SECRET_MISSING']).toBe(false);
  });
});

describe('writeArtifacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-artifacts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a root .dockerignore only when missing', () => {
    const artifacts = {
      files: [{ path: 'Dockerfile', content: 'FROM x' }],
      outputDir: '.cogitator',
    };
    writeArtifacts(dir, artifacts);
    expect(readFileSync(join(dir, '.dockerignore'), 'utf-8')).toContain('.env');
    expect(readFileSync(join(dir, '.cogitator', 'Dockerfile'), 'utf-8')).toBe('FROM x');

    writeFileSync(join(dir, '.dockerignore'), 'custom\n');
    writeArtifacts(dir, artifacts);
    expect(readFileSync(join(dir, '.dockerignore'), 'utf-8')).toBe('custom\n');
    expect(existsSync(join(dir, '.cogitator'))).toBe(true);
  });
});
