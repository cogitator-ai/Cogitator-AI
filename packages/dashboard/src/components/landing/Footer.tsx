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
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_55%_at_50%_100%,rgba(255,179,71,0.08),transparent_70%)]"
      />
      <div className="relative mx-auto max-w-3xl text-center">
        <h2 className="imperial text-4xl font-semibold leading-[1.1] text-l-text text-balance sm:text-[3.4rem]">
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
          <Link href={GET_STARTED_URL} className="brass-btn group text-[13px]">
            Quick start
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="iron-panel brass-edge relative border-t px-5 pt-16 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-12 sm:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Wordmark />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-l-muted">
            The self-hosted runtime for AI agents in TypeScript. MIT licensed.
          </p>
        </div>
        {columns.map((column) => (
          <div key={column.title}>
            <p className="vox-label !text-[12px]">{column.title}</p>
            <ul className="mt-4 space-y-2.5">
              {column.links.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="text-sm text-l-muted transition-colors hover:text-[#e2c58c]"
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
        className="imperial mx-auto mt-16 max-w-6xl select-none overflow-hidden text-center text-[15vw] font-semibold leading-[0.85] tracking-[0.02em] text-transparent [-webkit-text-stroke:1px_rgb(201_164_92/0.18)] sm:text-[9.5rem]"
      >
        cogitator
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-3 border-t border-l-brass/20 py-6 text-sm text-l-muted">
        <span>© {new Date().getFullYear()} Cogitator · MIT License</span>
        <span className="vox-label !text-[12px] !text-l-brass/70">
          +++ blessed by the machine spirit +++
        </span>
      </div>
    </footer>
  );
}
