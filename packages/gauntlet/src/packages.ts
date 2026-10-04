import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(PACKAGE_DIR, '../..');

/** Names of the packages under `packages/` that are published (not `"private": true`). */
export function publishedPackages(): string[] {
  const dir = join(REPO_ROOT, 'packages');
  return readdirSync(dir)
    .map((name) => join(dir, name, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as { name: string; private?: boolean })
    .filter((pkg) => !pkg.private)
    .map((pkg) => pkg.name)
    .sort();
}
