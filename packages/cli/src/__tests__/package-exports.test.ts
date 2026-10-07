import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Manifest {
  name: string;
  exports: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publishableManifests(): Manifest[] {
  return readdirSync(PACKAGES_DIR)
    .map((dir) => join(PACKAGES_DIR, dir, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file): unknown => JSON.parse(readFileSync(file, 'utf-8')))
    .filter(isRecord)
    .filter((pkg) => pkg.private !== true && typeof pkg.name === 'string')
    .map((pkg) => ({ name: String(pkg.name), exports: pkg.exports }));
}

/**
 * Problems of one condition object of an exports map: CommonJS consumers
 * (`require()`, Jest, NestJS) resolve only through `require` or `default`,
 * so every entry needs `default`, last as Node requires, `types` first as
 * TypeScript requires, and `require` only for files that are CommonJS.
 */
function conditionProblems(where: string, target: unknown): string[] {
  if (typeof target === 'string' || target === null) return [];
  if (!isRecord(target)) return [`${where}: unexpected export target`];
  const keys = Object.keys(target);
  const problems: string[] = [];
  if (!keys.includes('default')) problems.push(`${where}: no "default" condition`);
  else if (keys[keys.length - 1] !== 'default') problems.push(`${where}: "default" is not last`);
  if (keys.includes('types') && keys[0] !== 'types')
    problems.push(`${where}: "types" is not first`);
  const required = target.require;
  if (typeof required === 'string' && !required.endsWith('.cjs')) {
    problems.push(`${where}: "require" points to ${required}, which is not CommonJS`);
  }
  for (const key of keys) {
    if (isRecord(target[key])) problems.push(...conditionProblems(`${where}.${key}`, target[key]));
  }
  return problems;
}

function exportProblems(manifest: Manifest): string[] {
  const { exports } = manifest;
  if (exports === undefined) return [`${manifest.name}: no exports map`];
  if (typeof exports === 'string') return [];
  if (!isRecord(exports)) return [`${manifest.name}: unexpected exports value`];
  const subpaths = Object.keys(exports).every((key) => key.startsWith('.'));
  if (!subpaths) return conditionProblems(manifest.name, exports);
  return Object.entries(exports).flatMap(([subpath, target]) =>
    conditionProblems(`${manifest.name} "${subpath}"`, target)
  );
}

describe('exports maps of the publishable packages', () => {
  const manifests = publishableManifests();

  it('finds the packages', () => {
    expect(manifests.length).toBeGreaterThan(30);
    expect(manifests.map((m) => m.name)).toContain('@cogitator-ai/core');
  });

  it('resolve for CommonJS consumers too, through a "default" condition', () => {
    expect(manifests.flatMap(exportProblems)).toEqual([]);
  });
});
