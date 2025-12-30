import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '../../dist/index.js');

describe('cogitator init', () => {
  const testDir = join(tmpdir(), 'cogitator-test-' + Date.now());
  const projectName = 'test-project';
  const projectPath = join(testDir, projectName);

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates project directory structure', () => {
    execSync(`node ${CLI_PATH} init ${projectName} --no-install`, {
      cwd: testDir,
      stdio: 'pipe',
    });

    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(join(projectPath, 'package.json'))).toBe(true);
    expect(existsSync(join(projectPath, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(projectPath, 'cogitator.yml'))).toBe(true);
    expect(existsSync(join(projectPath, 'src/agent.ts'))).toBe(true);
    expect(existsSync(join(projectPath, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(projectPath, '.gitignore'))).toBe(true);
  });

  it('creates valid package.json', () => {
    execSync(`node ${CLI_PATH} init ${projectName} --no-install`, {
      cwd: testDir,
      stdio: 'pipe',
    });

    const pkgJson = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8'));
    expect(pkgJson.name).toBe(projectName);
    expect(pkgJson.dependencies['@cogitator/core']).toBeDefined();
  });

  it('fails if directory already exists', () => {
    execSync(`node ${CLI_PATH} init ${projectName} --no-install`, {
      cwd: testDir,
      stdio: 'pipe',
    });

    expect(() => {
      execSync(`node ${CLI_PATH} init ${projectName} --no-install`, {
        cwd: testDir,
        stdio: 'pipe',
      });
    }).toThrow();
  });
});
