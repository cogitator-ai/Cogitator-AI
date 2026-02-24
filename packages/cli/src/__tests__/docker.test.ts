import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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

  it('returns null when no compose file found', async () => {
    process.chdir(tempDir);

    const { findDockerCompose } = await import('../utils/docker.js');
    const result = findDockerCompose();
    expect(result).toBeNull();
  });
});

describe('checkDocker', () => {
  it('returns true when docker is available', async () => {
    vi.mock('node:child_process', () => ({
      execSync: vi.fn(),
    }));

    const { checkDocker } = await import('../utils/docker.js');
    expect(typeof checkDocker()).toBe('boolean');
  });
});
