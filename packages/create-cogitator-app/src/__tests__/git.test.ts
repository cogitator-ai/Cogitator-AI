import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initGitRepo } from '../utils/git.js';

const ISOLATED_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'EMAIL',
] as const;

function author(cwd: string): string {
  return execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd, encoding: 'utf8' }).trim();
}

describe('initGitRepo', () => {
  const saved = new Map<string, string | undefined>();
  let root: string;
  let project: string;
  let globalConfig: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cca-git-'));
    project = join(root, 'app');
    globalConfig = join(root, 'gitconfig');
    mkdirSync(project);
    writeFileSync(join(project, 'index.ts'), 'export {};\n');
    for (const key of ISOLATED_KEYS) saved.set(key, process.env[key]);
    for (const key of ISOLATED_KEYS) delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("commits the scaffold as the user's configured identity", () => {
    writeFileSync(globalConfig, '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n');
    initGitRepo(project);
    expect(author(project)).toBe('Ada Lovelace <ada@example.com>');
  });

  it('falls back to a neutral local identity when none is configured', () => {
    writeFileSync(globalConfig, '');
    initGitRepo(project);
    expect(author(project)).toBe('create-cogitator-app <create-cogitator-app@localhost>');
  });

  it('commits the whole scaffold with a conventional message', () => {
    writeFileSync(globalConfig, '');
    initGitRepo(project);
    const message = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: project,
      encoding: 'utf8',
    }).trim();
    const files = execFileSync('git', ['ls-files'], { cwd: project, encoding: 'utf8' }).trim();
    expect(message).toBe('feat: initial project scaffold');
    expect(files).toBe('index.ts');
  });
});
