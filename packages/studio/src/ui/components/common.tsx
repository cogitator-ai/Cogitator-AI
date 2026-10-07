import { useState, type ReactNode } from 'react';
import type { RunStatus } from '../../protocol';
import { pretty } from '../format';

export function StatusBadge({ status }: { status: RunStatus | 'pending' | 'skipped' }) {
  return (
    <span className={`badge badge-${status}`} data-status={status}>
      {status === 'waiting' ? 'needs approval' : status}
    </span>
  );
}

export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  return (
    <div className="json">
      {label && <div className="json-label">{label}</div>}
      <pre>{pretty(value)}</pre>
    </div>
  );
}

export function Collapsible({
  title,
  children,
  open = false,
}: {
  title: ReactNode;
  children: ReactNode;
  open?: boolean;
}) {
  const [expanded, setExpanded] = useState(open);
  return (
    <div className={`collapsible ${expanded ? 'open' : ''}`}>
      <button
        type="button"
        className="collapsible-title"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="chevron">{expanded ? '▾' : '▸'}</span> {title}
      </button>
      {expanded && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Assistant text with fenced code kept as code and the rest as paragraphs. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i];
    if (prose) {
      for (const [j, paragraph] of prose.split(/\n{2,}/).entries()) {
        if (paragraph.trim()) {
          nodes.push(
            <p key={`p${i}-${j}`}>
              {paragraph
                .split(/(`[^`]+`)/g)
                .map((piece, k) =>
                  piece.startsWith('`') && piece.endsWith('`') && piece.length > 1 ? (
                    <code key={k}>{piece.slice(1, -1)}</code>
                  ) : (
                    <span key={k}>{piece}</span>
                  )
                )}
            </p>
          );
        }
      }
    }
    if (i + 2 < parts.length) {
      nodes.push(
        <pre key={`c${i}`} className="code" data-lang={parts[i + 1] || undefined}>
          {parts[i + 2]}
        </pre>
      );
    }
  }
  return <div className="rich-text">{nodes}</div>;
}
