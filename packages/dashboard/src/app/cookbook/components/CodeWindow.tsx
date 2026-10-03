'use client';

import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useShiki } from 'fumadocs-core/highlight/client';
import { Check, Copy } from 'lucide-react';
import { CodeBody, Window, cx } from '@/components/landing/ui';
import type { CodeSample } from '../recipes';

export type CodeLanguage = CodeSample['language'];

function PlainCode({ code }: { code: string }) {
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}

function HighlightedCode({ code, language }: { code: string; language: CodeLanguage }) {
  return useShiki(code, {
    lang: language,
    theme: 'vitesse-dark',
    components: {
      pre: ({ style: _style, ...props }) => <pre {...props} />,
    },
  });
}

/** Falls back to plain text when the highlighter cannot load (offline, blocked chunk). */
class HighlightBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
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

/** A cogitator terminal (code variant) holding a highlighted, copyable snippet. */
export function CodeWindow({
  code,
  language,
  title,
  className,
}: {
  code: string;
  language: CodeLanguage;
  title: string;
  className?: string;
}) {
  const plain = <PlainCode code={code} />;

  return (
    <Window
      title={title}
      aside={<CopyButton text={code} label={title} />}
      className={cx('my-5', className)}
    >
      <CodeBody className="leading-[1.7]">
        <HighlightBoundary fallback={plain}>
          <Suspense fallback={plain}>
            <HighlightedCode code={code} language={language} />
          </Suspense>
        </HighlightBoundary>
      </CodeBody>
    </Window>
  );
}
