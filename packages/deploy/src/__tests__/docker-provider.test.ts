import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerProvider } from '../providers/docker';
import { writeArtifacts } from '../providers/artifacts';

describe('DockerProvider', () => {
  const provider = new DockerProvider();

  it('has correct name', () => {
    expect(provider.name).toBe('docker');
  });

  it('preflight checks for docker availability', async () => {
    const config = { target: 'docker' as const, port: 3000 };
    const result = await provider.preflight(config, process.cwd());
    const dockerCheck = result.checks.find((c) => c.name === 'Docker installed');
    expect(dockerCheck).toBeDefined();
  });

  it('preflight checks for registry auth when registry specified', async () => {
    const config = { target: 'docker' as const, port: 3000, registry: 'ghcr.io/test' };
    const result = await provider.preflight(config, process.cwd());
    const registryCheck = result.checks.find((c) => c.name === 'Registry authentication');
    expect(registryCheck).toBeDefined();
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
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c.passed]));
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
