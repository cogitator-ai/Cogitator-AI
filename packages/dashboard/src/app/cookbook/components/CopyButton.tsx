'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cx } from '@/components/landing/ui';

/** Copies a snippet; sits on the title plate of a code window. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-[family-name:var(--font-screen)] text-[11px] uppercase tracking-[0.12em] transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70',
        copied
          ? 'border-[#7fd4b5]/40 text-[#a8d9c7]'
          : 'border-l-brass/30 text-l-brass/80 hover:border-l-brass/60 hover:text-[#e2c58c]'
      )}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
