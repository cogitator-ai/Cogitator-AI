import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');

interface Manifest {
  name?: unknown;
  version?: unknown;
  private?: unknown;
}

/**
 * The versions of the publishable `@cogitator-ai/*` packages in the workspace,
 * read when the scaffolder is built or tested. A published scaffolder carries the
 * versions released with it, so the projects it generates depend on exactly them.
 */
export function readWorkspaceVersions(packagesDir: string = PACKAGES_DIR): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
    if (manifest.private === true) continue;
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
    if (!manifest.name.startsWith('@cogitator-ai/')) continue;
    versions[manifest.name] = manifest.version;
  }
  return Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)));
}
