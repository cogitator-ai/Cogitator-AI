import type { CogitatorSpecificationVersion } from './types.js';

const FALLBACK_SPECIFICATION_VERSION: CogitatorSpecificationVersion = 'v2';

let cachedVersion: CogitatorSpecificationVersion | undefined;

/** Map an installed `ai` package version to the model specification it consumes natively. */
export function specificationVersionForAI(
  version: string
): CogitatorSpecificationVersion | undefined {
  const major = Number.parseInt(version.replace(/^[^\d]*/, ''), 10);
  if (!Number.isFinite(major) || major < 4) return undefined;
  if (major === 4) return 'v1';
  if (major === 5) return 'v2';
  if (major === 6) return 'v3';
  return 'v4';
}

function readAIVersion(packageJsonPath: string): string | undefined {
  const fs = process.getBuiltinModule('node:fs');
  if (!fs.existsSync(packageJsonPath)) return undefined;
  const manifest: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const { name, version } = manifest as { name?: unknown; version?: unknown };
  return name === 'ai' && typeof version === 'string' ? version : undefined;
}

function installedAIVersionFrom(base: string): string | undefined {
  const { createRequire } = process.getBuiltinModule('node:module');
  const path = process.getBuiltinModule('node:path');
  const require = createRequire(base);

  try {
    const version = readAIVersion(require.resolve('ai/package.json'));
    if (version) return version;
  } catch {}

  for (const lookupPath of require.resolve.paths('ai') ?? []) {
    try {
      const version = readAIVersion(path.join(lookupPath, 'ai', 'package.json'));
      if (version) return version;
    } catch {}
  }
  return undefined;
}

/**
 * Detect the model specification for the `ai` package installed next to the consuming app
 * (resolved from `process.cwd()`, then from this package). Falls back to `'v2'`, which
 * ai@5, ai@6 and ai@7 all accept, when `ai` cannot be resolved.
 */
export function detectSpecificationVersion(
  bases: readonly string[] = defaultResolutionBases()
): CogitatorSpecificationVersion {
  for (const base of bases) {
    try {
      const version = installedAIVersionFrom(base);
      const specificationVersion = version && specificationVersionForAI(version);
      if (specificationVersion) return specificationVersion;
    } catch {}
  }
  return FALLBACK_SPECIFICATION_VERSION;
}

function defaultResolutionBases(): string[] {
  if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return [];
  }
  const path = process.getBuiltinModule('node:path');
  return [path.join(process.cwd(), 'noop.js'), import.meta.url];
}

export function defaultSpecificationVersion(): CogitatorSpecificationVersion {
  cachedVersion ??= detectSpecificationVersion();
  return cachedVersion;
}

export function resetSpecificationVersionCache(): void {
  cachedVersion = undefined;
}
