import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageManagerInvocation } from '../kit/package-manager.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cca-pm-'));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, '');
  return path;
}

const PNPM_AGENT = 'pnpm/11.0.0 npm/? node/v24.0.0 linux x64';

describe('running the package manager', () => {
  it('runs the JavaScript entry of the one that launched the scaffolder with Node', () => {
    const entry = file('pnpm.cjs');
    expect(
      packageManagerInvocation('pnpm', ['install'], {
        npm_execpath: entry,
        npm_config_user_agent: PNPM_AGENT,
      })
    ).toEqual({ command: process.execPath, args: [entry, 'install'], fromPath: false });
  });

  it('runs a standalone binary of it directly', () => {
    const binary = file('pnpm.exe');
    expect(
      packageManagerInvocation('pnpm', ['install'], {
        npm_execpath: binary,
        npm_config_user_agent: PNPM_AGENT,
      })
    ).toEqual({ command: binary, args: ['install'], fromPath: false });
  });

  it('runs npm, not npx, when npx launched the scaffolder', () => {
    const npx = file('npx-cli.js');
    const npm = join(npx, '..', 'npm-cli.js');
    writeFileSync(npm, '');
    expect(
      packageManagerInvocation('npm', ['install'], {
        npm_execpath: npx,
        npm_config_user_agent: 'npm/10.9.8 node/v22.14.0 win32 x64',
      })
    ).toEqual({ command: process.execPath, args: [npm, 'install'], fromPath: false });
  });

  it.each([
    ['another package manager launched it', { npm_config_user_agent: 'yarn/4.9.2 npm/? node/v22' }],
    ['its path does not exist', { npm_execpath: '/nowhere/pnpm.cjs' }],
    ['nothing says what launched it', { npm_config_user_agent: undefined }],
  ])('looks it up on PATH when %s', (_case, env) => {
    expect(
      packageManagerInvocation('pnpm', ['install'], {
        npm_execpath: file('pnpm.cjs'),
        npm_config_user_agent: PNPM_AGENT,
        ...env,
      })
    ).toEqual({ command: 'pnpm', args: ['install'], fromPath: true });
  });
});
