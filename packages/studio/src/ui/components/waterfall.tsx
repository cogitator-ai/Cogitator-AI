import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  ExternalLink,
  Layers,
  Sparkles,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { RunRecord, SpanRecord, ToolCallRecord } from '../../protocol';
import { formatCost, formatDuration, formatTokens } from '../format';
import { href } from '../router';
import { ErrorText, JsonBlock, StatusBadge } from './common';
import { Markdown } from './markdown';

type RowKind = SpanRecord['kind'] | 'run';

interface Row {
  key: string;
  depth: number;
  label: string;
  kind: RowKind;
  start: number;
  end: number;
  status: 'ok' | 'error' | 'unset' | 'running';
  span?: SpanRecord;
  run: RunRecord;
}

const KIND_ICON: Record<RowKind, LucideIcon> = {
  run: Bot,
  llm: Sparkles,
  tool: Wrench,
  agent: Bot,
  handoff: ArrowRight,
  other: Layers,
};

const KIND_LABEL: Record<RowKind, string> = {
  run: 'Agent run',
  llm: 'Model call',
  tool: 'Tool call',
  agent: 'Agent',
  handoff: 'Handoff',
  other: 'Span',
};

function runRows(
  run: RunRecord,
  runs: Record<string, RunRecord>,
  depth: number,
  now: number
): Row[] {
  const rows: Row[] = [];
  const agentSpan = run.spans.find((span) => span.kind === 'agent');
  rows.push({
    key: `run-${run.id}`,
    depth,
    label: run.kind === 'workflow' ? run.target : (run.agentName ?? run.target),
    kind: 'run',
    start: agentSpan?.startTime ?? run.startedAt,
    end: agentSpan?.endTime ?? run.endedAt ?? now,
    status:
      run.status === 'running' || run.status === 'waiting'
        ? 'running'
        : run.status === 'completed'
          ? 'ok'
          : 'error',
    run,
    ...(agentSpan && { span: agentSpan }),
  });
  const children = run.children
    .map((id) => runs[id])
    .filter((child): child is RunRecord => child !== undefined);
  const placed = new Set<string>();
  for (const span of run.spans) {
    if (span.kind === 'agent') continue;
    rows.push({
      key: span.id,
      depth: depth + 1,
      label: span.kind === 'llm' ? (span.model ?? 'model') : span.name.replace(/^tool\./, ''),
      kind: span.kind,
      start: span.startTime,
      end: span.endTime,
      status: span.status,
      span,
      run,
    });
    if (span.kind === 'tool') {
      const callId = span.attributes['tool.call_id'];
      for (const child of children) {
        if (child.parentToolCallId && child.parentToolCallId === callId) {
          placed.add(child.id);
          rows.push(...runRows(child, runs, depth + 2, now));
        }
      }
    }
  }
  for (const child of children) {
    if (!placed.has(child.id)) rows.push(...runRows(child, runs, depth + 1, now));
  }
  return rows;
}

function rowCost(row: Row): number | undefined {
  if (row.kind === 'run') return row.run.usage?.priced === false ? undefined : row.run.usage?.cost;
  return row.span?.cost;
}

function rowTokens(row: Row): number | undefined {
  if (row.span?.kind !== 'llm') return undefined;
  return (row.span.inputTokens ?? 0) + (row.span.outputTokens ?? 0);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toolCallOf(row: Row): ToolCallRecord | undefined {
  const callId = row.span?.attributes['tool.call_id'];
  return row.run.toolCalls.find((call) => call.id === callId);
}

const SHOWN_ATTRIBUTES = new Set([
  'llm.model',
  'llm.input_tokens',
  'llm.output_tokens',
  'llm.cached_input_tokens',
  'llm.reasoning_tokens',
  'llm.iteration',
  'llm.finish_reason',
  'tool.name',
  'tool.call_id',
  'tool.arguments',
  'tool.success',
  'tool.error',
]);

function Inspector({
  row,
  origin,
  root,
  onClose,
}: {
  row: Row;
  origin: number;
  root: RunRecord;
  onClose: () => void;
}) {
  const Icon = row.run.kind === 'workflow' && row.kind === 'run' ? Workflow : KIND_ICON[row.kind];
  const attributes = row.span?.attributes ?? {};
  const rest = Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !SHOWN_ATTRIBUTES.has(key))
  );
  const call = row.kind === 'tool' ? toolCallOf(row) : undefined;
  const cost = rowCost(row);
  const llm = row.span?.kind === 'llm' ? row.span : undefined;
  const cached = num(attributes['llm.cached_input_tokens']);
  const reasoning = num(attributes['llm.reasoning_tokens']);

  return (
    <>
      <div className="inspector-backdrop" onMouseDown={onClose} />
      <aside className="inspector" aria-label="Span details" data-testid="inspector" data-dialog>
        <div className="inspector-head">
          <Icon size={16} style={{ marginTop: 2, color: 'var(--text-3)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>{row.label}</h3>
            <div className="inspector-kind">{KIND_LABEL[row.kind]}</div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="inspector-body">
          <dl className="kv">
            <dt>Duration</dt>
            <dd>{formatDuration(row.end - row.start)}</dd>
            <dt>Starts at</dt>
            <dd>+{formatDuration(row.start - origin)}</dd>
            {row.kind === 'run' && (
              <>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={row.run.status} />
                </dd>
                {row.run.model && (
                  <>
                    <dt>Model</dt>
                    <dd className="mono">{row.run.model}</dd>
                  </>
                )}
                {row.run.usage && (
                  <>
                    <dt>Tokens</dt>
                    <dd>
                      {formatTokens(row.run.usage.inputTokens)} in,{' '}
                      {formatTokens(row.run.usage.outputTokens)} out
                    </dd>
                  </>
                )}
              </>
            )}
            {llm && (
              <>
                <dt>Model</dt>
                <dd className="mono">{llm.model ?? '-'}</dd>
                <dt>Input tokens</dt>
                <dd>
                  {formatTokens(llm.inputTokens)}
                  {cached !== undefined && cached > 0 && (
                    <span className="muted"> ({formatTokens(cached)} cached)</span>
                  )}
                </dd>
                <dt>Output tokens</dt>
                <dd>
                  {formatTokens(llm.outputTokens)}
                  {reasoning !== undefined && reasoning > 0 && (
                    <span className="muted"> ({formatTokens(reasoning)} reasoning)</span>
                  )}
                </dd>
                {attributes['llm.iteration'] !== undefined && (
                  <>
                    <dt>Iteration</dt>
                    <dd>{String(attributes['llm.iteration'])}</dd>
                  </>
                )}
                {attributes['llm.finish_reason'] !== undefined && (
                  <>
                    <dt>Finish reason</dt>
                    <dd className="mono">{String(attributes['llm.finish_reason'])}</dd>
                  </>
                )}
              </>
            )}
            {(row.kind === 'llm' || row.kind === 'run') && (
              <>
                <dt>Cost</dt>
                <dd>{formatCost(cost, cost !== undefined)}</dd>
              </>
            )}
            {row.kind === 'tool' && attributes['tool.call_id'] !== undefined && (
              <>
                <dt>Call id</dt>
                <dd className="mono">{String(attributes['tool.call_id'])}</dd>
              </>
            )}
          </dl>

          {row.kind === 'run' && row.run.id !== root.id && (
            <a className="btn btn-secondary" href={href('runs', row.run.id)}>
              <ExternalLink size={13} />
              Open this run
            </a>
          )}
          {row.kind === 'run' && <JsonBlock label="Input" value={row.run.input} />}
          {row.kind === 'run' && row.run.output && (
            <div>
              <div className="io-label">Output</div>
              <Markdown text={row.run.output} />
            </div>
          )}
          {row.kind === 'run' && row.run.error && <ErrorText>{row.run.error}</ErrorText>}

          {row.kind === 'tool' && (
            <JsonBlock
              label="Arguments"
              value={call?.arguments ?? attributes['tool.arguments'] ?? null}
            />
          )}
          {row.kind === 'tool' &&
            call?.result !== undefined &&
            !(call.error && call.result === null) && (
              <JsonBlock label="Result" value={call.result} />
            )}
          {row.kind === 'tool' && (call?.error ?? attributes['tool.error']) !== undefined && (
            <ErrorText>{String(call?.error ?? attributes['tool.error'])}</ErrorText>
          )}
          {Object.keys(rest).length > 0 && <JsonBlock label="Attributes" value={rest} />}
        </div>
      </aside>
    </>
  );
}

/** The trace of a run as a waterfall: model calls, tool calls and nested agents on one time axis. */
export function Waterfall({
  run,
  runs,
  compact = false,
}: {
  run: RunRecord;
  runs: Record<string, RunRecord>;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const live = run.status === 'running' || run.status === 'waiting';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [live]);

  const rows = runRows(run, runs, 0, now);
  const start = Math.min(...rows.map((row) => row.start));
  const end = Math.max(...rows.map((row) => row.end), start + 1);
  const total = end - start;
  const index = rows.findIndex((row) => row.key === selected);
  const chosen = rows[index];

  useEffect(() => {
    if (!chosen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(undefined);
      else if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault();
        setSelected(rows[Math.min(index + 1, rows.length - 1)]?.key);
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault();
        setSelected(rows[Math.max(index - 1, 0)]?.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chosen, index, rows]);

  return (
    <div className="wf" data-testid="waterfall">
      <div className="wf-row wf-head">
        <span>Span</span>
        <span className="wf-axis">
          <span>0</span>
          <span>{formatDuration(total / 2)}</span>
          <span>{formatDuration(total)}</span>
        </span>
        <span className="wf-num">Time</span>
        {!compact && <span className="wf-num">Tokens</span>}
        {!compact && <span className="wf-num">Cost</span>}
      </div>
      {rows.map((row) => {
        const left = ((row.start - start) / total) * 100;
        const width = Math.max(((row.end - row.start) / total) * 100, 0.5);
        const tokens = rowTokens(row);
        const cost = rowCost(row);
        const Icon =
          row.kind === 'run' && row.run.kind === 'workflow' ? Workflow : KIND_ICON[row.kind];
        return (
          <button
            type="button"
            key={row.key}
            className={`wf-row ${selected === row.key ? 'selected' : ''}`}
            onClick={() => setSelected(selected === row.key ? undefined : row.key)}
            data-testid="trace-row"
            data-kind={row.kind}
            aria-pressed={selected === row.key}
          >
            <span className="wf-label" data-kind={row.kind} title={row.label}>
              {Array.from({ length: row.depth }, (_, i) => (
                <span key={i} className="wf-guide" />
              ))}
              <Icon size={13} />
              <span className="truncate">{row.label}</span>
              {row.status === 'error' && <span className="wf-error">failed</span>}
            </span>
            <span className="wf-track">
              <span
                className="wf-bar"
                data-kind={row.kind}
                data-status={row.status}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </span>
            <span className="wf-num">{formatDuration(row.end - row.start)}</span>
            {!compact && (
              <span className="wf-num">{tokens !== undefined ? formatTokens(tokens) : ''}</span>
            )}
            {!compact && (
              <span className="wf-num">{cost !== undefined ? formatCost(cost) : ''}</span>
            )}
          </button>
        );
      })}
      {chosen && (
        <Inspector row={chosen} origin={start} root={run} onClose={() => setSelected(undefined)} />
      )}
    </div>
  );
}

/**
 * Tokens and cost of a run with every run it started. A run still going is
 * summed from the model calls it made so far.
 */
export function totals(run: RunRecord, runs: Record<string, RunRecord>) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let priced = false;
  const visit = (current: RunRecord) => {
    if (current.usage) {
      inputTokens += current.usage.inputTokens;
      outputTokens += current.usage.outputTokens;
      cost += current.usage.cost;
      priced ||= current.usage.priced !== false;
    } else {
      for (const span of current.spans) {
        if (span.kind !== 'llm') continue;
        inputTokens += span.inputTokens ?? 0;
        outputTokens += span.outputTokens ?? 0;
        cost += span.cost ?? 0;
        priced ||= span.cost !== undefined;
      }
    }
    for (const id of current.children) {
      const child = runs[id];
      if (child && (current.kind !== 'workflow' || !current.usage)) visit(child);
    }
  };
  visit(run);
  return { inputTokens, outputTokens, cost, priced };
}
