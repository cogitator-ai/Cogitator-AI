/**
 * Fetching a plugin from the source its marketplace entry (or a direct install) names, as
 * Claude Code fetches each kind: a folder of the marketplace, a git repository or a folder of one,
 * an npm package without its install scripts, a zip archive over https, or the folder a command
 * prints. Each fetch says what it pinned, so the same record fetches the same files again
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  type MarketplaceSource,
  type PluginPin,
  type PluginSource,
} from '@cogitator-ai/types';
import { isInside, withoutTrailingSlashes } from '../manifest';
import { compareVersions, isValidRange, maxSatisfying, parseVersion, satisfies } from '../semver';
import { download, isLoopbackHost } from './fetch';
import { checkGitUrl, cloneAt, gitUrlOf } from './marketplace';
import { mustRun, mustRunNpm, runAcceptedShellCommand, runNpm, runTool } from './run';
import { archiveRootOf, MAX_ARCHIVE_ENTRIES, MAX_UNPACKED_BYTES, unzip } from './zip';

/** A plugin fetched to disk */
export interface FetchedPlugin {
  /** The plugin's folder */
  dir: string;
  /** Loaded where it is, never copied: a folder of a local marketplace, a command's link mode */
  inPlace: boolean;
  pin: PluginPin;
  /** The version when neither the manifest nor the entry sets one */
  sourceVersion: string;
  /** The source as the record keeps it, with what it resolved to */
  source: PluginSource;
}

/** What a fetch needs besides the source */
export interface FetchContext {
  /** An empty folder of its own the fetch may fill */
  staging: string;
  /** The marketplace the entry is in: its root folder and source, for relative paths */
  marketplace?: { root: string; source: MarketplaceSource; pluginRoot?: string };
  /** Replaces the platform's fetch for archive downloads */
  fetchFn?: typeof fetch;
  /** Asks a person whether to run the command of a `command` source, shown in full */
  acceptCommand?: (command: string) => Promise<boolean>;
  signal?: AbortSignal;
}

function failed(message: string): CogitatorError {
  return new CogitatorError({ message, code: ErrorCode.PLUGIN_INSTALL_FAILED });
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Fetches the plugin of `source` */
export async function fetchPluginSource(
  source: PluginSource | string,
  context: FetchContext
): Promise<FetchedPlugin> {
  await mkdir(context.staging, { recursive: true });
  if (typeof source === 'string') return fetchRelative(source, context);
  switch (source.source) {
    case 'path':
      return fetchRelative(source.path, context);
    case 'github':
    case 'url':
    case 'git-subdir':
      return fetchGit(source, context);
    case 'npm':
      return fetchNpm(source, context);
    case 'archive':
      return fetchArchive(source, context);
    case 'command':
      return fetchCommand(source, context);
  }
}

async function fetchRelative(path: string, context: FetchContext): Promise<FetchedPlugin> {
  const marketplace = context.marketplace;
  if (!marketplace) throw failed(`The relative source ${path} needs a marketplace to resolve in`);
  if (marketplace.source.source === 'url') {
    throw failed(
      `${path}: a marketplace fetched from a URL has only its marketplace.json, so a relative source cannot resolve, give the plugin a github or git-subdir source`
    );
  }
  const written =
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path) && marketplace.pluginRoot !== undefined
      ? join(marketplace.pluginRoot, path)
      : path;
  const dir = resolve(marketplace.root, written);
  const root = await realpath(marketplace.root);
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    throw failed(`The plugin folder ${path} is not in the marketplace`);
  }
  if (!isInside(root, real)) throw failed(`The plugin folder ${path} leaves the marketplace`);
  const inPlace = marketplace.source.source === 'directory' || marketplace.source.source === 'file';
  let sourceVersion = 'unknown';
  let pinned: string | undefined;
  if (existsSync(join(root, '.git')) || (await insideGit(root))) {
    const commit = await runTool(
      'git',
      ['log', '-1', '--format=%H', '--', relative(root, real) || '.'],
      {
        cwd: root,
      }
    ).catch(() => undefined);
    const sha = commit?.code === 0 ? commit.stdout.trim() : '';
    if (/^[0-9a-f]{40}$/.test(sha)) {
      pinned = sha;
      sourceVersion = sha.slice(0, 12);
    }
  }
  return {
    dir: real,
    inPlace,
    pin: pinned === undefined ? {} : { commit: pinned },
    sourceVersion,
    source: { source: 'path', path },
  };
}

async function insideGit(dir: string): Promise<boolean> {
  const result = await runTool('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir }).catch(
    () => undefined
  );
  return result?.code === 0 && result.stdout.trim() === 'true';
}

async function fetchGit(
  source: Extract<PluginSource, { source: 'github' | 'url' | 'git-subdir' }>,
  context: FetchContext
): Promise<FetchedPlugin> {
  const url =
    source.source === 'github'
      ? gitUrlOf(source)
      : source.source === 'git-subdir' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.url)
        ? `https://github.com/${source.url}.git`
        : source.url;
  checkGitUrl(url);
  const clone = join(context.staging, 'clone');
  const commit = await cloneAt(url, clone, {
    ...(source.ref !== undefined && { ref: source.ref }),
    ...(source.sha !== undefined && { sha: source.sha }),
    ...(source.source === 'git-subdir' && { sparse: [source.path] }),
    ...(context.signal && { signal: context.signal }),
  });
  let dir = clone;
  let sourceVersion = commit.slice(0, 12);
  if (source.source === 'git-subdir') {
    if (isAbsolute(source.path) || source.path.split(/[/\\]/).includes('..')) {
      throw failed(`The subdirectory ${source.path} must stay inside the repository`);
    }
    dir = await realpath(join(clone, source.path)).catch(() => {
      throw failed(`The repository has no folder ${source.path}`);
    });
    if (!isInside(await realpath(clone), dir)) throw failed(`${source.path} leaves the repository`);
    sourceVersion = `${commit.slice(0, 12)}-${sha256(source.path).slice(0, 8)}`;
  }
  return {
    dir,
    inPlace: false,
    pin: { commit },
    sourceVersion,
    source: { ...source, sha: commit },
  };
}

/** Git hosts a tarball link of an npm source may not point at, as Claude Code refuses them */
const GIT_HOSTS = new Set([
  'github.com',
  'gist.github.com',
  'gitlab.com',
  'bitbucket.org',
  'git.sr.ht',
]);

const NpmViewSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  'dist.tarball': z.string().optional(),
  'dist.integrity': z.string().optional(),
  'dist.shasum': z.string().optional(),
  dist: z
    .looseObject({
      tarball: z.string().optional(),
      integrity: z.string().optional(),
      shasum: z.string().optional(),
    })
    .optional(),
});

const NpmPackSchema = z.array(
  z.looseObject({ filename: z.string(), integrity: z.string().optional() })
);

/**
 * Whether `tarball` is the one the registry describes: its `sha512-` integrity when it gives one,
 * else a `sha1-` integrity or the hex `shasum` older packages have. Nothing to check against fails
 */
function matchesRegistry(
  tarball: Buffer,
  sha512: string,
  expected: string | undefined,
  shasum: string | undefined
): boolean {
  const hashes = (expected ?? '').split(/\s+/).filter((hash) => hash !== '');
  const strong = hashes.filter((hash) => hash.startsWith('sha512-'));
  if (strong.length > 0) return strong.includes(sha512);
  const sha1 = createHash('sha1').update(tarball);
  const digest = sha1.digest();
  const weak = hashes.filter((hash) => hash.startsWith('sha1-'));
  if (weak.length > 0) return weak.includes(`sha1-${digest.toString('base64')}`);
  if (shasum !== undefined) return shasum.toLowerCase() === digest.toString('hex');
  return false;
}

/** A dist-tag such as `latest` or `next`: what npm accepts besides a version range */
const NPM_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;

/** A package name part of npm's grammar: URL-safe, not starting with `.` or `_` */
const NPM_NAME_PART = /^[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/**
 * Why `name` is not an npm package name (`name` or `@scope/name`, URL-safe characters, at most
 * 214 of them), undefined when it is one. Checked before npm runs, so nothing in a marketplace's
 * package field reaches a command line but a name
 */
export function npmNameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > 214) return 'must hold 1 to 214 characters';
  const scoped = name.startsWith('@');
  const parts = (scoped ? name.slice(1) : name).split('/');
  if (parts.length !== (scoped ? 2 : 1)) return 'must be name or @scope/name';
  if (!parts.every((part) => NPM_NAME_PART.test(part))) {
    return 'may only hold letters, digits and - . _ ~, not starting with . or _';
  }
  return undefined;
}

/** The registry npm uses when none is given */
async function defaultRegistry(): Promise<string | undefined> {
  const result = await runNpm(['config', 'get', 'registry']).catch(() => undefined);
  return result?.code === 0 ? withoutTrailingSlashes(result.stdout.trim()) : undefined;
}

/** Splits `@scope/name@1.2.3` into the name and what follows the version `@` */
export function splitPackage(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  return { name: spec };
}

async function fetchNpm(
  source: Extract<PluginSource, { source: 'npm' }>,
  context: FetchContext
): Promise<FetchedPlugin> {
  const value = source.package.trim();
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|git@)/i.test(value) || /\.git(#.*)?$/.test(value)) {
    throw failed(
      `npm source ${value}: a git address is not an npm package, use a github, url or git-subdir source`
    );
  }
  if (/^(file:|\.|\/|~)/.test(value) || /^[A-Za-z]:[/\\]/.test(value)) {
    throw failed(
      `npm source ${value}: a folder is not an npm package, use a relative path in the marketplace`
    );
  }
  if (/^npm:/i.test(value))
    throw failed(`npm source ${value}: use the package's own name, not an npm: alias`);
  const registry =
    source.registry === undefined ? undefined : withoutTrailingSlashes(source.registry);
  const fallback = await defaultRegistry();
  if (registry !== undefined) {
    const parsed = new URL(registry);
    if (parsed.protocol !== 'https:' && registry !== fallback && !isLoopbackHost(parsed.hostname)) {
      throw failed(`npm source ${value}: the registry ${registry} must use https`);
    }
  }
  const registryArgs = registry !== undefined ? ['--registry', registry] : [];
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (GIT_HOSTS.has(url.hostname.toLowerCase()) && !url.pathname.startsWith('/api/v4/')) {
      throw failed(
        `npm source ${value}: a tarball link on ${url.hostname} is refused, publish the package to a registry`
      );
    }
    if (
      url.protocol === 'http:' &&
      !(fallback && value.startsWith(fallback)) &&
      !isLoopbackHost(url.hostname)
    ) {
      throw failed(`npm source ${value}: a tarball link over http is refused`);
    }
    const tarball =
      url.protocol === 'https:'
        ? await download(value, 'The npm tarball', {
            ...(context.fetchFn && { fetchFn: context.fetchFn }),
            ...(context.signal && { signal: context.signal }),
          })
        : Buffer.from(
            await (await (context.fetchFn ?? fetch)(url, { redirect: 'error' })).arrayBuffer()
          );
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    return unpackTarball(tarball, integrity, { ...source, package: value }, context);
  }
  const { name, version: appended } = splitPackage(value);
  const wanted = appended ?? source.version ?? 'latest';
  const nameProblem = npmNameProblem(name);
  if (nameProblem) throw failed(`npm source ${value}: the package name ${nameProblem}`);
  if (!isValidRange(wanted) && !NPM_TAG.test(wanted)) {
    throw failed(`npm source ${value}: "${wanted}" is neither a semver range nor a dist-tag`);
  }
  const viewed = await mustRunNpm(
    ['view', `${name}@${wanted}`, 'name', 'version', 'dist', '--json', ...registryArgs],
    { timeoutMs: 60_000, ...(context.signal && { signal: context.signal }) }
  );
  let json: unknown;
  try {
    json = JSON.parse(viewed || 'null');
  } catch {
    throw failed(`npm view ${name}@${wanted} did not answer JSON`);
  }
  const candidates = (Array.isArray(json) ? json : [json]).flatMap((entry) => {
    const parsed = NpmViewSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  if (candidates.length === 0) throw failed(`No version of ${name} matches ${wanted}`);
  const best = candidates.reduce((top, entry) => {
    const a = parseVersion(entry.version);
    const b = parseVersion(top.version);
    return a && b && compareVersions(a, b) > 0 ? entry : top;
  });
  const expected = best.dist?.integrity ?? best['dist.integrity'];
  const shasum = best.dist?.shasum ?? best['dist.shasum'];
  const packed = await mustRunNpm(
    [
      'pack',
      `${name}@${best.version}`,
      '--pack-destination',
      context.staging,
      '--json',
      '--ignore-scripts',
      ...registryArgs,
    ],
    { cwd: context.staging, timeoutMs: 120_000, ...(context.signal && { signal: context.signal }) }
  );
  const pack = NpmPackSchema.safeParse(JSON.parse(packed || '[]'));
  const file = pack.success ? pack.data[0]?.filename : undefined;
  if (!file) throw failed(`npm pack ${name}@${best.version} gave no tarball`);
  const tarball = await readFile(join(context.staging, file));
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (!matchesRegistry(tarball, integrity, expected, shasum)) {
    throw failed(
      expected === undefined && shasum === undefined
        ? `The registry gives no integrity for ${name}@${best.version}, so its tarball cannot be checked`
        : `The tarball of ${name}@${best.version} does not match the integrity the registry gives`
    );
  }
  return unpackTarball(
    tarball,
    integrity,
    { ...source, package: name, version: best.version },
    context,
    best.version
  );
}

async function unpackTarball(
  tarball: Buffer,
  integrity: string,
  source: Extract<PluginSource, { source: 'npm' }>,
  context: FetchContext,
  version?: string
): Promise<FetchedPlugin> {
  const archive = join(context.staging, 'package.tgz');
  await writeFile(archive, tarball);
  const target = join(context.staging, 'unpacked');
  await mkdir(target, { recursive: true });
  await mustRun('tar', ['-xzf', archive, '-C', target], { timeoutMs: 120_000 });
  const dir = existsSync(join(target, 'package')) ? join(target, 'package') : target;
  let resolvedVersion = version;
  if (resolvedVersion === undefined) {
    const meta: unknown = JSON.parse(
      await readFile(join(dir, 'package.json'), 'utf8').catch(() => '{}')
    );
    resolvedVersion =
      typeof meta === 'object' &&
      meta !== null &&
      typeof (meta as { version?: unknown }).version === 'string'
        ? (meta as { version: string }).version
        : 'unknown';
  }
  return {
    dir,
    inPlace: false,
    pin: { npmVersion: resolvedVersion, integrity },
    sourceVersion: resolvedVersion,
    source,
  };
}

async function fetchArchive(
  source: Extract<PluginSource, { source: 'archive' }>,
  context: FetchContext
): Promise<FetchedPlugin> {
  const body = await download(source.url, 'The plugin archive', {
    ...(context.fetchFn && { fetchFn: context.fetchFn }),
    ...(context.signal && { signal: context.signal }),
  });
  const digest = sha256(body);
  if (source.sha256 !== undefined && source.sha256.toLowerCase() !== digest) {
    throw failed(`The archive ${source.url} does not match its sha256 pin`);
  }
  const target = join(context.staging, 'unpacked');
  const written = await unzip(body, target);
  return {
    dir: archiveRootOf(target, written),
    inPlace: false,
    pin: { sha256: digest },
    sourceVersion: digest.slice(0, 12),
    source: { ...source, sha256: digest },
  };
}

/** The files of `dir` hashed by path and content, and how many there are and how big */
async function hashFolder(dir: string): Promise<{ hash: string; entries: number; bytes: number }> {
  const hash = createHash('sha256');
  let entries = 0;
  let bytes = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      entries++;
      if (entries > MAX_ARCHIVE_ENTRIES)
        throw failed(`The folder holds more than ${MAX_ARCHIVE_ENTRIES} entries`);
      const path = join(folder, entry.name);
      hash.update(relative(dir, path));
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        bytes += (await stat(path)).size;
        if (bytes > MAX_UNPACKED_BYTES)
          throw failed(`The folder is larger than ${MAX_UNPACKED_BYTES} bytes`);
        hash.update(await readFile(path));
      }
    }
  };
  await walk(dir);
  return { hash: hash.digest('hex'), entries, bytes };
}

async function fetchCommand(
  source: Extract<PluginSource, { source: 'command' }>,
  context: FetchContext
): Promise<FetchedPlugin> {
  if (!context.acceptCommand || !(await context.acceptCommand(source.command))) {
    throw failed(`Aborted, the command was not run: ${source.command}`);
  }
  const mode = source.mode ?? 'copy';
  if (mode === 'link' && process.platform === 'win32') {
    throw failed(
      'A command source in link mode is not installed on Windows, declare "mode": "copy"'
    );
  }
  const windows = process.platform === 'win32';
  const result = await runAcceptedShellCommand(source.command, {
    cwd: homedir(),
    timeoutMs: (source.timeout ?? 60) * 1000,
    ...(context.signal && { signal: context.signal }),
  });
  if (result.code !== 0)
    throw failed(`The command exited with code ${String(result.code)}: ${result.stderr.trim()}`);
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  const printed = lines[0]?.trim();
  if (lines.length !== 1 || printed === undefined || !isAbsolute(printed)) {
    throw failed('The command must print exactly one line, the absolute path of the plugin folder');
  }
  if (windows && printed.startsWith('\\\\')) throw failed('The command printed a network path');
  const dir = await realpath(printed).catch(() => {
    throw failed(`The folder the command printed does not exist: ${printed}`);
  });
  if (isInside(dir, await realpath(process.cwd()))) {
    throw failed('The command printed the working directory or a folder above it');
  }
  const content = ['.claude-plugin', '.cogitator-plugin', 'skills', 'commands', 'agents', 'hooks'];
  if (!content.some((name) => existsSync(join(dir, name)))) {
    throw failed('The folder the command printed holds no plugin content');
  }
  if (mode === 'link') {
    const top = (await readdir(dir)).sort().join('\n');
    return {
      dir,
      inPlace: true,
      pin: { sha256: sha256(`${dir}\n${top}`) },
      sourceVersion: sha256(`${dir}\n${top}`).slice(0, 12),
      source: { ...source, mode },
    };
  }
  const { hash } = await hashFolder(dir);
  return {
    dir,
    inPlace: false,
    pin: { sha256: hash },
    sourceVersion: hash.slice(0, 12),
    source: { ...source, mode },
  };
}

/**
 * The highest version of `name` that satisfies `range` (every one of them, for the constraints of
 * several plugins) among the repository's tags, as Claude Code resolves a dependency's
 * constraint: tags `<name>--v<version>`
 */
export async function resolveTag(
  url: string,
  name: string,
  range: string | readonly string[]
): Promise<{ tag: string; version: string } | undefined> {
  const ranges = typeof range === 'string' ? [range] : range;
  checkGitUrl(url);
  const listed = await mustRun(
    'git',
    ['-c', 'protocol.file.allow=always', 'ls-remote', '--tags', url],
    { timeoutMs: 60_000 }
  );
  const prefix = `refs/tags/${name}--v`;
  const versions = listed
    .split('\n')
    .map((line) => line.split('\t')[1] ?? '')
    .filter((ref) => ref.startsWith(prefix) && !ref.endsWith('^{}'))
    .map((ref) => ref.slice(prefix.length));
  const fitting = versions.filter((version) => ranges.every((each) => satisfies(version, each)));
  const version = maxSatisfying(fitting, ranges[0] ?? '*');
  return version === undefined ? undefined : { tag: `${name}--v${version}`, version };
}
