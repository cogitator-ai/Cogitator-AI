'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { Wordmark } from '@/components/landing/Logo';
import { Vox, Window } from '@/components/landing/ui';
import { DOCS_HOME } from '@/lib/site';

export default function NotFound() {
  const pathname = usePathname();

  return (
    <div className="dark landing-noise flex min-h-screen flex-col items-center justify-center bg-l-bg px-5 text-l-text [color-scheme:dark]">
      <Link href="/" aria-label="Cogitator home" className="mb-12">
        <Wordmark />
      </Link>

      <Window title="cogitator · vox log" crt className="w-full max-w-xl" bodyClassName="px-5 py-6">
        <div className="space-y-2 font-mono text-[13px] leading-relaxed">
          <Vox tone="warn">transmission lost</Vox>
          <p className="text-l-muted">
            <span className="text-l-faint">$</span> GET {pathname}
          </p>
          <p className="text-l-text">
            <span className="text-l-danger">404</span> · the machine spirit could not find this page
          </p>
          <p className="text-l-faint">
            It may have moved, or the link was mistyped.
            <span className="crt-cursor ml-1" />
          </p>
        </div>
      </Window>

      <div className="mt-8 flex gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg bg-l-text px-4 py-2 text-sm font-medium text-l-bg transition-colors hover:bg-white"
        >
          <ArrowLeft className="size-4" />
          Home
        </Link>
        <Link
          href={DOCS_HOME}
          className="inline-flex items-center gap-2 rounded-lg border border-l-line-strong px-4 py-2 text-sm text-l-text transition-colors hover:border-white/25"
        >
          <BookOpen className="size-4" />
          Docs
        </Link>
      </div>
    </div>
  );
}
