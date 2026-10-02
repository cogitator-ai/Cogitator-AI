import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSpecificationVersion,
  detectSpecificationVersion,
  resetSpecificationVersionCache,
  specificationVersionForAI,
} from '../ai-version';

const roots: string[] = [];

function appWithAI(version: string | undefined, exportsPackageJson = true): string {
  const root = mkdtempSync(join(tmpdir(), 'cogitator-ai-version-'));
  roots.push(root);
  if (version !== undefined) {
    const dir = join(root, 'node_modules', 'ai');
    mkdirSync(dir, { recursive: true });
    const exportsMap = exportsPackageJson
      ? { '.': { import: './index.mjs' }, './package.json': './package.json' }
      : { '.': { import: './index.mjs' } };
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'ai', version, type: 'module', exports: exportsMap })
    );
    writeFileSync(join(dir, 'index.mjs'), 'export {};');
  }
  return join(root, 'noop.js');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetSpecificationVersionCache();
});

describe('specificationVersionForAI', () => {
  it('maps ai majors to the specification they consume natively', () => {
    expect(specificationVersionForAI('4.3.19')).toBe('v1');
    expect(specificationVersionForAI('5.0.271')).toBe('v2');
    expect(specificationVersionForAI('6.0.300')).toBe('v3');
    expect(specificationVersionForAI('7.0.127')).toBe('v4');
    expect(specificationVersionForAI('7.1.0-beta.3')).toBe('v4');
    expect(specificationVersionForAI('8.0.0')).toBe('v4');
  });

  it('rejects versions without a supported major', () => {
    expect(specificationVersionForAI('3.4.0')).toBeUndefined();
    expect(specificationVersionForAI('latest')).toBeUndefined();
  });
});

describe('detectSpecificationVersion', () => {
  it.each([
    ['4.3.19', 'v1'],
    ['5.0.271', 'v2'],
    ['6.0.300', 'v3'],
    ['7.0.127', 'v4'],
  ])('detects ai@%s from the app as %s', (version, expected) => {
    expect(detectSpecificationVersion([appWithAI(version)])).toBe(expected);
  });

  it('reads package.json of ESM-only packages that do not export it', () => {
    expect(detectSpecificationVersion([appWithAI('4.3.19', false)])).toBe('v1');
  });

  it('falls back to the next resolution base for unusable installs', () => {
    expect(detectSpecificationVersion([appWithAI('3.4.0'), appWithAI('6.0.300')])).toBe('v3');
  });

  it('falls back to v2 when ai cannot be resolved', () => {
    expect(detectSpecificationVersion(['relative/noop.js'])).toBe('v2');
    expect(detectSpecificationVersion([])).toBe('v2');
  });

  it('detects and caches the ai package installed for this package', () => {
    expect(defaultSpecificationVersion()).toBe('v4');
    expect(defaultSpecificationVersion()).toBe('v4');
  });
});
