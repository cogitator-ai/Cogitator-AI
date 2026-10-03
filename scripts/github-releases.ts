#!/usr/bin/env npx tsx

/**
 * Creates a git tag and a GitHub Release for every published package version that does not have
 * one yet. A version counts as published once npm serves it, so the script is safe to re-run and
 * also backfills versions released before it existed. Release notes are that version's section of
 * the package CHANGELOG.md; `@cogitator-ai/core` is the release GitHub shows as "Latest".
 *
 * Usage: `npx tsx scripts/github-releases.ts [--dry-run]` (needs `gh` authenticated via GH_TOKEN).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const LATEST_PACKAGE = '@cogitator-ai/core';
const PACKAGES_DIR = join(process.cwd(), 'packages');
const NPM_REGISTRY = 'https://registry.npmjs.org/';

interface PublishedPackage {
  name: string;
  version: string;
  dir: string;
}

const run = (command: string, args: string[], input?: string): string =>
  execFileSync(command, args, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();

function publicPackages(): PublishedPackage[] {
  return readdirSync(PACKAGES_DIR)
    .map((dir) => join(PACKAGES_DIR, dir))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        private?: boolean;
      };
      return pkg.private ? null : { name: pkg.name, version: pkg.version, dir };
    })
    .filter((pkg): pkg is PublishedPackage => pkg !== null)
    .sort((a, b) => Number(a.name === LATEST_PACKAGE) - Number(b.name === LATEST_PACKAGE));
}

function remoteTags(): Set<string> {
  const refs = run('git', ['ls-remote', '--tags', 'origin']);
  return new Set(
    refs
      .split('\n')
      .map((line) => line.split('\t')[1] ?? '')
      .filter((ref) => ref.startsWith('refs/tags/') && !ref.endsWith('^{}'))
      .map((ref) => ref.slice('refs/tags/'.length))
  );
}

function isOnNpm({ name, version }: PublishedPackage): boolean {
  try {
    return (
      run('npm', [
        'view',
        `${name}@${version}`,
        'version',
        `--registry=${NPM_REGISTRY}`,
        `--@cogitator-ai:registry=${NPM_REGISTRY}`,
      ]) === version
    );
  } catch {
    return false;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The body of the `## <version>` section of the package changelog. */
function releaseNotes({ name, version, dir }: PublishedPackage): string {
  const fallback = `Published to npm: https://www.npmjs.com/package/${name}/v/${version}`;
  const changelog = join(dir, 'CHANGELOG.md');
  if (!existsSync(changelog)) return fallback;

  const text = readFileSync(changelog, 'utf8');
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\s*$`, 'm').exec(text);
  if (!heading) return fallback;

  const rest = text.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return body ? `${body}\n\n---\n\n${fallback}` : fallback;
}

function main(): void {
  const target = run('git', ['rev-parse', 'HEAD']);
  const tags = remoteTags();
  const pending = publicPackages().filter((pkg) => !tags.has(`${pkg.name}@${pkg.version}`));

  if (pending.length === 0) {
    console.log('Every published version already has a release.');
    return;
  }

  let created = 0;
  for (const pkg of pending) {
    const tag = `${pkg.name}@${pkg.version}`;
    if (!isOnNpm(pkg)) {
      console.log(`skip ${tag}: not on npm yet`);
      continue;
    }

    const latest = pkg.name === LATEST_PACKAGE;
    if (DRY_RUN) {
      console.log(`would release ${tag}${latest ? ' (latest)' : ''}`);
      console.log(
        releaseNotes(pkg)
          .split('\n')
          .slice(0, 6)
          .map((line) => `  | ${line}`)
          .join('\n')
      );
      created += 1;
      continue;
    }

    run(
      'gh',
      [
        'release',
        'create',
        tag,
        '--target',
        target,
        '--title',
        tag,
        '--notes-file',
        '-',
        `--latest=${latest}`,
      ],
      releaseNotes(pkg)
    );
    created += 1;
    console.log(`released ${tag}${latest ? ' (latest)' : ''}`);
  }

  console.log(`${DRY_RUN ? 'Would create' : 'Created'} ${created} release(s).`);
}

main();
