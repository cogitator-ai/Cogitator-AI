import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the documentation site (Fumadocs MDX in packages/dashboard) into
 * plain Markdown that ships with @cogitator-ai/core, so a coding agent reads
 * the docs of the version a project installed: `node_modules/@cogitator-ai/core/docs/index.md`.
 */

export interface DocPage {
  /** Path in the bundle, such as `core/agents.md`. */
  path: string;
  title: string;
  description: string;
  section: string;
}

export interface BundleResult {
  pages: DocPage[];
}

interface Meta {
  title?: string;
  pages: string[];
}

const SECTION_SEPARATOR = /^---(.+)---$/;
const SITE_LINK = /\]\(\/docs(\/[^)#\s]*)?(#[^)\s]*)?\)/g;

function readMeta(dir: string): Meta {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('pages' in parsed) ||
    !Array.isArray(parsed.pages) ||
    !parsed.pages.every((page: unknown) => typeof page === 'string')
  ) {
    throw new Error(`${join(dir, 'meta.json')} has no list of pages`);
  }
  const title = 'title' in parsed && typeof parsed.title === 'string' ? parsed.title : undefined;
  return { title, pages: parsed.pages as string[] };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed.startsWith('"') ? '"' : trimmed.startsWith("'") ? "'" : undefined;
  if (quote && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePage(
  text: string,
  file: string
): { title: string; description: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) throw new Error(`${file} has no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), unquote(line.slice(colon + 1)));
  }
  const title = fields.get('title');
  if (!title) throw new Error(`${file} has no title`);
  return { title, description: fields.get('description') ?? '', body: text.slice(match[0].length) };
}

/** Where a site route (`/docs/core/agents`) lives in the bundle. */
function bundlePathOf(route: string, source: string): string | undefined {
  const slug = route.replace(/^\/+|\/+$/g, '');
  if (slug === '') return 'introduction.md';
  if (existsSync(join(source, `${slug}.mdx`))) return `${slug}.md`;
  if (existsSync(join(source, slug, 'index.mdx'))) return `${slug}/index.md`;
  return undefined;
}

/** Site links become relative links between the bundled files; a link to a missing page throws. */
function rewriteLinks(body: string, from: string, source: string): string {
  return body.replace(SITE_LINK, (_whole, route: string | undefined, hash: string | undefined) => {
    const target = bundlePathOf(route ?? '', source);
    if (!target) throw new Error(`${from} links to /docs${route ?? ''}, which is not a page`);
    const link = posix.relative(posix.dirname(from), target) || posix.basename(target);
    return `](${link}${hash ?? ''})`;
  });
}

function bundledFileOf(entry: string, folder: string | undefined): string {
  if (!folder) return entry === 'index' ? 'introduction.md' : `${entry}.md`;
  return `${folder}/${entry}.md`;
}

/**
 * Writes the docs in `source` as Markdown to `target`, in the order and
 * sections of the site navigation, with an `index.md` that lists every page.
 */
export function bundleDocs(options: {
  source: string;
  target: string;
  version: string;
}): BundleResult {
  const { source, target, version } = options;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const pages: DocPage[] = [];
  const write = (entry: string, folder: string | undefined, section: string) => {
    const file = join(source, folder ?? '', `${entry}.mdx`);
    const path = bundledFileOf(entry, folder);
    const page = parsePage(readFileSync(file, 'utf-8'), relative(source, file));
    const body = rewriteLinks(page.body, path, source).trim();
    const header = [
      `# ${page.title}`,
      '',
      ...(page.description ? [`> ${page.description}`, ''] : []),
    ];
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), `${[...header, body].join('\n')}\n`);
    pages.push({ path, title: page.title, description: page.description, section });
  };

  let section = 'Introduction';
  write('index', undefined, section);
  for (const entry of readMeta(source).pages) {
    const separator = SECTION_SEPARATOR.exec(entry);
    if (separator) {
      section = separator[1].trim();
      continue;
    }
    const folder = join(source, entry);
    if (existsSync(join(folder, 'meta.json'))) {
      for (const page of readMeta(folder).pages) write(page, entry, section);
    } else if (existsSync(`${folder}.mdx`)) {
      write(entry, undefined, section);
    } else {
      throw new Error(`meta.json lists ${entry}, which is neither a page nor a section`);
    }
  }

  const bySection = new Map<string, DocPage[]>();
  for (const page of pages)
    bySection.set(page.section, [...(bySection.get(page.section) ?? []), page]);
  const index = [
    `# Cogitator ${version} documentation`,
    '',
    `These are the docs of @cogitator-ai/core ${version}, the version installed next to this file. They match the code you have, so trust them over what you remember about Cogitator. Every page is plain Markdown: open the one you need, links between pages are relative.`,
    '',
    ...[...bySection].flatMap(([name, list]) => [
      `## ${name}`,
      '',
      ...list.map(
        (page) =>
          `- [${page.title}](${page.path})${page.description ? `: ${page.description}` : ''}`
      ),
      '',
    ]),
  ];
  writeFileSync(join(target, 'index.md'), index.join('\n'));
  return { pages };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    version: string;
  };
  const { pages } = bundleDocs({
    source: resolve(root, '../dashboard/content/docs'),
    target: join(root, 'docs'),
    version: manifest.version,
  });
  console.log(`Bundled ${pages.length} doc pages into docs/`);
}
