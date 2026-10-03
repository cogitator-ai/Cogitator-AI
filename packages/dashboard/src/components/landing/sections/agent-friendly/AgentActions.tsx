'use client';

import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';

/** Hand the docs to an agent: copy a prompt that points at llms.txt, or open a chat with it. */
export function AgentActions({ llmsUrl }: { llmsUrl: string }) {
  const [copied, setCopied] = useState(false);
  const prompt = `Read ${llmsUrl} — the index of the Cogitator docs, each page linked as Markdown — and use it to help me build with Cogitator.`;

  const targets = [
    {
      name: 'ChatGPT',
      href: `https://chatgpt.com/?${new URLSearchParams({ hints: 'search', q: prompt })}`,
    },
    { name: 'Claude', href: `https://claude.ai/new?${new URLSearchParams({ q: prompt })}` },
    {
      name: 'Cursor',
      href: `https://cursor.com/link/prompt?${new URLSearchParams({ text: prompt })}`,
    },
  ];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" onClick={copy} className="brass-ghost !px-3 !py-1.5 text-[11px]">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy prompt'}
      </button>
      {targets.map((target) => (
        <a
          key={target.name}
          href={target.href}
          target="_blank"
          rel="noopener noreferrer"
          className="brass-ghost !px-3 !py-1.5 text-[11px]"
        >
          <ExternalLink className="size-3.5" />
          Open in {target.name}
        </a>
      ))}
    </div>
  );
}
