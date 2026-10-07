import { useEffect } from 'react';
import { GitCompareArrows, GitFork, TriangleAlert } from 'lucide-react';
import type { RunRecord } from '../../protocol';
import { Empty, JsonBlock, StatusBadge, Topbar } from '../components/common';
import { Markdown } from '../components/markdown';
import { totals, Waterfall } from '../components/waterfall';
import { formatCost, formatDuration, pretty } from '../format';
import { href } from '../router';
import { loadRun, useStudio } from '../store';

function Column({
  run,
  title,
  runs,
  changed,
}: {
  run: RunRecord;
  title: string;
  runs: Record<string, RunRecord>;
  changed: Set<number>;
}) {
  const sum = totals(run, runs);
  return (
    <section className="panel" data-testid={`compare-${title.toLowerCase()}`}>
      <div className="panel-head">
        <div className="panel-title">
          <a href={href('runs', run.id)}>{title}</a>
          <StatusBadge status={run.status} />
        </div>
        <span className="muted num">
          {formatCost(sum.cost, sum.priced)} ·{' '}
          {formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}
        </span>
      </div>
      <div className="compare-section">
        <h3>Input</h3>
        <div className="io-input">{run.input}</div>
      </div>
      <div className="compare-section">
        <h3>Tool calls</h3>
        {run.toolCalls.length === 0 && <span className="muted">None</span>}
        {run.toolCalls.map((call, index) => (
          <div key={call.id} className={`compare-call ${changed.has(index) ? 'diverged' : ''}`}>
            <span className="tool-name">
              {changed.has(index) && <TriangleAlert size={12} color="var(--warn)" />}
              {call.name}
            </span>
            <JsonBlock label="Result" value={call.result ?? call.error ?? null} />
          </div>
        ))}
      </div>
      <div className="compare-section">
        <h3>Output</h3>
        <div data-testid="compare-output">
          {run.output ? (
            <Markdown text={run.output} />
          ) : (
            <span className="muted">{run.error ?? 'None yet'}</span>
          )}
        </div>
      </div>
      <div className="compare-section" style={{ padding: '14px 0 8px' }}>
        <h3 style={{ padding: '0 16px' }}>Trace</h3>
        <Waterfall run={run} runs={runs} compact />
      </div>
    </section>
  );
}

/** A run and one of its forks side by side, with where they went apart. */
export function CompareView({ originalId, forkId }: { originalId: string; forkId: string }) {
  const runs = useStudio((state) => state.runs);
  useEffect(() => {
    void loadRun(originalId).catch(() => undefined);
    void loadRun(forkId).catch(() => undefined);
  }, [originalId, forkId]);
  const original = runs[originalId];
  const fork = runs[forkId];
  const crumbs = [
    { label: 'Runs', to: ['runs'] },
    ...(original ? [{ label: original.target, to: ['runs', original.id] }] : []),
    { label: 'Compare' },
  ];
  if (!original || !fork)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={GitCompareArrows} title="Loading both runs" />
        </div>
      </>
    );

  const changed = new Set<number>();
  const length = Math.max(original.toolCalls.length, fork.toolCalls.length);
  for (let i = 0; i < length; i++) {
    const a = original.toolCalls[i];
    const b = fork.toolCalls[i];
    if (a?.name !== b?.name || pretty(a?.result) !== pretty(b?.result)) changed.add(i);
  }
  const origin = fork.forkOf;
  const edits = [
    origin?.input !== undefined && 'Input',
    origin?.context !== undefined && 'Context',
    ...Object.keys(origin?.toolResults ?? {}).map((name) => `Result of ${name}`),
  ].filter((edit): edit is string => Boolean(edit));

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="scroll">
        <div className="page" style={{ maxWidth: 1400 }} data-testid="compare-view">
          <div className="page-head">
            <div>
              <h1 className="page-title">Fork at step {origin?.step ?? '?'}</h1>
              <div className="page-sub">
                {changed.size === 0
                  ? 'Both branches made the same tool calls.'
                  : `${changed.size} tool call${changed.size === 1 ? '' : 's'} differ between the branches, highlighted below.`}
              </div>
            </div>
          </div>
          <div className="diff-chips">
            {edits.length === 0 ? (
              <span className="chip">
                <GitFork size={11} />
                Nothing changed, a plain rerun
              </span>
            ) : (
              edits.map((edit) => (
                <span key={edit} className="chip">
                  <GitFork size={11} />
                  {edit}
                </span>
              ))
            )}
          </div>
          <div className="compare">
            <Column run={original} title="Original" runs={runs} changed={changed} />
            <Column run={fork} title="Fork" runs={runs} changed={changed} />
          </div>
        </div>
      </div>
    </>
  );
}
