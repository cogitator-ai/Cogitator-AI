import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extract } from 'tar';
import { LOCKFILES } from './package-manager.js';
import { PACKAGE_MANAGERS, type PackageManager } from './spec.js';
import { cogitatorVersion, type CogitatorPackage } from './versions.js';

/** A template fetched from a GitHub repository instead of generated: `github:owner/repo[/path][#ref]`. */
export interface RemoteTemplate {
  owner: string;
  repo: string;
  path?: string;
  ref?: string;
}

export function describeTemplate(template: RemoteTemplate): string {
  return `github:${template.owner}/${template.repo}${template.path ? `/${template.path}` : ''}${template.ref ? `#${template.ref}` : ''}`;
}

/** Above this a download is refused: a template is source, not a dataset. */
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * Where the archive of `template` is. With a token it goes through the GitHub
 * API, which serves private repositories; without one through codeload.
 */
export function templateArchive(
  template: RemoteTemplate,
  token?: string
): { url: string; headers: Record<string, string> } {
  const ref = template.ref ?? '';
  if (token) {
    return {
      url: `https://api.github.com/repos/${template.owner}/${template.repo}/tarball/${encodeURIComponent(ref)}`,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    };
  }
  return {
    url: `https://codeload.github.com/${template.owner}/${template.repo}/tar.gz/${encodeURIComponent(ref || 'HEAD')}`,
    headers: {},
  };
}

export interface DownloadResult {
  /** Files written, relative to the directory. */
  files: string[];
  /** Entries left out: links and special files, which a template has no business shipping. */
  skipped: string[];
}

/**
 * Downloads `template` and extracts it, or its `path` inside the repository,
 * into `directory`. Only regular files and directories are written, none
 * outside `directory`.
 */
export async function downloadTemplate(
  template: RemoteTemplate,
  directory: string,
  options: { fetch?: typeof fetch; token?: string } = {}
): Promise<DownloadResult> {
  const { url, headers } = templateArchive(template, options.token);
  const response = await (options.fetch ?? fetch)(url, {
    headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 404) {
    throw new Error(
      `${describeTemplate(template)} was not found: check the repository and the ref${options.token ? '' : ', and set GITHUB_TOKEN for a private repository'}`
    );
  }
  if (!response.ok) {
    throw new Error(`Could not download ${describeTemplate(template)}: HTTP ${response.status}`);
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `${describeTemplate(template)} is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `${describeTemplate(template)} is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`
    );
  }

  const prefix = template.path ? template.path.split('/').filter(Boolean) : [];
  const files: string[] = [];
  const skipped: string[] = [];
  await mkdir(directory, { recursive: true });
  await pipeline(
    Readable.from(archive),
    extract({
      cwd: directory,
      strip: 1 + prefix.length,
      filter: (path, entry) => {
        const inside = path.split('/').slice(1);
        if (!prefix.every((segment, i) => inside[i] === segment)) return false;
        const relative = inside.slice(prefix.length).join('/');
        if (!relative) return false;
        const type = 'type' in entry ? entry.type : entry.isDirectory() ? 'Directory' : 'File';
        if (type === 'File' || type === 'OldFile' || type === 'ContiguousFile') {
          files.push(relative);
          return true;
        }
        if (type === 'Directory') return true;
        skipped.push(relative);
        return false;
      },
    })
  );
  if (files.length === 0) {
    throw new Error(
      template.path
        ? `${describeTemplate(template)} has no files under ${template.path}`
        : `${describeTemplate(template)} is empty`
    );
  }
  return { files: files.sort(), skipped: skipped.sort() };
}

export interface PreparedTemplate {
  /** The package manager its lockfile belongs to, when it has one. */
  packageManager?: PackageManager;
  /** Dependencies rewritten from `workspace:` to published versions. */
  rewritten: string[];
}

/**
 * Makes an extracted template a project of its own: package.json gets the
 * project's name, and `workspace:` ranges of `@cogitator-ai/*` packages, which
 * templates from a monorepo carry, become the versions released with the
 * scaffolder. Other workspace and catalog ranges cannot be resolved outside
 * their monorepo and are refused.
 */
export function prepareTemplate(directory: string, options: { name: string }): PreparedTemplate {
  const lockfile = PACKAGE_MANAGERS.find((pm) => existsSync(join(directory, LOCKFILES[pm])));
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `The template has no package.json at its root (it has ${readdirSync(directory).slice(0, 8).join(', ')}): point --template at the project directory`
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  manifest.name = options.name;
  const rewritten: string[] = [];
  const unresolvable: string[] = [];
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const deps = manifest[field];
    if (typeof deps !== 'object' || deps === null) continue;
    const record = deps as Record<string, unknown>;
    for (const [name, range] of Object.entries(record)) {
      if (typeof range !== 'string') continue;
      if (range.startsWith('workspace:') && name.startsWith('@cogitator-ai/')) {
        record[name] = cogitatorVersion(name as CogitatorPackage);
        rewritten.push(name);
      } else if (range.startsWith('workspace:') || range.startsWith('catalog:')) {
        unresolvable.push(`${name}@${range}`);
      }
    }
  }
  if (unresolvable.length > 0) {
    throw new Error(
      `The template depends on packages of its own monorepo, which cannot be installed outside it: ${unresolvable.join(', ')}`
    );
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { ...(lockfile && { packageManager: lockfile }), rewritten };
}
