import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectAnalyzer } from '../analyzer';
import { generateProjectArtifacts } from '../providers/artifacts';

function dockerfileOf(dir: string): string {
  const analysis = new ProjectAnalyzer().analyze(dir);
  const file = generateProjectArtifacts(analysis.deployConfig, dir).files.find(
    (f) => f.path === 'Dockerfile'
  );
  if (!file) throw new Error('No Dockerfile generated');
  return file.content;
}

function linesBefore(dockerfile: string, marker: RegExp): string[] {
  const lines = dockerfile.split('\n');
  const index = lines.findIndex((line) => marker.test(line));
  expect(index, `no line matches ${marker}`).toBeGreaterThan(-1);
  return lines.slice(0, index);
}

const SERVER_DEPS = { dependencies: { '@cogitator-ai/express': '^1.0.0' } };

describe('install layer of the generated Dockerfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-install-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(file: string, content: string) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }

  it('copies pnpm-workspace.yaml, .npmrc and patches/ before pnpm install', () => {
    write('package.json', JSON.stringify({ name: 'bot', ...SERVER_DEPS }));
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('pnpm-workspace.yaml', 'allowBuilds:\n  better-sqlite3: true\n');
    write('.npmrc', '@acme:registry=https://npm.acme.dev\n');
    write('patches/left-pad.patch', 'diff\n');

    const beforeInstall = linesBefore(dockerfileOf(dir), /pnpm install/).join('\n');
    expect(beforeInstall).toContain('pnpm-workspace.yaml');
    expect(beforeInstall).toContain('.npmrc');
    expect(beforeInstall).toMatch(/COPY patches \.\/patches/);
  });

  it('copies a patch directory named by patchedDependencies', () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'bot',
        ...SERVER_DEPS,
        pnpm: { patchedDependencies: { 'left-pad@1.3.0': 'fixes/left-pad.patch' } },
      })
    );
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('fixes/left-pad.patch', 'diff\n');

    const beforeInstall = linesBefore(dockerfileOf(dir), /pnpm install/).join('\n');
    expect(beforeInstall).toMatch(/COPY fixes \.\/fixes/);
  });

  it('copies only files that exist, so the build never fails on a missing optional file', () => {
    write('package.json', JSON.stringify({ name: 'bot', ...SERVER_DEPS }));
    write('package-lock.json', '{}');

    const dockerfile = dockerfileOf(dir);
    expect(dockerfile).not.toContain('pnpm-workspace.yaml');
    expect(dockerfile).not.toContain('patches');
    expect(linesBefore(dockerfile, /npm ci/).join('\n')).toContain('package-lock.json');
  });

  it('installs Yarn Berry projects with --immutable instead of the Yarn 1 flags', () => {
    write(
      'package.json',
      JSON.stringify({ name: 'bot', packageManager: 'yarn@4.5.0', ...SERVER_DEPS })
    );
    write('yarn.lock', '__metadata:\n  version: 8\n');
    write('.yarnrc.yml', 'nodeLinker: node-modules\n');
    write('.yarn/releases/yarn-4.5.0.cjs', '');

    const production = dockerfileOf(dir);
    expect(production).toContain('yarn workspaces focus --all --production');
    expect(production).not.toMatch(/yarn install[^\n]*--production/);

    write('tsconfig.json', '{}');
    const dockerfile = dockerfileOf(dir);
    expect(dockerfile).toContain('yarn install --immutable');
    expect(dockerfile).not.toContain('--frozen-lockfile');
    const beforeInstall = linesBefore(dockerfile, /yarn install/).join('\n');
    expect(beforeInstall).toContain('.yarnrc.yml');
    expect(beforeInstall).toMatch(/COPY \.yarn \.\/\.yarn/);
  });

  it('installs everything for Yarn Berry versions without workspaces focus', () => {
    write(
      'package.json',
      JSON.stringify({ name: 'bot', packageManager: 'yarn@3.8.0', ...SERVER_DEPS })
    );
    write('yarn.lock', '__metadata:\n  version: 6\n');
    const dockerfile = dockerfileOf(dir);
    expect(dockerfile).toContain('yarn install --immutable');
    expect(dockerfile).not.toContain('--production');
  });

  it('keeps Yarn 1 flags for a classic yarn.lock', () => {
    write('package.json', JSON.stringify({ name: 'bot', ...SERVER_DEPS }));
    write('yarn.lock', '# yarn lockfile v1\n');
    expect(dockerfileOf(dir)).toContain('yarn install --frozen-lockfile');
  });

  it('builds Bun projects on a Bun image and starts them with Bun', () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'tetsu-app',
        scripts: { start: 'bun run src/server.ts' },
        dependencies: { '@cogitator-ai/tetsu': '^1.0.0' },
      })
    );
    write('bun.lock', '{}');
    write('tsconfig.json', '{}');

    const analysis = new ProjectAnalyzer().analyze(dir);
    expect(analysis.packageManager).toBe('bun');
    expect(analysis.deployConfig.server).toBe('tetsu');

    const dockerfile = dockerfileOf(dir);
    expect(dockerfile).toMatch(/^FROM oven\/bun:/m);
    expect(dockerfile).not.toContain('node:22');
    expect(dockerfile).toContain('bun install --frozen-lockfile');
    expect(dockerfile).toContain('CMD ["bun","run","start"]');
    expect(dockerfile).toContain('http://localhost:3000/health');
  });

  it('detects Bun from the packageManager field without a lockfile', () => {
    write(
      'package.json',
      JSON.stringify({ name: 'app', packageManager: 'bun@1.4.0', ...SERVER_DEPS })
    );
    expect(new ProjectAnalyzer().analyze(dir).packageManager).toBe('bun');
  });

  it('fails preflight for a start script that requires a .env file the image never has', () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'bot',
        scripts: { start: 'node --env-file=.env dist/server.js' },
        ...SERVER_DEPS,
      })
    );
    const check = new ProjectAnalyzer()
      .analyze(dir)
      .checks.find((c) => c.name === 'Start script environment');
    expect(check?.passed).toBe(false);
    expect(check?.fix).toContain('--env-file-if-exists');
  });

  it('accepts a start script that loads .env only when it exists', () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'bot',
        scripts: { start: 'tsx --env-file-if-exists=.env src/server.ts' },
        ...SERVER_DEPS,
      })
    );
    const checks = new ProjectAnalyzer().analyze(dir).checks;
    expect(checks.find((c) => c.name === 'Start script environment')).toBeUndefined();
  });
});
