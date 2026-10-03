import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import { OG_IMAGE_CONTENT_TYPE, OG_IMAGE_SIZE } from '@/lib/og-image';
import { SITE_LOCALE, SITE_NAME, SITE_URL } from '@/lib/site';

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;

export const WEBSITE_ID = `${SITE_URL}/#website`;

export const SOFTWARE_ID = `${SITE_URL}/#software`;

export const SOURCE_CODE_ID = `${SITE_URL}/#source`;

/** Square PNG of the mark served by `app/icon.tsx`; used as the Organization logo. */
export const LOGO_PNG = { path: '/icon/512', size: 512 } as const;

type OpenGraph = NonNullable<Metadata['openGraph']>;

/** Fields every page's Open Graph block repeats, because a page's `openGraph` replaces its parent's. */
export const OPEN_GRAPH_BASE = {
  siteName: SITE_NAME,
  locale: SITE_LOCALE,
} as const satisfies OpenGraph;

export function absoluteUrl(pathname: string): string {
  return new URL(pathname, SITE_URL).toString();
}

/** A 1200×630 PNG card as both Open Graph and Twitter metadata expect it. */
export function socialImage(pathname: string, alt: string) {
  return {
    url: pathname,
    width: OG_IMAGE_SIZE.width,
    height: OG_IMAGE_SIZE.height,
    alt,
    type: OG_IMAGE_CONTENT_TYPE,
  };
}

/**
 * Serialise structured data for a `<script type="application/ld+json">` body. `<` is escaped so
 * text such as `</script>` inside a description cannot end the script element early.
 */
export function jsonLd(data: object): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const PACKAGE_ROOT = process.cwd();

let gitDates: Map<string, Date> | undefined;

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Date of the last commit that touched each file of this package, keyed by absolute path. Built
 * with a single `git log` and kept for the life of the process. Empty when the build has no git
 * checkout (for example a Docker context or an uploaded deployment). In a shallow clone, files
 * last changed before the cut-off get the date of the oldest fetched commit, an upper bound.
 */
function commitDates(): Map<string, Date> {
  if (gitDates) return gitDates;
  const dates = new Map<string, Date>();
  try {
    const top = git(['rev-parse', '--show-toplevel']).trim();
    const log = git(['log', '--format=%x00%cI', '--name-only', '--', '.']);
    let commitDate: Date | undefined;
    for (const line of log.split('\n')) {
      if (line.startsWith('\0')) {
        commitDate = new Date(line.slice(1));
      } else if (line && commitDate) {
        const file = path.join(top, line);
        if (!dates.has(file)) dates.set(file, commitDate);
      }
    }
  } catch {
    dates.clear();
  }
  gitDates = dates;
  return dates;
}

function newest(dates: Iterable<Date>): Date | undefined {
  let latest: Date | undefined;
  for (const date of dates) if (!latest || date > latest) latest = date;
  return latest;
}

function modifiedTimes(target: string): Date[] {
  try {
    const stat = statSync(target);
    if (!stat.isDirectory()) return [stat.mtime];
    return readdirSync(target).flatMap((entry) => modifiedTimes(path.join(target, entry)));
  } catch {
    return [];
  }
}

/**
 * When the given files or directories (relative to the package root, or absolute) last changed:
 * the newest commit touching them, or the newest file modification time when git history is not
 * available. `undefined` when neither source knows the paths.
 */
export function lastModified(...targets: string[]): Date | undefined {
  const dates = commitDates();
  const absolute = targets.map((target) =>
    path.resolve(/* turbopackIgnore: true */ PACKAGE_ROOT, target)
  );

  const committed = newest(
    absolute.flatMap((target) => {
      const exact = dates.get(target);
      if (exact) return [exact];
      const prefix = `${target}${path.sep}`;
      return [...dates].filter(([file]) => file.startsWith(prefix)).map(([, date]) => date);
    })
  );
  return committed ?? newest(absolute.flatMap(modifiedTimes));
}
