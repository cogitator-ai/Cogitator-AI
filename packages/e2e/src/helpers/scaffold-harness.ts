import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface CommandResult {
  code: number;
  output: string;
}

/** Runs a command without a shell, capturing its output; never throws for a non-zero exit. */
export function exec(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 600_000,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolvePromise({ code: code ?? (signal ? 128 : 1), output })
    );
  });
}

/** Fails with the tail of the output when a command did not exit 0. */
export async function mustExec(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<string> {
  const result = await exec(command, args, options);
  if (result.code !== 0) {
    const tail = result.output.trimEnd().split('\n').slice(-60).join('\n');
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.code} in ${options.cwd}:\n${tail}`
    );
  }
  return result.output;
}

interface WorkspacePackage {
  name: string;
  version: string;
  dir: string;
  workspaceDeps: string[];
}

function readWorkspace(): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const manifestPath = join(PACKAGES_DIR, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      name: string;
      version: string;
      private?: boolean;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (manifest.private) continue;
    const deps = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    packages.set(manifest.name, {
      name: manifest.name,
      version: manifest.version,
      dir: join(PACKAGES_DIR, entry),
      workspaceDeps: Object.entries(deps)
        .filter(([, range]) => range.startsWith('workspace:'))
        .map(([name]) => name),
    });
  }
  return packages;
}

/** The workspace packages `roots` need, themselves included. */
function closure(
  roots: readonly string[],
  workspace: Map<string, WorkspacePackage>
): WorkspacePackage[] {
  const seen = new Map<string, WorkspacePackage>();
  const visit = (name: string) => {
    const pkg = workspace.get(name);
    if (!pkg || seen.has(name)) return;
    seen.set(name, pkg);
    pkg.workspaceDeps.forEach(visit);
  };
  roots.forEach(visit);
  return [...seen.values()];
}

/** A fingerprint of a package's built output, so an unchanged package is packed once. */
function distFingerprint(pkg: WorkspacePackage): string {
  const hash = createHash('sha256').update(pkg.version);
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(full).update(String(statSync(full).mtimeMs));
    }
  };
  walk(join(pkg.dir, 'dist'));
  hash.update(readFileSync(join(pkg.dir, 'package.json')));
  return hash.digest('hex').slice(0, 16);
}

const TARBALL_DIR = join(tmpdir(), 'cogitator-e2e-tarballs');

/**
 * Packs the built workspace packages `roots` depend on into tarballs, the way
 * `pnpm publish` would ship them. Returns the tarball of each package by name.
 */
export async function packWorkspace(roots: readonly string[]): Promise<Record<string, string>> {
  const workspace = readWorkspace();
  mkdirSync(TARBALL_DIR, { recursive: true });
  const tarballs: Record<string, string> = {};
  for (const pkg of closure(roots, workspace)) {
    if (!existsSync(join(pkg.dir, 'dist'))) {
      throw new Error(`${pkg.name} is not built: run pnpm build first`);
    }
    const target = join(
      TARBALL_DIR,
      `${pkg.name.replace('@', '').replace('/', '-')}-${distFingerprint(pkg)}.tgz`
    );
    if (!existsSync(target)) {
      const out = await mustExec('pnpm', ['pack', '--pack-destination', TARBALL_DIR, '--json'], {
        cwd: pkg.dir,
      });
      const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { filename: string };
      const packed = resolve(TARBALL_DIR, parsed.filename);
      writeFileSync(target, readFileSync(packed));
    }
    tarballs[pkg.name] = target;
  }
  return tarballs;
}

/**
 * Points every `@cogitator-ai/*` package of a generated project, direct or
 * transitive, at the workspace tarballs, in the way its package manager reads
 * overrides. Running it again, after `cogitator add` brought new packages,
 * replaces the overrides.
 *
 * pnpm 11 refuses packages published less than a day ago. The harness installs
 * against the newest releases, sometimes hours old, so it turns the wait off.
 */
export function useTarballs(
  projectDir: string,
  pm: PackageManager,
  tarballs: Record<string, string>,
  options: { vendor?: boolean } = {}
): void {
  const manifestPath = join(projectDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  const specs = Object.entries(tarballs).map(([name, file]) => {
    if (!options.vendor) return [name, `file:${file}`] as const;
    const vendored = join(projectDir, 'vendor', basename(file));
    mkdirSync(dirname(vendored), { recursive: true });
    writeFileSync(vendored, readFileSync(file));
    return [name, `file:vendor/${basename(file)}`] as const;
  });
  const overrides = Object.fromEntries(specs);

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = manifest[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const name of Object.keys(deps)) if (overrides[name]) deps[name] = overrides[name];
  }

  if (pm === 'pnpm') {
    const workspacePath = join(projectDir, 'pnpm-workspace.yaml');
    const doc = parseDocument(
      existsSync(workspacePath) ? readFileSync(workspacePath, 'utf-8') : ''
    );
    doc.set('overrides', overrides);
    doc.set('minimumReleaseAge', 0);
    writeFileSync(workspacePath, doc.toString());
  } else if (pm === 'yarn') {
    manifest.resolutions = overrides;
  } else {
    manifest.overrides = overrides;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

export function installArgs(pm: PackageManager): string[] {
  if (pm === 'npm') return ['install', '--no-audit', '--no-fund', '--loglevel=error'];
  if (pm === 'yarn') return ['install'];
  return ['install'];
}

export function runArgs(pm: PackageManager, script: string): [string, string[]] {
  return pm === 'npm' ? ['npm', ['run', script]] : [pm, ['run', script]];
}

export async function hasBinary(command: string): Promise<boolean> {
  try {
    return (await exec(command, ['--version'], { cwd: tmpdir(), timeoutMs: 15_000 })).code === 0;
  } catch {
    return false;
  }
}

/** The `@cogitator-ai/*` packages a generated package.json depends on. */
export function cogitatorDependencies(projectDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) =>
    name.startsWith('@cogitator-ai/')
  );
}

/**
 * Writes the Dockerfile and .dockerignore `cogitator deploy` would build the
 * project with, after the harness changed what the install reads.
 */
export async function regenerateDockerfile(projectDir: string): Promise<void> {
  const { ArtifactGenerator, ProjectAnalyzer } = await import('@cogitator-ai/deploy');
  const analysis = new ProjectAnalyzer().analyze(projectDir, { target: 'docker' }, { env: {} });
  const { files } = new ArtifactGenerator().generate(analysis.deployConfig, analysis);
  for (const file of files) {
    if (file.path === 'Dockerfile' || file.path === '.dockerignore') {
      writeFileSync(join(projectDir, file.path), file.content);
    }
  }
}
