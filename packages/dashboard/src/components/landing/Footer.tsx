import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import {
  COMMUNITY,
  COOKBOOK_URL,
  DOCS_HOME,
  GET_STARTED_URL,
  GITHUB_EXAMPLES_URL,
  GITHUB_URL,
  LLMS_FULL_TXT_URL,
  LLMS_TXT_URL,
} from '@/lib/site';
import { CopyCommand } from './CopyCommand';
import { Wordmark } from './Logo';

const columns = [
  {
    title: 'Learn',
    links: [
      { label: 'Quick start', href: GET_STARTED_URL },
      { label: 'Documentation', href: DOCS_HOME },
      { label: 'Cookbook', href: COOKBOOK_URL },
      { label: 'Examples', href: GITHUB_EXAMPLES_URL },
    ],
  },
  {
    title: 'For agents',
    links: [
      { label: 'llms.txt', href: LLMS_TXT_URL },
      { label: 'llms-full.txt', href: LLMS_FULL_TXT_URL },
      { label: 'Docs as Markdown', href: '/docs.mdx' },
    ],
  },
  {
    title: 'Community',
    links: [
      { label: 'GitHub', href: GITHUB_URL },
      { label: COMMUNITY.name, href: COMMUNITY.url },
      { label: 'npm', href: 'https://www.npmjs.com/org/cogitator-ai' },
      {
        label: 'Product Hunt',
        href: 'https://www.producthunt.com/posts/cogitator?utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-cogitator',
      },
    ],
  },
];

export function FinalCta() {
  return (
    <section className="relative overflow-hidden px-5 py-28 sm:px-8 sm:py-36">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_55%_at_50%_100%,rgba(0,255,136,0.09),transparent_70%)]"
      />
      <div className="relative mx-auto max-w-3xl text-center">
        <h2 className="text-4xl font-semibold tracking-[-0.04em] text-l-text text-balance sm:text-6xl">
          Ship the agent.
          <br />
          <span className="text-l-muted">Keep the control.</span>
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-l-muted">
          Scaffold a project with your provider, memory and Docker set up, then grow it into
          workflows, swarms and channels package by package.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <CopyCommand command="npx create-cogitator-app" />
          <Link
            href={GET_STARTED_URL}
            className="group inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium text-l-text"
          >
            Quick start
            <ArrowRight className="size-4 text-l-muted transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="relative border-t border-l-line px-5 pt-16 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-12 sm:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Wordmark />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-l-faint">
            The self-hosted runtime for AI agents in TypeScript. MIT licensed.
          </p>
        </div>
        {columns.map((column) => (
          <div key={column.title}>
            <p className="text-xs font-medium text-l-text">{column.title}</p>
            <ul className="mt-4 space-y-2.5">
              {column.links.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="text-sm text-l-faint transition-colors hover:text-l-text"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div
        aria-hidden
        className="mx-auto mt-16 max-w-6xl select-none overflow-hidden text-center text-[18vw] font-semibold leading-[0.8] tracking-[-0.06em] text-transparent [-webkit-text-stroke:1px_rgb(255_255_255/0.07)] sm:text-[12rem]"
      >
        cogitator
      </div>
      <div className="mx-auto flex max-w-6xl justify-between border-t border-l-line py-6 text-xs text-l-faint">
        <span>© {new Date().getFullYear()} Cogitator · MIT License</span>
        <span className="font-mono text-l-brass/70">+++ blessed by the machine spirit +++</span>
      </div>
    </footer>
  );
}
