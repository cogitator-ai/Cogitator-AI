'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { GithubIcon } from '@/components/icons/GithubIcon';
import { COOKBOOK_URL, DOCS_HOME, GET_STARTED_URL, GITHUB_URL } from '@/lib/site';
import { Wordmark } from './Logo';
import { cx } from './ui';

const links = [
  { label: 'Docs', href: DOCS_HOME },
  { label: 'Cookbook', href: COOKBOOK_URL },
  { label: 'Features', href: '#features' },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cx(
        'fixed inset-x-0 top-0 z-50 transition-colors duration-300',
        scrolled ? 'iron-panel border-b brass-edge backdrop-blur-xl' : 'border-b border-transparent'
      )}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" aria-label="Cogitator home">
          <Wordmark />
        </Link>
        <div className="flex items-center gap-1 sm:gap-2">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="vox-label hidden rounded-md px-3 py-1.5 !text-[12px] !text-l-muted transition-colors hover:!text-[#e2c58c] sm:block"
            >
              {link.label}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Cogitator on GitHub"
            className="rounded-md p-2 text-l-muted transition-colors hover:text-l-text"
          >
            <GithubIcon className="size-[18px]" />
          </a>
          <Link href={GET_STARTED_URL} className="brass-btn group ml-1 !px-3 !py-1.5 text-[12px]">
            Get started
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </nav>
    </header>
  );
}
