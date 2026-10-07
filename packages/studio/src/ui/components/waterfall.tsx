import { useState } from 'react';
import type { RunRecord, SpanRecord } from '../../protocol';
import { formatCost, formatDuration, formatTokens } from '../format';
import { navigate } from '../router';
import { JsonBlock } from './common';

interface Row {
  key: string;
  depth: number;
  label: string;
  kind: SpanRecord['kind'] | 'run';
  start: number;
  end: number;
  status: 'ok' | 'error' | 'unset' | 'running';
  span?: SpanRecord;
  run?: RunRecord;
}

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
    label: run.kind === 'workflow' ? `workflow ${run.target}` : `${run.agentName ?? run.target}`,
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
      label:
        span.kind === 'llm'
          ? `model ${span.model ?? ''}`.trim()
          : span.name.replace(/^tool\./, 'tool '),
      kind: span.kind,
      start: span.startTime,
      end: span.endTime,
      status: span.status,
      span,
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

/** The trace of a run as a waterfall: model calls, tool calls and nested agents on one time axis. */
export function Waterfall({ run, runs }: { run: RunRecord; runs: Record<string, RunRecord> }) {
  const [selected, setSelected] = useState<string>();
  const rows = runRows(run, runs, 0, Date.now());
  const start = Math.min(...rows.map((row) => row.start));
  const end = Math.max(...rows.map((row) => row.end), start + 1);
  const total = end - start;
  const chosen = rows.find((row) => row.key === selected);

  return (
    <div className="waterfall" data-testid="waterfall">
      <div className="waterfall-axis">
        <span>0</span>
        <span>{formatDuration(total / 2)}</span>
        <span>{formatDuration(total)}</span>
      </div>
      {rows.map((row) => {
        const left = ((row.start - start) / total) * 100;
        const width = Math.max(((row.end - row.start) / total) * 100, 0.6);
        const tokens =
          row.span?.kind === 'llm'
            ? (row.span.inputTokens ?? 0) + (row.span.outputTokens ?? 0)
            : undefined;
        const cost =
          row.kind === 'run'
            ? row.run?.usage?.priced === false
              ? undefined
              : row.run?.usage?.cost
            : row.span?.cost;
        return (
          <button
            type="button"
            key={row.key}
            className={`waterfall-row ${selected === row.key ? 'selected' : ''}`}
            onClick={() => setSelected(selected === row.key ? undefined : row.key)}
            data-kind={row.kind}
          >
            <span
              className="waterfall-label"
              style={{ paddingLeft: `${row.depth * 14}px` }}
              title={row.label}
            >
              {row.label}
            </span>
            <span className="waterfall-track">
              <span
                className={`waterfall-bar bar-${row.kind} bar-${row.status}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </span>
            <span className="waterfall-num">{formatDuration(row.end - row.start)}</span>
            <span className="waterfall-num">
              {tokens !== undefined ? formatTokens(tokens) : ''}
            </span>
            <span className="waterfall-num">{cost !== undefined ? formatCost(cost) : ''}</span>
          </button>
        );
      })}
      {chosen && (
        <div className="waterfall-detail">
          <div className="detail-title">
            {chosen.label}
            {chosen.run && chosen.run.id !== run.id && (
              <button
                type="button"
                className="link"
                onClick={() => navigate('runs', chosen.run!.id)}
              >
                open this run
              </button>
            )}
          </div>
          {chosen.span?.kind === 'llm' && (
            <div className="detail-grid">
              <span>model</span>
              <span>{chosen.span.model}</span>
              <span>input tokens</span>
              <span>{chosen.span.inputTokens}</span>
              <span>output tokens</span>
              <span>{chosen.span.outputTokens}</span>
              <span>cost</span>
              <span>{formatCost(chosen.span.cost)}</span>
            </div>
          )}
          {chosen.run && chosen.kind === 'run' && (
            <div className="detail-grid">
              <span>input</span>
              <span>{chosen.run.input}</span>
              <span>output</span>
              <span>{chosen.run.output ?? chosen.run.error ?? ''}</span>
            </div>
          )}
          {chosen.span && <JsonBlock label="attributes" value={chosen.span.attributes} />}
        </div>
      )}
    </div>
  );
}

/** Tokens and cost of a run with every run it started. */
export function totals(run: RunRecord, runs: Record<string, RunRecord>) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let priced = false;
  const visit = (current: RunRecord) => {
    inputTokens += current.usage?.inputTokens ?? 0;
    outputTokens += current.usage?.outputTokens ?? 0;
    cost += current.usage?.cost ?? 0;
    priced = priced || current.usage?.priced !== false;
    for (const id of current.children) {
      const child = runs[id];
      if (child && current.kind !== 'workflow') visit(child);
    }
  };
  visit(run);
  return { inputTokens, outputTokens, cost, priced };
}
