import { ArrowUpRight } from 'lucide-react';
import {
  buildLlmsIndex,
  getDocsSections,
  markdownPath,
  renderPageMarkdown,
  type DocsPage,
} from '@/lib/llms';
import { source } from '@/lib/source';
import { LLMS_FULL_TXT_URL, LLMS_TXT_URL, SITE_URL } from '@/lib/site';
import { Section, SectionHeader } from '../ui';
import { AgentActions } from './agent-friendly/AgentActions';
import { AgentTerminal } from './agent-friendly/AgentTerminal';
import type { TerminalLine } from './agent-friendly/types';

type DocsSection = ReturnType<typeof getDocsSections>[number];

/** Shown in the terminal instead of SITE_URL, which is localhost in development. */
const PUBLIC_ORIGIN = 'https://cogitator.app';
const SAMPLE_SLUGS = ['tools', 'approvals'];
const ENTRIES_PER_SECTION = 2;
const PAGE_PREVIEW_LINES = 16;

const ENTRY = /^- \[(.+?)\]\((\S+?)\)(?::\s*(.*))?$/;

function publicText(text: string): string {
  return text.split(SITE_URL).join(PUBLIC_ORIGIN);
}

function toLine(raw: string, highlightUrl?: string): TerminalLine {
  const text = publicText(raw);
  if (text.startsWith('#')) return { kind: 'heading', text };
  if (text.startsWith('>')) return { kind: 'quote', text };
  const entry = ENTRY.exec(text);
  if (entry) {
    const [, title = '', url = '', description] = entry;
    return {
      kind: 'entry',
      text,
      title,
      url,
      description,
      highlight: highlightUrl !== undefined && url === highlightUrl,
    };
  }
  return { kind: 'out', text };
}

/** The opening of llms.txt plus a few sections, built from the same function that serves it. */
function indexPreview(sections: DocsSection[], sampleUrl: string): TerminalLine[] {
  const lines = buildLlmsIndex().split('\n');
  const entryLines = lines.filter((line) => line.startsWith('- ['));
  const title = lines.find((line) => line.startsWith('# '));
  const summary = lines.find((line) => line.startsWith('> '));
  const preview: TerminalLine[] = [];
  if (title) preview.push(toLine(title));
  if (summary) preview.push(toLine(summary));

  const sampleSection = sections.find((section) =>
    section.pages.some((page) => `${PUBLIC_ORIGIN}${markdownPath(page)}` === sampleUrl)
  );
  const shownSections = sections
    .filter((section) => section.title !== 'Overview' && section !== sampleSection)
    .slice(0, 2);
  if (sampleSection) shownSections.push(sampleSection);

  for (const section of shownSections) {
    preview.push({ kind: 'blank', text: '' });
    preview.push(toLine(`## ${section.title}`));
    const sample = section.pages.findIndex(
      (page) => `${PUBLIC_ORIGIN}${markdownPath(page)}` === sampleUrl
    );
    const pages =
      sample >= 0
        ? section.pages.slice(Math.max(0, sample - 1), sample + 1)
        : section.pages.slice(0, ENTRIES_PER_SECTION);
    for (const page of pages) {
      const url = `${SITE_URL}${markdownPath(page)}`;
      const raw = entryLines.find((line) => line.includes(`](${url})`));
      if (raw) preview.push(toLine(raw, sampleUrl));
    }
  }

  preview.push({ kind: 'blank', text: '' });
  preview.push({
    kind: 'note',
    text: `… ${countPages(sections)} pages in ${sections.length} sections, then ## Optional`,
  });
  return preview;
}

async function pagePreview(
  page: DocsPage | undefined
): Promise<{ lines: TerminalLine[]; url: string; title: string }> {
  if (!page) return { lines: [], url: PUBLIC_ORIGIN, title: '' };
  const markdown = await renderPageMarkdown(page);
  const lines: TerminalLine[] = [];
  let previousBlank = false;
  for (const raw of markdown.split('\n')) {
    const blank = raw.trim() === '';
    if (blank && previousBlank) continue;
    previousBlank = blank;
    lines.push(blank ? { kind: 'blank', text: '' } : toLine(raw));
    if (lines.length >= PAGE_PREVIEW_LINES) break;
  }
  lines.push({ kind: 'note', text: '…' });
  return { lines, url: `${PUBLIC_ORIGIN}${page.url}`, title: page.data.title };
}

function countPages(sections: DocsSection[]): number {
  return sections.reduce((total, section) => total + section.pages.length, 0);
}

export async function AgentFriendlySection() {
  const samplePage = source.getPage(SAMPLE_SLUGS) ?? source.getPages()[0];
  const sampleMarkdownPath = samplePage ? markdownPath(samplePage) : '/docs.mdx';
  const sampleUrl = `${PUBLIC_ORIGIN}${sampleMarkdownPath}`;
  const sections = getDocsSections();
  const page = await pagePreview(samplePage);
  const pages = countPages(sections);

  const script: TerminalLine[] = [
    { kind: 'agent', text: "task: refunds over $100 must wait for a manager's approval" },
    { kind: 'agent', text: 'Reading the Cogitator docs index first.' },
    { kind: 'command', text: `curl -s ${PUBLIC_ORIGIN}${LLMS_TXT_URL}` },
    ...indexPreview(sections, sampleUrl),
    { kind: 'agent', text: `"${page.title}" covers it. Fetching that page as Markdown.` },
    { kind: 'command', text: `curl -s -H 'Accept: text/markdown' ${page.url}` },
    ...page.lines,
    { kind: 'vox', text: 'context acquired' },
    { kind: 'agent', text: 'Adding requiresApproval to refund_order in src/tools.ts' },
  ];

  const facts = [
    {
      path: LLMS_TXT_URL,
      href: LLMS_TXT_URL,
      text: `The index: all ${pages} docs pages, grouped like the sidebar, each linked to its Markdown with a one-line summary.`,
    },
    {
      path: LLMS_FULL_TXT_URL,
      href: LLMS_FULL_TXT_URL,
      text: 'Every page in one Markdown file, in sidebar order — for long-context models and offline reading.',
    },
    {
      path: '/docs/<page>.mdx',
      href: sampleMarkdownPath,
      text: 'Any page as Markdown: append .mdx to its URL, or request it with Accept: text/markdown.',
    },
  ];

  return (
    <Section id="agent-friendly">
      <SectionHeader
        eyebrow="Agent friendly"
        title={
          <>
            Docs your coding agent <span className="text-l-muted">can read.</span>
          </>
        }
        description="Point Claude Code, Cursor or any agent with a shell at cogitator.app and it gets Markdown, not a rendered page: a llms.txt index, the whole docs in one file, and every page at its own URL."
      />

      <div className="mt-12 grid gap-8 sm:mt-14 lg:grid-cols-[1.45fr_1fr] lg:gap-12">
        <AgentTerminal lines={script} />

        <div className="flex flex-col">
          <ul className="divide-y divide-l-line border-y border-l-line">
            {facts.map((fact) => (
              <li key={fact.path} className="py-5">
                <a
                  href={fact.href}
                  className="group inline-flex items-center gap-1.5 font-mono text-[13px] text-l-text"
                >
                  {fact.path}
                  <ArrowUpRight className="size-3.5 text-l-faint transition-colors group-hover:text-l-accent" />
                </a>
                <p className="mt-1.5 text-sm leading-relaxed text-l-muted text-pretty">
                  {fact.text}
                </p>
              </li>
            ))}
          </ul>

          <div className="mt-6">
            <p className="vox-label !text-[12px]">+++ Hand the docs to your agent +++</p>
            <AgentActions llmsUrl={`${PUBLIC_ORIGIN}${LLMS_TXT_URL}`} />
            <p className="mt-3 text-sm leading-relaxed text-l-muted text-pretty">
              Every docs page has the same actions for that page: Copy Markdown, and Open in
              ChatGPT, Claude or Cursor.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}
