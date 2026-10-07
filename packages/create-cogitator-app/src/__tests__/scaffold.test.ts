import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enclosingWorkspace, hashContent, LOCK_PATH, readLock, scaffold } from '../kit/scaffold.js';
import type { ProjectSpecInput } from '../kit/spec.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cca-scaffold-'));
  roots.push(root);
  return root;
}

const spec: ProjectSpecInput = {
  name: 'demo',
  preset: 'basic',
  app: 'script',
  memory: 'none',
  provider: 'openai',
  model: 'gpt-6.1-sol',
  packageManager: 'pnpm',
};

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('scaffold', () => {
  it('writes the planned files, a private .env and a lock of what it generated', async () => {
    const directory = join(tempRoot(), 'demo');
    const result = await scaffold(spec, {
      directory,
      secrets: { OPENAI_API_KEY: 'sk-test' },
      install: false,
      git: false,
    });

    for (const file of result.files) expect(existsSync(join(directory, file)), file).toBe(true);
    expect(readFileSync(join(directory, '.env'), 'utf-8')).toBe('OPENAI_API_KEY=sk-test\n');
    expect(statSync(join(directory, '.env')).mode & 0o777).toBe(0o600);
    expect(result.install).toEqual({ status: 'skipped', reason: 'install was turned off' });
    expect(result.format.status).toBe('skipped');

    const lock = readLock(directory);
    expect(lock?.files['src/index.ts']).toBe(
      hashContent(readFileSync(join(directory, 'src/index.ts'), 'utf-8'))
    );
    expect(lock?.files['.env']).toBeUndefined();
    expect(Object.keys(lock?.files ?? {})).not.toContain(LOCK_PATH);
  });

  it('reports its steps to the logger it is given and returns them structured', async () => {
    const lines: string[] = [];
    const log = {
      start: (message: string) => lines.push(`start ${message}`),
      done: (message: string) => lines.push(`done ${message}`),
      fail: (message: string) => lines.push(`fail ${message}`),
      warn: (message: string) => lines.push(`warn ${message}`),
    };
    const result = await scaffold(spec, {
      directory: join(tempRoot(), 'demo'),
      install: false,
      git: false,
      log,
    });
    expect(lines).toEqual([
      'start Writing project files',
      `done Wrote ${result.files.length} files`,
    ]);
    expect(result.plan.dependencies['@cogitator-ai/core']).toMatch(/^\^/);
    expect(result.git).toEqual({ status: 'skipped', reason: 'git was turned off' });
  });

  it('records the spec and the command to recreate it in package.json', async () => {
    const directory = join(tempRoot(), 'demo');
    await scaffold(spec, { directory, install: false, git: false });
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf-8')) as {
      cogitator: { spec: { preset: string }; command: string; generator: string };
    };
    expect(pkg.cogitator.spec.preset).toBe('basic');
    expect(pkg.cogitator.command).toMatch(/^npx create-cogitator-app@\S+ demo --preset basic /);
    expect(pkg.cogitator.generator).toMatch(/^create-cogitator-app@/);
  });

  it('refuses a directory that is not empty, before writing anything', async () => {
    const directory = join(tempRoot(), 'taken');
    mkdirSync(directory);
    writeFileSync(join(directory, 'notes.txt'), 'mine');
    await expect(scaffold(spec, { directory, install: false, git: false })).rejects.toThrow(
      'already exists and is not empty'
    );
    expect(existsSync(join(directory, 'package.json'))).toBe(false);
  });

  it('refuses an invalid spec before touching the disk', async () => {
    const directory = join(tempRoot(), 'bad');
    await expect(
      scaffold({ ...spec, app: 'server' }, { directory, install: false, git: false })
    ).rejects.toThrow('A server app needs a server framework');
    expect(existsSync(directory)).toBe(false);
  });

  it.runIf(hasGit())('commits to a new repository, but not inside an existing one', async () => {
    const root = tempRoot();
    const fresh = await scaffold(spec, { directory: join(root, 'fresh'), install: false });
    expect(fresh.git).toEqual({ status: 'done' });
    expect(
      execFileSync('git', ['log', '--oneline'], { cwd: join(root, 'fresh'), encoding: 'utf8' })
    ).toContain('initial project from create-cogitator-app');

    const nested = await scaffold(spec, {
      directory: join(root, 'fresh', 'packages', 'inner'),
      install: false,
    });
    expect(nested.git.status).toBe('skipped');
    if (nested.git.status === 'skipped')
      expect(nested.git.reason).toContain('inside the git repository');
  });

  it('notices a workspace it is created in', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    expect(enclosingWorkspace(join(root, 'apps', 'bot'))).toBe(root);
    expect(enclosingWorkspace(join(tempRoot(), 'alone'))).toBeUndefined();
  });

  it('reports an install that cannot run instead of throwing', async () => {
    const directory = join(tempRoot(), 'demo');
    const path = process.env.PATH;
    process.env.PATH = tempRoot();
    try {
      const result = await scaffold(spec, { directory, git: false, install: true });
      expect(result.install.status).toBe('failed');
      if (result.install.status === 'failed') {
        expect(result.install.error.message).toBe(
          'pnpm is not installed, install it or pick another one with --pm'
        );
      }
      expect(existsSync(join(directory, 'package.json'))).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  });
});
