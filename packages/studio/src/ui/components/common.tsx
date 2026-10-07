import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
  CircleStop,
  CircleX,
  Copy,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import type { RunStatus } from '../../protocol';
import { pretty } from '../format';
import { href } from '../router';

export type AnyStatus = RunStatus | 'pending' | 'skipped';

const STATUS_LABEL: Record<AnyStatus, string> = {
  running: 'Running',
  waiting: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  pending: 'Pending',
  skipped: 'Skipped',
};

const STATUS_ICON: Record<AnyStatus, LucideIcon> = {
  running: LoaderCircle,
  waiting: CirclePause,
  completed: CircleCheck,
  failed: CircleX,
  stopped: CircleStop,
  pending: CircleDashed,
  skipped: CircleSlash,
};

export function StatusBadge({ status }: { status: AnyStatus }) {
  return (
    <span className="status" data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StatusIcon({ status, size = 15 }: { status: AnyStatus; size?: number }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className="status-icon" data-status={status} data-tip={STATUS_LABEL[status]}>
      <Icon
        size={size}
        strokeWidth={2}
        style={status === 'running' ? { animation: 'spin 1s linear infinite' } : undefined}
      />
    </span>
  );
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    await writeClipboard(value);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm"
      onClick={() => void copy()}
      aria-label={label}
      data-tip={copied ? 'Copied' : label}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g;

/** JSON with keys, strings, numbers and literals told apart. */
function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index;
    if (index > last) nodes.push(text.slice(last, index));
    const [whole, string, colon, number, literal] = match;
    if (string !== undefined) {
      nodes.push(
        <span key={index} className={colon ? 'j-key' : 'j-string'}>
          {string}
        </span>
      );
      if (colon) nodes.push(colon);
    } else if (number !== undefined) {
      nodes.push(
        <span key={index} className="j-number">
          {number}
        </span>
      );
    } else if (literal !== undefined) {
      nodes.push(
        <span key={index} className="j-literal">
          {literal}
        </span>
      );
    }
    last = index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  const text = pretty(value);
  const structured = typeof value !== 'string';
  return (
    <div className="json">
      <div className="json-head">
        <span>{label ?? 'value'}</span>
        <CopyButton value={text} label={`Copy ${label ?? 'value'}`} />
      </div>
      <pre>{structured ? highlightJson(text) : text}</pre>
    </div>
  );
}

export function Empty({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {Icon && (
        <div className="empty-icon">
          <Icon size={18} />
        </div>
      )}
      {title && <div className="empty-title">{title}</div>}
      {children && <div className="empty-text">{children}</div>}
      {action}
    </div>
  );
}

export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="kbds">
      {keys.map((key) => (
        <kbd key={key} className="kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}

export interface Crumb {
  label: ReactNode;
  to?: string[];
}

/** The bar above every page: where you are, and what you can do there. */
export function Topbar({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) {
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={i} style={{ display: 'contents' }}>
              {i > 0 && <ChevronRight size={14} />}
              {crumb.to && !last ? (
                <a href={href(...crumb.to)} className="truncate">
                  {crumb.label}
                </a>
              ) : (
                <span className={`truncate ${last ? 'crumb-current' : ''}`}>{crumb.label}</span>
              )}
            </span>
          );
        })}
      </nav>
      {actions && <div className="topbar-actions">{actions}</div>}
    </header>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <div className="error-text" role="alert">
      <CircleX size={14} />
      <span>{children}</span>
    </div>
  );
}

/** The message of a caught value, whatever was thrown. */
export function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
