import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The zod range generated projects depend on: the one `@cogitator-ai/core` depends on, so tool schemas and core share one zod. */
export const ZOD_VERSION = '^4.6.5';

const OWN_NAME = 'create-cogitator-app';
const SCOPE = '@cogitator-ai/';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifest(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
  if (!isRecord(parsed)) throw new Error(`${file} is not a package manifest`);
  return parsed;
}

function findOwnRoot(from: string): string {
  let dir = from;
  while (true) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && readManifest(manifest).name === OWN_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot find the ${OWN_NAME} package.json above ${from}`);
    dir = parent;
  }
}

function linkedVersion(packageRoot: string, name: string): string {
  const manifest = path.join(packageRoot, 'node_modules', name, 'package.json');
  if (!existsSync(manifest)) {
    throw new Error(`Cannot resolve the version of ${name}: ${manifest} does not exist`);
  }
  const version = readManifest(manifest).version;
  if (typeof version !== 'string') throw new Error(`${manifest} has no version`);
  return version;
}

/**
 * The ranges generated projects depend on for each `@cogitator-ai/*` package, read
 * from the devDependencies of the create-cogitator-app manifest in `packageRoot`.
 *
 * In the monorepo those are `workspace:^` and resolve to a caret on the linked
 * package's version. `pnpm publish` rewrites them to `^<version>` of the packages
 * released alongside, so a published scaffolder generates projects pinned to the
 * releases it was published with, and an old cached one never pulls in a newer,
 * incompatible minor.
 */
export function readCogitatorVersions(packageRoot: string): Record<string, string> {
  const devDependencies = readManifest(path.join(packageRoot, 'package.json')).devDependencies;
  const versions: Record<string, string> = {};
  if (!isRecord(devDependencies)) return versions;

  for (const [name, range] of Object.entries(devDependencies)) {
    if (!name.startsWith(SCOPE) || typeof range !== 'string') continue;
    versions[name] = range.startsWith('workspace:')
      ? `^${linkedVersion(packageRoot, name)}`
      : range;
  }
  return versions;
}

let resolved: Record<string, string> | undefined;

/** The range a generated project depends on for `name`, an `@cogitator-ai/*` package. */
export function cogitatorVersion(name: `${typeof SCOPE}${string}`): string {
  resolved ??= readCogitatorVersions(findOwnRoot(path.dirname(fileURLToPath(import.meta.url))));
  const range = resolved[name];
  if (!range) {
    throw new Error(`${name} is not a devDependency of ${OWN_NAME}, so its version is unknown`);
  }
  return range;
}
