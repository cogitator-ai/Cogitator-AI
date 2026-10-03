'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cx } from './ui';

export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${command}`}
      className={cx(
        'group inline-flex items-center gap-3 rounded-lg border border-l-line-strong bg-l-surface/80 py-2.5 pl-4 pr-3 font-mono text-[13px] text-l-text transition-colors hover:border-white/25',
        className
      )}
    >
      <span className="text-l-faint">$</span>
      <span>{command}</span>
      <span className="ml-1 text-l-faint transition-colors group-hover:text-l-text">
        {copied ? <Check className="size-3.5 text-l-accent" /> : <Copy className="size-3.5" />}
      </span>
    </button>
  );
}
