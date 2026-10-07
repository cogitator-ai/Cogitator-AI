import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, sep } from 'node:path';

const CORE = '@cogitator-ai/core';

export interface DocsLocation {
  dir: string;
  version: string;
}

export interface DocEntry {
  /** Path inside the docs, such as `core/agents.md`. */
  path: string;
  title: string;
  description: string;
  section: string;
}

export interface DocsIndex extends DocsLocation {
  entries: DocEntry[];
}

export interface DocHit extends DocEntry {
  /** The heading of the part of the page that matched best. */
  heading?: string;
  snippet: string;
  score: number;
}

function packageRoot(entry: string): string | undefined {
  let dir = dirname(entry);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf-8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'name' in parsed &&
        parsed.name === CORE
      ) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The docs bundled with the @cogitator-ai/core a project installed, falling
 * back to the one the CLI itself depends on.
 */
export function locateDocs(projectDir: string): DocsLocation {
  for (const base of [join(projectDir, 'package.json'), import.meta.url]) {
    let entry: string;
    try {
      entry = createRequire(base).resolve(CORE);
    } catch {
      continue;
    }
    const root = packageRoot(entry);
    if (!root || !existsSync(join(root, 'docs', 'index.md'))) continue;
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      version: string;
    };
    return { dir: join(root, 'docs'), version: manifest.version };
  }
  throw new Error(
    `No bundled docs found: install ${CORE} in the project (they ship in node_modules/${CORE}/docs)`
  );
}

const SECTION = /^## (.+)$/;
const ENTRY = /^- \[(.+?)\]\(([^)]+\.md)\)(?::\s*(.*))?$/;

/** The catalog of pages, read from the `index.md` the docs ship with. */
export function loadDocsIndex(location: DocsLocation): DocsIndex {
  const entries: DocEntry[] = [];
  let section = '';
  for (const line of readFileSync(join(location.dir, 'index.md'), 'utf-8').split('\n')) {
    const heading = SECTION.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    const entry = ENTRY.exec(line);
    if (entry) {
      entries.push({ title: entry[1], path: entry[2], description: entry[3] ?? '', section });
    }
  }
  return { ...location, entries };
}

/** Reads a page; `path#heading` returns only that part of the page. */
export function readDoc(index: DocsIndex, reference: string): string {
  const [rawPath, anchor] = reference.split('#', 2);
  const path = normalize(rawPath.replace(/^\/+/, '')).split(sep).join('/');
  const known = path === 'index.md' || index.entries.some((entry) => entry.path === path);
  if (!known) {
    throw new Error(
      `There is no doc page ${rawPath}: search the docs, or read index.md for the list`
    );
  }
  const text = readFileSync(join(index.dir, path), 'utf-8');
  return anchor ? (sectionOf(text, anchor) ?? text) : text;
}

/** The anchor GitHub and Fumadocs give a heading. */
export function slugOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function sectionOf(text: string, anchor: string): string | undefined {
  const lines = text.split('\n');
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (!heading) continue;
    if (start === -1 && slugOf(heading[2]) === anchor.toLowerCase()) {
      start = i;
      level = heading[1].length;
    } else if (start !== -1 && heading[1].length <= level) {
      return lines.slice(start, i).join('\n').trimEnd();
    }
  }
  return start === -1 ? undefined : lines.slice(start).join('\n').trimEnd();
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) ?? [])];
}

function occurrences(haystack: string, term: string): number {
  let count = 0;
  for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + term.length)) {
    count++;
  }
  return count;
}

interface Block {
  heading?: string;
  text: string;
}

function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let heading: string | undefined;
  let current: string[] = [];
  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) blocks.push({ heading, text: joined });
    current = [];
  };
  for (const line of text.split('\n')) {
    const match = /^#{2,6}\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
    } else if (line.trim() === '') {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

function snippetOf(text: string, needles: readonly string[], width = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = Math.min(
    ...needles.map((needle) => lower.indexOf(needle)).filter((index) => index !== -1),
    flat.length
  );
  const start = Math.max(0, Math.min(at - 60, flat.length - width));
  const slice = flat.slice(start, start + width);
  return `${start > 0 ? '...' : ''}${slice}${start + width < flat.length ? '...' : ''}`;
}

/**
 * Pages that answer `query`, best first. Titles weigh most, then the page
 * descriptions, headings and body text; every term has to appear somewhere on
 * a page for it to count, so `approval tool` finds the approvals guide rather
 * than every page that mentions tools.
 */
export function searchDocs(index: DocsIndex, query: string, limit = 8): DocHit[] {
  const needles = terms(query);
  if (needles.length === 0) return [];
  const hits: DocHit[] = [];
  for (const entry of index.entries) {
    const text = readFileSync(join(index.dir, entry.path), 'utf-8');
    const lower = text.toLowerCase();
    if (!needles.every((needle) => lower.includes(needle))) continue;
    const title = entry.title.toLowerCase();
    const description = entry.description.toLowerCase();
    let score = 0;
    for (const needle of needles) {
      score += (title.includes(needle) ? 12 : 0) + (description.includes(needle) ? 5 : 0);
      score += Math.min(occurrences(lower, needle), 15);
    }
    const blocks = blocksOf(text);
    let best: Block | undefined;
    let bestScore = 0;
    for (const block of blocks) {
      const blockLower = block.text.toLowerCase();
      const headingLower = block.heading?.toLowerCase() ?? '';
      const blockScore = needles.reduce(
        (sum, needle) =>
          sum +
          Math.min(occurrences(blockLower, needle), 5) +
          (headingLower.includes(needle) ? 4 : 0),
        0
      );
      if (blockScore > bestScore) {
        best = block;
        bestScore = blockScore;
      }
    }
    score += bestScore;
    hits.push({
      ...entry,
      ...(best?.heading && { heading: best.heading }),
      snippet: snippetOf(best?.text ?? entry.description, needles),
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
