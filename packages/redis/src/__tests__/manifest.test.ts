import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Manifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
) as Manifest;

describe('package manifest', () => {
  it('leaves installing ioredis to the app, as an optional peer', () => {
    expect(manifest.dependencies?.ioredis).toBeUndefined();
    expect(manifest.optionalDependencies?.ioredis).toBeUndefined();
    expect(manifest.peerDependencies?.ioredis).toBeDefined();
    expect(manifest.peerDependenciesMeta?.ioredis?.optional).toBe(true);
  });
});
