import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExampleEntry } from '../src/kit/examples.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const EXAMPLE_FILE = /^\d+-[\w-]+\.ts$/;
const SKIPPED_DIRS = new Set(['_shared', 'node_modules', 'create-cogitator-app']);
const SYSTEM_ENV = new Set(['HOME', 'PATH', 'NODE_ENV', 'USER', 'SHELL', 'TMPDIR', 'PWD']);
const IMPORT =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const ENV = /process\.env\.([A-Z][A-Z0-9_]*)|requireEnv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g;

/**
 * Optional peers of the runtime packages, added when an example mentions what
 * they drive: an example with a Postgres adapter needs `pg`.
 */
const PEER_HINTS: Record<string, RegExp> = {
  pg: /postgres/i,
  'better-sqlite3': /sqlite/i,
  ioredis: /redis/i,
  mongodb: /mongo/i,
  '@qdrant/js-client-rest': /qdrant/i,
  grammy: /telegram/i,
  'discord.js': /discord/i,
  '@slack/bolt': /slack/i,
  ws: /webchat|websocket/i,
  dockerode: /docker/i,
  '@extism/extism': /wasm|extism/i,
  openai: /openai/i,
  '@whiskeysockets/baileys': /whatsapp/i,
};

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf-8')) as Manifest;
}

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined;
  }
  const [first, second] = specifier.split('/');
  const name = first.startsWith('@') ? `${first}/${second}` : first;
  return builtinModules.includes(name) ? undefined : name;
}

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT), ...source.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]);
}

/** The `.ts` file a relative import of `from` points at. */
function resolveLocal(examplesDir: string, from: string, specifier: string): string {
  const target = posix
    .normalize(posix.join(posix.dirname(from), specifier))
    .replace(/\.js$/, '.ts');
  const candidate = target.endsWith('.ts') ? target : `${target}.ts`;
  if (!existsSync(join(examplesDir, candidate))) {
    throw new Error(`examples/${from} imports ${specifier}, which is not a file of the examples`);
  }
  return candidate;
}

function titleOf(source: string, name: string): string {
  const header = /\bheader\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(source)?.[1];
  if (header) return header.replace(/^\d+\s*[\u2014\u2013-]\s*/, '').trim();
  const words = name.split('/')[1].replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function workspacePackages(): Map<string, { version: string; manifest: Manifest }> {
  const packages = new Map<string, { version: string; manifest: Manifest }>();
  const dir = join(REPO_ROOT, 'packages');
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf-8')) as Manifest & {
      name: string;
      version: string;
    };
    packages.set(manifest.name, { version: manifest.version, manifest });
  }
  return packages;
}

/**
 * Indexes the runnable examples of the repo: `examples/<category>/NN-name.ts`
 * with the local files they import, the assets next to them, the packages
 * they need at the versions the examples use, and the variables they read.
 * Throws when an example needs a package whose version the repo does not pin.
 */
export function readExamplesIndex(
  examplesDir: string = join(REPO_ROOT, 'examples')
): ExampleEntry[] {
  const examplesManifest = readManifest(join(examplesDir, 'package.json'));
  const rootManifest = readManifest(join(REPO_ROOT, 'package.json'));
  const pinned: Record<string, string> = {
    ...rootManifest.devDependencies,
    ...rootManifest.dependencies,
    ...examplesManifest.devDependencies,
    ...examplesManifest.dependencies,
  };
  const workspace = workspacePackages();
  const versionOf = (name: string, from: string): string => {
    const local = workspace.get(name);
    if (local) return `^${local.version}`;
    const range = pinned[name];
    if (!range || range.startsWith('workspace:')) {
      throw new Error(`examples/${from} needs ${name}, which examples/package.json does not pin`);
    }
    return range;
  };

  const entries: ExampleEntry[] = [];
  const categories = readdirSync(examplesDir)
    .filter((name) => !SKIPPED_DIRS.has(name) && statSync(join(examplesDir, name)).isDirectory())
    .sort();
  for (const category of categories) {
    const names = readdirSync(join(examplesDir, category)).sort();
    const assets = names
      .filter((name) => !name.endsWith('.ts') && name !== 'README.md')
      .map((name) => `${category}/${name}`)
      .filter((path) => statSync(join(examplesDir, path)).isFile());

    for (const file of names.filter((name) => EXAMPLE_FILE.test(name))) {
      const entry = `${category}/${file}`;
      const entryText = readFileSync(join(examplesDir, entry), 'utf-8');
      if (/\bDeno\./.test(entryText)) continue;
      const files = new Set<string>();
      const packages = new Set<string>();
      const env = new Set<string>();
      const visit = (path: string) => {
        if (files.has(path)) return;
        files.add(path);
        const source = readFileSync(join(examplesDir, path), 'utf-8');
        for (const match of source.matchAll(ENV)) {
          const name = match[1] ?? match[2];
          if (name && !SYSTEM_ENV.has(name)) env.add(name);
        }
        for (const specifier of specifiers(source)) {
          if (specifier.startsWith('.')) visit(resolveLocal(examplesDir, path, specifier));
          else {
            const name = packageName(specifier);
            if (name) packages.add(name);
          }
        }
      };
      visit(entry);
      for (const asset of assets) files.add(asset);

      const dependencies: Record<string, string> = {};
      for (const name of packages) {
        dependencies[name] = versionOf(name, entry);
        const peers = workspace.get(name)?.manifest;
        for (const [peer, range] of Object.entries(peers?.peerDependencies ?? {})) {
          if (packages.has(peer) || dependencies[peer]) continue;
          const optional = peers?.peerDependenciesMeta?.[peer]?.optional === true;
          const hint = PEER_HINTS[peer];
          if (optional ? hint?.test(entryText) : true) {
            dependencies[peer] =
              workspace.has(peer) || pinned[peer] ? versionOf(peer, entry) : range;
          }
        }
      }
      const devDependencies: Record<string, string> = { tsx: versionOf('tsx', entry) };
      for (const name of Object.keys(dependencies)) {
        const types = `@types/${name.replace(/^@([^/]+)\//, '$1__')}`;
        if (pinned[types]) devDependencies[types] = pinned[types];
      }

      const name = `${category}/${file.replace(/^\d+-/, '').replace(/\.ts$/, '')}`;
      entries.push({
        name,
        title: titleOf(entryText, name),
        entry,
        files: [...files].sort(),
        dependencies: Object.fromEntries(
          Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
        ),
        devDependencies: Object.fromEntries(
          Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b))
        ),
        env: [...env].sort(),
        runtime: /\bBun\./.test(entryText) ? 'bun' : 'node',
      });
    }
  }
  return entries;
}
