import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, REPO_ROOT } from '../../helpers/scaffold-harness';

const SCRIPT = join(REPO_ROOT, 'scripts', 'check-packages.ts');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

interface FixtureFiles {
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
}

const VALID_FILES = {
  'dist/index.js': 'export const answer = 42;\n',
  'dist/index.d.ts': 'export declare const answer: number;\n',
};

function manifest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    files: ['dist'],
    sideEffects: false,
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/example/example.git' },
    ...overrides,
  };
}

describe('release: package checks', () => {
  let root: string;

  const fixture = (dirName: string, { manifest: pkg, files }: FixtureFiles): string => {
    const dir = join(root, dirName);
    for (const [path, content] of Object.entries(files ?? VALID_FILES)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg ?? manifest(dirName), null, 2));
    return dir;
  };

  const check = (...dirs: string[]) => exec(TSX, [SCRIPT, ...dirs], { cwd: root });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'package-checks-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes an ESM package whose exports and types match the packed files', async () => {
    const dir = fixture('fixture-valid', {});

    const result = await check(dir);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Checked 1 package(s) with publint and arethetypeswrong');
  }, 120_000);

  it('fails when an export points at a file that is not published', async () => {
    const dir = fixture('fixture-missing-types', {
      manifest: manifest('fixture-missing-types', {
        types: './dist/missing.d.ts',
        exports: { '.': { types: './dist/missing.d.ts', default: './dist/index.js' } },
      }),
    });

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain('fixture-missing-types:');
    expect(result.output).toMatch(/publint FILE_DOES_NOT_EXIST/);
  }, 120_000);

  it('fails when a declaration file imports a module that does not resolve', async () => {
    const dir = fixture('fixture-broken-types', {
      manifest: manifest('fixture-broken-types'),
      files: {
        'dist/index.js': 'export const answer = 42;\n',
        'dist/index.d.ts': 'export declare const answer: import("..").Missing;\n',
      },
    });

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain('fixture-broken-types:');
    expect(result.output).toContain('arethetypeswrong:');
    expect(result.output).toContain('Internal resolution error');
  }, 120_000);

  it('skips private packages', async () => {
    const valid = fixture('fixture-public', {});
    const hidden = fixture('fixture-private', {
      manifest: manifest('fixture-private', { private: true, types: './dist/missing.d.ts' }),
    });

    const result = await check(valid, hidden);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Checked 1 package(s)');
  }, 120_000);
});
