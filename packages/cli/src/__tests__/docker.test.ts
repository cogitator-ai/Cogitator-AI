import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('findDockerCompose', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-docker-'));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds docker-compose.yml in current dir', async () => {
    writeFileSync(join(tempDir, 'docker-compose.yml'), 'name: test');
    process.chdir(tempDir);

    const { findDockerCompose } = await import('../utils/docker.js');
    const result = findDockerCompose();
    expect(result).toBeTruthy();
    expect(result).toContain('docker-compose.yml');
  });

  it('finds docker-compose.yaml in current dir', async () => {
    writeFileSync(join(tempDir, 'docker-compose.yaml'), 'name: test');
    process.chdir(tempDir);

    const { findDockerCompose } = await import('../utils/docker.js');
    const result = findDockerCompose();
    expect(result).toBeTruthy();
    expect(result).toContain('docker-compose.yaml');
  });

  it('finds docker-compose.yml in parent directory', async () => {
    writeFileSync(join(tempDir, 'docker-compose.yml'), 'name: test');
    const subDir = join(tempDir, 'subdir');
    mkdirSync(subDir, { recursive: true });
    process.chdir(subDir);

    const { findDockerCompose } = await import('../utils/docker.js');
    const result = findDockerCompose();
    expect(result).toBeTruthy();
    expect(result).toContain('docker-compose.yml');
  });

  it('finds docker-compose.yaml in parent directory', async () => {
    writeFileSync(join(tempDir, 'docker-compose.yaml'), 'name: test');
    const subDir = join(tempDir, 'deep', 'nested');
    mkdirSync(subDir, { recursive: true });
    process.chdir(subDir);

    const { findDockerCompose } = await import('../utils/docker.js');
    const result = findDockerCompose();
    expect(result).toBeTruthy();
    expect(result).toContain('docker-compose.yaml');
  });

  it('finds compose.yaml (Compose spec default name)', async () => {
    writeFileSync(join(tempDir, 'compose.yaml'), 'name: test');
    process.chdir(tempDir);

    const { findDockerCompose } = await import('../utils/docker.js');
    expect(findDockerCompose()).toBe(join(realpathSync(tempDir), 'compose.yaml'));
  });

  it('returns null when no compose file found', async () => {
    process.chdir(tempDir);

    const { findDockerCompose } = await import('../utils/docker.js');
    const result = findDockerCompose();
    expect(result).toBeNull();
  });
});

describe('parseComposePs', () => {
  it('parses NDJSON output (compose >= 2.21)', async () => {
    const { parseComposePs } = await import('../utils/docker.js');
    const output = [
      JSON.stringify({
        Name: 'app-redis-1',
        State: 'running',
        Status: 'Up 2 minutes',
        Health: 'healthy',
      }),
      JSON.stringify({ Name: 'app-db-1', State: 'exited', Status: 'Exited (1)', Health: '' }),
    ].join('\n');
    const services = parseComposePs(output);
    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({ Name: 'app-redis-1', State: 'running', Health: 'healthy' });
    expect(services[1].Health).toBeUndefined();
  });

  it('parses JSON array output (older compose v2)', async () => {
    const { parseComposePs } = await import('../utils/docker.js');
    const output = JSON.stringify([
      { Name: 'a', State: 'running', Status: 'Up' },
      { Name: 'b', State: 'running', Status: 'Up' },
    ]);
    expect(parseComposePs(output).map((s) => s.Name)).toEqual(['a', 'b']);
  });

  it('returns an empty list for empty output', async () => {
    const { parseComposePs } = await import('../utils/docker.js');
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('  \n')).toEqual([]);
  });

  it('extracts published ports and deduplicates IPv4/IPv6 bindings', async () => {
    const { parseComposePs } = await import('../utils/docker.js');
    const output = JSON.stringify({
      Name: 'redis',
      State: 'running',
      Status: 'Up',
      Publishers: [
        { URL: '0.0.0.0', TargetPort: 6379, PublishedPort: 6379, Protocol: 'tcp' },
        { URL: '::', TargetPort: 6379, PublishedPort: 6379, Protocol: 'tcp' },
        { URL: '', TargetPort: 9999, PublishedPort: 0, Protocol: 'tcp' },
      ],
    });
    expect(parseComposePs(output)[0].ports).toEqual(['localhost:6379→6379']);
  });

  it('skips entries without a name', async () => {
    const { parseComposePs } = await import('../utils/docker.js');
    expect(parseComposePs(JSON.stringify({ State: 'running' }))).toEqual([]);
  });
});

describe('checkDocker', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('returns true when docker info succeeds', async () => {
    vi.resetModules();
    const execFileSync = vi.fn(() => '27.0.0');
    vi.doMock('node:child_process', () => ({ execFileSync }));
    const { checkDocker } = await import('../utils/docker.js');
    expect(checkDocker()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      expect.objectContaining({ stdio: 'pipe' })
    );
  });

  it('returns false when the daemon is unreachable', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => {
        throw new Error('Cannot connect to the Docker daemon');
      }),
    }));
    const { checkDocker } = await import('../utils/docker.js');
    expect(checkDocker()).toBe(false);
  });
});
