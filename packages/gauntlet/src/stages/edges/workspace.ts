import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PACKAGE_DIR, REPO_ROOT } from '../../packages.js';

interface Manifest {
  name: string;
  version: string;
}

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'name' in parsed &&
    typeof parsed.name === 'string' &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return { name: parsed.name, version: parsed.version };
  }
  return undefined;
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Whether `version` satisfies `range`: `latest`, `*`, an exact version or a caret range. */
export function satisfies(version: string, range: string): boolean {
  if (range === 'latest' || range === '*') return true;
  const have = parseVersion(version);
  const want = parseVersion(range.replace(/^[\^~]/, ''));
  if (!have || !want) return false;
  if (!range.startsWith('^')) return have.join('.') === want.join('.');
  if (have[0] !== want[0]) return false;
  if (have[1] !== want[1]) return have[1] > want[1];
  return have[2] >= want[2];
}

let workspacePackages: Map<string, string> | undefined;

/** Published and private workspace packages by npm name, mapped to their directories. */
export function workspacePackageDirs(): Map<string, string> {
  if (workspacePackages) return workspacePackages;
  const root = join(REPO_ROOT, 'packages');
  workspacePackages = new Map(
    readdirSync(root).flatMap((entry) => {
      const manifest = readManifest(join(root, entry));
      return manifest ? [[manifest.name, join(root, entry)] as const] : [];
    })
  );
  return workspacePackages;
}

/**
 * Directory of an installed copy of `name` that satisfies `range`, looked up the way the
 * monorepo has it installed: the gauntlet first, then the root, every package, and the pnpm store.
 */
export function findInstalled(
  name: string,
  range: string
): { dir: string; version: string } | undefined {
  const packages = join(REPO_ROOT, 'packages');
  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  const storePrefix = `${name.replace('/', '+')}@`;
  const candidates = [
    join(PACKAGE_DIR, 'node_modules', name),
    join(REPO_ROOT, 'node_modules', name),
    ...readdirSync(packages).map((entry) => join(packages, entry, 'node_modules', name)),
    ...(existsSync(store)
      ? readdirSync(store)
          .filter((entry) => entry.startsWith(storePrefix))
          .sort()
          .reverse()
          .map((entry) => join(store, entry, 'node_modules', name))
      : []),
  ];
  for (const dir of candidates) {
    const manifest = readManifest(dir);
    if (manifest?.name === name && satisfies(manifest.version, range)) {
      return { dir, version: manifest.version };
    }
  }
  return undefined;
}

export interface LinkedDependency {
  name: string;
  range: string;
  version: string;
  source: 'workspace' | 'installed';
}

/**
 * Gives a generated project a `node_modules` of symlinks: `@cogitator-ai/*` to the workspace
 * packages under test, everything else to an installed copy that satisfies the declared range.
 * Packages in `anyVersion` (type definitions and tools the monorepo pins to another major) take
 * the installed version when none satisfies the range, reported in `drifted`. Returns what it
 * linked and the dependencies it could not satisfy.
 */
export async function linkDependencies(
  projectDir: string,
  dependencies: Record<string, string>,
  options: { anyVersion?: ReadonlySet<string> } = {}
): Promise<{ linked: LinkedDependency[]; missing: string[]; drifted: string[] }> {
  const linked: LinkedDependency[] = [];
  const missing: string[] = [];
  const drifted: string[] = [];
  for (const [name, range] of Object.entries(dependencies)) {
    const workspaceDir = workspacePackageDirs().get(name);
    let installed = workspaceDir ? undefined : findInstalled(name, range);
    if (!workspaceDir && !installed && options.anyVersion?.has(name)) {
      installed = findInstalled(name, '*');
      if (installed) drifted.push(`${name}@${installed.version} for ${range}`);
    }
    const target = workspaceDir ?? installed?.dir;
    if (!target) {
      missing.push(`${name}@${range}`);
      continue;
    }
    const link = join(projectDir, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, 'dir');
    linked.push({
      name,
      range,
      version: workspaceDir
        ? (readManifest(workspaceDir)?.version ?? '?')
        : (installed?.version ?? '?'),
      source: workspaceDir ? 'workspace' : 'installed',
    });
  }
  return { linked, missing, drifted };
}

/** The `@cogitator-ai/*` workspace packages `names` need, themselves included. */
function workspaceClosure(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (name: string) => {
    const dir = workspacePackageDirs().get(name);
    if (!dir || seen.has(name)) return;
    seen.add(name);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const [dep, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      if (range.startsWith('workspace:')) visit(dep);
    }
  };
  names.forEach(visit);
  return [...seen].sort();
}

/**
 * Packs the workspace packages a generated pnpm project needs into its
 * `vendor/` directory and points the project at them, so an image built from
 * it runs the code under test instead of the releases on npm.
 */
export async function vendorWorkspacePackages(
  projectDir: string,
  pack: (packageDir: string, destination: string) => Promise<string>
): Promise<string[]> {
  const manifestPath = join(projectDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const declared = Object.keys({
    ...(manifest.dependencies as Record<string, string> | undefined),
    ...(manifest.devDependencies as Record<string, string> | undefined),
  }).filter((name) => name.startsWith('@cogitator-ai/'));
  const vendor = join(projectDir, 'vendor');
  await mkdir(vendor, { recursive: true });
  const specs: Record<string, string> = {};
  for (const name of workspaceClosure(declared)) {
    const dir = workspacePackageDirs().get(name);
    if (!dir) continue;
    specs[name] = `file:vendor/${await pack(dir, vendor)}`;
  }
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = manifest[field] as Record<string, string> | undefined;
    for (const name of Object.keys(deps ?? {})) if (deps && specs[name]) deps[name] = specs[name];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const workspacePath = join(projectDir, 'pnpm-workspace.yaml');
  const existing = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8').trimEnd() : '';
  const overrides = Object.entries(specs).map(([name, spec]) => `  '${name}': '${spec}'`);
  writeFileSync(
    workspacePath,
    `${existing}\noverrides:\n${overrides.join('\n')}\nminimumReleaseAge: 0\n`
  );
  return Object.keys(specs);
}
