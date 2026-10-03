import type { InferPageType } from 'fumadocs-core/source';
import type * as PageTree from 'fumadocs-core/page-tree';
import { source } from '@/lib/source';
import {
  COOKBOOK_URL,
  GITHUB_EXAMPLES_URL,
  GITHUB_URL,
  LLMS_FULL_TXT_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from '@/lib/site';

export type DocsPage = InferPageType<typeof source>;

interface DocsSection {
  title: string;
  pages: DocsPage[];
}

/** Content type for every Markdown/plain-text response served to agents. */
/** Markdown copies of docs pages are for agents; the HTML page is the canonical, indexed one. */
export const MARKDOWN_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'X-Robots-Tag': 'noindex',
} as const;

export const PLAIN_TEXT_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
} as const;

/** Path of the Markdown version of a docs page, e.g. `/docs/core/agents.mdx`. */
export function markdownPath(page: DocsPage): string {
  return `${page.url}.mdx`;
}

function absolute(path: string): string {
  return `${SITE_URL}${path}`;
}

function nodeName(node: PageTree.Node): string {
  return typeof node.name === 'string' ? node.name : '';
}

function collectPages(node: PageTree.Node, into: DocsPage[], seen: Set<string>): void {
  if (node.type === 'page') {
    const page = source.getNodePage(node);
    if (page && !seen.has(page.url)) {
      seen.add(page.url);
      into.push(page);
    }
    return;
  }
  if (node.type === 'folder') {
    if (node.index) collectPages(node.index, into, seen);
    for (const child of node.children) collectPages(child, into, seen);
  }
}

/**
 * Group every docs page by the sidebar section it appears under, in sidebar order.
 * Pages that are not reachable from the sidebar are appended under "More", so the
 * output always covers the whole docs source.
 */
export function getDocsSections(): DocsSection[] {
  const seen = new Set<string>();
  const sections: DocsSection[] = [];
  let current: DocsSection = { title: 'Overview', pages: [] };

  for (const node of source.pageTree.children) {
    if (node.type === 'separator') {
      if (current.pages.length > 0) sections.push(current);
      current = { title: nodeName(node) || 'Docs', pages: [] };
      continue;
    }
    collectPages(node, current.pages, seen);
  }
  if (current.pages.length > 0) sections.push(current);

  const unlisted = source.getPages().filter((page) => !seen.has(page.url));
  const overview = unlisted.filter((page) => page.slugs.length === 0);
  const rest = unlisted.filter((page) => page.slugs.length > 0);
  if (overview.length > 0) {
    const first = sections[0];
    if (first?.title === 'Overview') first.pages.unshift(...overview);
    else sections.unshift({ title: 'Overview', pages: overview });
  }
  if (rest.length > 0) sections.push({ title: 'More', pages: rest });

  return sections;
}

function formatEntry(page: DocsPage): string {
  const title = page.data.title.replace(/([[\]])/g, '\\$1');
  const description = page.data.description?.trim();
  const link = `[${title}](${absolute(markdownPath(page))})`;
  return description ? `- ${link}: ${description}` : `- ${link}`;
}

/** `llms.txt`: a short project summary plus a link to the Markdown version of every docs page. */
export function buildLlmsIndex(): string {
  const lines: string[] = [
    `# ${SITE_NAME}`,
    '',
    `> ${SITE_DESCRIPTION}`,
    '',
    'Cogitator is a set of npm packages under the `@cogitator-ai/*` scope. Start with `@cogitator-ai/core` (agents, tools, LLM backends) and add packages for memory, workflows, swarms, RAG, evals, voice, browser automation, messaging channels and server adapters as you need them.',
    '',
    'Install:',
    '',
    '```bash',
    'npm install @cogitator-ai/core zod',
    'npx create-cogitator-app my-agents',
    '```',
    '',
    'Every link below points to the Markdown version of a docs page; drop the `.mdx` suffix for the HTML page.',
    '',
  ];

  for (const section of getDocsSections()) {
    lines.push(`## ${section.title}`, '');
    for (const page of section.pages) lines.push(formatEntry(page));
    lines.push('');
  }

  lines.push(
    '## Optional',
    '',
    `- [Full documentation](${absolute(LLMS_FULL_TXT_URL)}): every docs page above as Markdown in one file`,
    `- [Cookbook](${absolute(COOKBOOK_URL)}): end-to-end recipes for agents, workflows and swarms`,
    `- [Examples](${GITHUB_EXAMPLES_URL}): runnable TypeScript examples for every package`,
    `- [Source code](${GITHUB_URL}): the monorepo on GitHub`,
    ''
  );

  return lines.join('\n');
}

/** One docs page as Markdown, headed by its title, canonical URL and description. */
export async function renderPageMarkdown(page: DocsPage): Promise<string> {
  const body = await page.data.getText('processed');
  const header = [`# ${page.data.title}`, '', `URL: ${absolute(page.url)}`];
  const description = page.data.description?.trim();
  if (description) header.push('', `> ${description}`);
  return `${header.join('\n')}\n\n${body.trim()}\n`;
}

/** `llms-full.txt`: every docs page as Markdown, in sidebar order. */
export async function buildLlmsFull(): Promise<string> {
  const pages = getDocsSections().flatMap((section) => section.pages);
  const rendered = await Promise.all(pages.map(renderPageMarkdown));
  return `${rendered.join('\n---\n\n')}`;
}
