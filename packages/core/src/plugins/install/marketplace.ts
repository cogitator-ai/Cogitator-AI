/**
 * Marketplaces in the format of Claude Code's `.claude-plugin/marketplace.json`: reading and
 * checking the file, telling a marketplace source from what a person types, and fetching it
 */

import { existsSync, statSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type MarketplaceSource,
  type PluginDiagnostic,
} from '@cogitator-ai/types';
import {
  isInside,
  isKebabCase,
  marketplaceNameProblem,
  OFFICIAL_MARKETPLACES,
  pluginNameProblem,
  withoutTrailingSlashes,
} from '../manifest';
import { download, isLoopbackHost } from './fetch';
import { mustRun } from './run';

/** Where a marketplace's manifest is, relative to its root */
export const MARKETPLACE_FILE = join('.claude-plugin', 'marketplace.json');

const PluginSourceSchema = z.union([
  z.string(),
  z.object({
    source: z.literal('github'),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/repo'),
    ref: z.string().optional(),
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'must be a full 40-character lowercase commit SHA')
      .optional(),
  }),
  z.object({
    source: z.literal('url'),
    url: z.string().min(1),
    ref: z.string().optional(),
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'must be a full 40-character lowercase commit SHA')
      .optional(),
  }),
  z.object({
    source: z.literal('git-subdir'),
    url: z.string().min(1),
    path: z.string().min(1),
    ref: z.string().optional(),
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'must be a full 40-character lowercase commit SHA')
      .optional(),
  }),
  z.object({
    source: z.literal('npm'),
    package: z
      .string()
      .min(1)
      .refine((value) => !value.includes('..'), 'may not hold ".."'),
    version: z.string().optional(),
    registry: z.string().optional(),
  }),
  z.object({
    source: z.literal('archive'),
    url: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters')
      .optional(),
  }),
  z.object({
    source: z.literal('command'),
    command: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => /^[\x20-\x7e]*$/.test(value), 'must be printable ASCII')
      .refine((value) => !/ {4,}/.test(value), 'may not hold a run of four or more spaces'),
    timeout: z.number().int().min(1).max(600).optional(),
    mode: z.enum(['copy', 'link']).optional(),
  }),
]);

const EntrySchema = z.looseObject({
  name: z.string().min(1),
  source: PluginSourceSchema,
  strict: z.boolean().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
});

const MarketplaceSchema = z.looseObject({
  name: z.string().min(1, 'Marketplace must have a name'),
  owner: z.looseObject({ name: z.string().min(1, 'Author name cannot be empty') }),
  plugins: z.array(z.unknown()),
  description: z.string().optional(),
  version: z.string().optional(),
  metadata: z
    .looseObject({
      description: z.string().optional(),
      version: z.string().optional(),
      pluginRoot: z.string().optional(),
    })
    .optional(),
  allowCrossMarketplaceDependenciesOn: z.array(z.string()).optional(),
});

/** A marketplace read from its file, with the problems of its entries */
export interface ReadMarketplace {
  manifest: MarketplaceManifest;
  diagnostics: PluginDiagnostic[];
}

/** Whether the source of a marketplace may use one of Anthropic's own names */
function officialSource(source: MarketplaceSource): boolean {
  if (source.source === 'github') return source.repo.toLowerCase().startsWith('anthropics/');
  if (source.source === 'git') {
    return /^(?:https?:\/\/|git@)github\.com[/:]anthropics\//i.test(source.url);
  }
  return false;
}

/**
 * Reads a marketplace's `marketplace.json` text: a broken top level fails it, each plugin entry is
 * checked on its own, so one bad entry leaves the others usable
 */
export function parseMarketplace(
  text: string,
  file: string,
  source: MarketplaceSource
): ReadMarketplace {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new CogitatorError({
      message: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      code: ErrorCode.PLUGIN_INVALID,
    });
  }
  const parsed = MarketplaceSchema.safeParse(json);
  if (!parsed.success) {
    throw new CogitatorError({
      message: `${file}: ${z.prettifyError(parsed.error).replace(/\n/g, ' ')}`,
      code: ErrorCode.PLUGIN_INVALID,
    });
  }
  const top = parsed.data;
  const problem = marketplaceNameProblem(top.name);
  if (problem) {
    throw new CogitatorError({
      message: `${file}: the marketplace name "${top.name}" ${problem}`,
      code: ErrorCode.PLUGIN_INVALID,
    });
  }
  if (
    OFFICIAL_MARKETPLACES.has(
      top.name
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '-')
        .replace(/\.$/, '')
    ) &&
    !officialSource(source)
  ) {
    throw new CogitatorError({
      message: `${file}: Marketplace name impersonates an official Anthropic/Claude marketplace`,
      code: ErrorCode.PLUGIN_INVALID,
    });
  }
  const diagnostics: PluginDiagnostic[] = [];
  const plugins: MarketplacePluginEntry[] = [];
  const seen = new Set<string>();
  top.plugins.forEach((value, index) => {
    const entry = EntrySchema.safeParse(value);
    if (!entry.success) {
      diagnostics.push({
        level: 'error',
        message: `plugins[${index}]: ${z.prettifyError(entry.error).replace(/\n/g, ' ')}`,
        path: file,
      });
      return;
    }
    const name = entry.data.name;
    const nameProblem =
      pluginNameProblem(name) ??
      (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
        ? undefined
        : 'may only use letters, digits, ".", "_" and "-", starting with a letter or digit');
    if (nameProblem) {
      diagnostics.push({
        level: 'error',
        message: `plugins[${index}]: the plugin name "${name}" ${nameProblem}`,
        path: file,
      });
      return;
    }
    if (seen.has(name)) {
      diagnostics.push({
        level: 'error',
        message: `Duplicate plugin name "${name}" found in marketplace`,
        path: file,
      });
      return;
    }
    seen.add(name);
    if (!isKebabCase(name)) {
      diagnostics.push({
        level: 'warning',
        message: `plugins[${index}]: the plugin name "${name}" is not kebab-case`,
        path: file,
      });
    }
    if (typeof entry.data.source === 'string') {
      const relative = entry.data.source;
      const bare =
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(relative) && top.metadata?.pluginRoot !== undefined;
      if (!(relative === '.' || relative.startsWith('./') || bare)) {
        diagnostics.push({
          level: 'error',
          message: `plugins.${index}.source: Invalid string: must start with "./"`,
          path: file,
        });
        return;
      }
      if (relative.split('/').includes('..')) {
        diagnostics.push({
          level: 'error',
          message: `plugins[${index}].source: Path contains "..": ${relative}`,
          path: file,
        });
        return;
      }
    }
    plugins.push(entry.data as unknown as MarketplacePluginEntry);
  });
  if (plugins.length === 0 && top.plugins.length === 0) {
    diagnostics.push({
      level: 'warning',
      message: 'Marketplace has no plugins defined',
      path: file,
    });
  }
  return {
    manifest: {
      name: top.name,
      owner: {
        name: top.owner.name,
        ...(typeof top.owner.email === 'string' && { email: top.owner.email }),
        ...(typeof top.owner.url === 'string' && { url: top.owner.url }),
      },
      ...(top.description !== undefined && { description: top.description }),
      ...(top.version !== undefined && { version: top.version }),
      ...(top.metadata && { metadata: top.metadata }),
      ...(top.allowCrossMarketplaceDependenciesOn && {
        allowCrossMarketplaceDependenciesOn: top.allowCrossMarketplaceDependenciesOn,
      }),
      plugins,
    },
    diagnostics,
  };
}

/**
 * The marketplace source what a person typed names, as `claude plugin marketplace add` reads it:
 * `owner/repo` (with `#ref` or `@ref`), a git URL, an `https` link to a `marketplace.json`, or a
 * local folder or file
 */
export function marketplaceSourceOf(input: string, cwd: string = process.cwd()): MarketplaceSource {
  const text = input.trim();
  const local =
    /^(\.{1,2}[/\\]|\/|~[/\\]|[A-Za-z]:[/\\])/.test(text) || text === '.' || text === '..';
  if (local) {
    const path = resolve(cwd, text.startsWith('~') ? join(homedir(), text.slice(2)) : text);
    if (existsSync(path) && statSync(path).isFile()) return { source: 'file', path };
    return { source: 'directory', path };
  }
  const withRef = (url: string): { url: string; ref?: string } => {
    const hash = url.indexOf('#');
    return hash === -1 ? { url } : { url: url.slice(0, hash), ref: url.slice(hash + 1) };
  };
  if (/^[^\s@/]+@[^\s:]+:/.test(text)) {
    const { url, ref } = withRef(text);
    return { source: 'git', url, ...(ref && { ref }) };
  }
  if (/^https?:\/\//i.test(text)) {
    const { url, ref } = withRef(text);
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const repository =
      (host === 'github.com' || host === 'gitlab.com') &&
      parsed.pathname.split('/').filter(Boolean).length >= 2;
    if (url.endsWith('.git') || url.includes('/_git/'))
      return { source: 'git', url, ...(ref && { ref }) };
    if (repository) {
      return { source: 'git', url: `${withoutTrailingSlashes(url)}.git`, ...(ref && { ref }) };
    }
    return { source: 'url', url };
  }
  if (/^file:\/\//i.test(text)) {
    const { url, ref } = withRef(text);
    return { source: 'git', url, ...(ref && { ref }) };
  }
  const github = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:[#@](.+))?$/.exec(text);
  if (github) {
    return {
      source: 'github',
      repo: `${github[1]}/${github[2]}`,
      ...(github[3] && { ref: github[3] }),
    };
  }
  throw new CogitatorError({
    message: 'Invalid marketplace source format. Try: owner/repo, https://..., or ./path',
    code: ErrorCode.VALIDATION_ERROR,
  });
}

/** The git URL of a git or GitHub source */
export function gitUrlOf(
  source: { source: 'github'; repo: string } | { source: 'git' | 'url'; url: string }
): string {
  return source.source === 'github' ? `https://github.com/${source.repo}.git` : source.url;
}

/** Checks a git URL the way installs allow it: https, ssh, a local `file://`, http only to this machine */
export function checkGitUrl(url: string): void {
  if (url.startsWith('-')) {
    throw new CogitatorError({
      message: `${url} is not a git URL: it would be read as an option of git`,
      code: ErrorCode.PLUGIN_INSTALL_FAILED,
    });
  }
  if (/^[^\s@/]+@[^\s:]+:/.test(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CogitatorError({
      message: `${url} is not a git URL`,
      code: ErrorCode.PLUGIN_INSTALL_FAILED,
    });
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'ssh:' || parsed.protocol === 'file:')
    return;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return;
  throw new CogitatorError({
    message: `${url}: git sources use https, ssh or file, and http only to this machine`,
    code: ErrorCode.PLUGIN_INSTALL_FAILED,
  });
}

/**
 * Clones `url` into `dir` at `ref` (a branch or tag) or `sha` (a full commit, which wins), with
 * only `sparse` folders checked out when given, and returns the commit checked out
 */
export async function cloneAt(
  url: string,
  dir: string,
  options: { ref?: string; sha?: string; sparse?: readonly string[]; signal?: AbortSignal } = {}
): Promise<string> {
  checkGitUrl(url);
  await mkdir(dirname(dir), { recursive: true });
  const git = (args: string[], cwd?: string) =>
    mustRun(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args],
      {
        ...(cwd !== undefined && { cwd }),
        ...(options.signal && { signal: options.signal }),
      }
    );
  const sparse = options.sparse && options.sparse.length > 0;
  await git([
    'clone',
    '--quiet',
    ...(options.sha === undefined && options.ref !== undefined
      ? ['--branch', options.ref, '--depth', '1']
      : []),
    ...(sparse ? ['--filter=blob:none', '--sparse'] : []),
    '--',
    url,
    dir,
  ]);
  if (sparse) await git(['sparse-checkout', 'set', '--', ...(options.sparse ?? [])], dir);
  if (options.sha !== undefined) {
    await git(['checkout', '--quiet', '--detach', options.sha], dir).catch(async () => {
      await git(['fetch', '--quiet', 'origin', options.sha ?? ''], dir);
      await git(['checkout', '--quiet', '--detach', options.sha ?? ''], dir);
    });
  }
  return (await git(['rev-parse', 'HEAD'], dir)).trim();
}

/** Where a fetched marketplace is: its root folder and its manifest file */
export interface FetchedMarketplace {
  root: string;
  file: string;
  commit?: string;
  read: ReadMarketplace;
}

/**
 * Fetches the marketplace of `source` into `<plugins>/marketplaces/<name>/` (a local file or
 * folder is read in place), checking its manifest. `fetchFn` replaces the platform's fetch for a
 * `url` source
 */
export async function fetchMarketplace(
  source: MarketplaceSource,
  pluginsRoot: string,
  options: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /**
     * Checks the marketplace read before its folder is replaced, throwing to refuse it: the files
     * of the marketplace already there stay as they were
     */
    accept?: (read: ReadMarketplace) => void;
  } = {}
): Promise<FetchedMarketplace> {
  if (source.source === 'file' || source.source === 'directory') {
    const file = source.source === 'file' ? source.path : join(source.path, MARKETPLACE_FILE);
    const root = source.source === 'file' ? dirname(dirname(file)) : source.path;
    const text = await readFile(file, 'utf8').catch((error: unknown) => {
      throw new CogitatorError({
        message: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        code: ErrorCode.PLUGIN_INSTALL_FAILED,
      });
    });
    const read = parseMarketplace(text, file, source);
    options.accept?.(read);
    return { root, file, read };
  }
  const staging = await mkdtemp(
    join(await ensureDir(join(pluginsRoot, 'marketplaces')), '.incoming-')
  );
  try {
    if (source.source === 'url') {
      const body = await download(source.url, 'The marketplace file', {
        ...(source.headers && { headers: source.headers }),
        maxBytes: 16 * 1024 * 1024,
        ...(options.fetchFn && { fetchFn: options.fetchFn }),
        ...(options.signal && { signal: options.signal }),
      });
      const text = body.toString('utf8');
      const read = parseMarketplace(text, source.url, source);
      options.accept?.(read);
      const root = join(pluginsRoot, 'marketplaces', read.manifest.name);
      await rm(root, { recursive: true, force: true });
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      const file = join(root, MARKETPLACE_FILE);
      await writeFile(file, text, 'utf8');
      return { root, file, read };
    }
    const clone = join(staging, 'clone');
    const commit = await cloneAt(gitUrlOf(source), clone, {
      ...(source.ref !== undefined && { ref: source.ref }),
      ...(source.sparsePaths && { sparse: source.sparsePaths }),
      ...(options.signal && { signal: options.signal }),
    });
    const relative = source.path ?? MARKETPLACE_FILE;
    if (isAbsolute(relative) || relative.split(/[/\\]/).includes('..')) {
      throw new CogitatorError({
        message: `The marketplace path ${relative} must stay inside the repository`,
        code: ErrorCode.PLUGIN_INSTALL_FAILED,
      });
    }
    const cloneFile = join(clone, relative);
    const text = await readFile(cloneFile, 'utf8').catch(() => {
      throw new CogitatorError({
        message: `The repository has no ${relative}`,
        code: ErrorCode.PLUGIN_INSTALL_FAILED,
      });
    });
    const read = parseMarketplace(text, relative, source);
    options.accept?.(read);
    const root = join(pluginsRoot, 'marketplaces', read.manifest.name);
    await rm(root, { recursive: true, force: true });
    await rename(clone, root);
    return { root, file: join(root, relative), commit, read };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Copies a plugin folder into place without its `.git`, leaving out links that lead outside it
 * (a plugin may only reach its own files)
 */
export async function copyPluginFolder(from: string, to: string): Promise<void> {
  const root = await realpath(from);
  await rm(to, { recursive: true, force: true });
  await mkdir(dirname(to), { recursive: true });
  await cp(root, to, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: async (source) => {
      const under = relative(root, source);
      if (under.split(sep).includes('.git')) return false;
      const info = await lstat(source);
      if (!info.isSymbolicLink()) return true;
      try {
        return isInside(root, await realpath(source));
      } catch {
        return false;
      }
    },
  });
}
