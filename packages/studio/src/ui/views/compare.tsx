import { useEffect } from 'react';
import type { RunRecord } from '../../protocol';
import { Empty, JsonBlock, RichText, StatusBadge } from '../components/common';
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
  changed: Set<string>;
}) {
  const sum = totals(run, runs);
  return (
    <div className="compare-column" data-testid={`compare-${title.toLowerCase()}`}>
      <div className="compare-head">
        <h2>
          <a href={href('runs', run.id)}>{title}</a>
        </h2>
        <StatusBadge status={run.status} />
        <span className="muted">
          {formatCost(sum.cost, sum.priced)} ·{' '}
          {formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}
        </span>
      </div>
      <h3>Input</h3>
      <pre className="io">{run.input}</pre>
      <h3>Tool calls</h3>
      {run.toolCalls.length === 0 && <p className="muted">none</p>}
      {run.toolCalls.map((call, index) => (
        <div key={call.id} className={`compare-call ${changed.has(`${index}`) ? 'diverged' : ''}`}>
          <div className="tool-head">
            <span className="tool-name">{call.name}</span>
          </div>
          <JsonBlock label="result" value={call.result ?? call.error ?? null} />
        </div>
      ))}
      <h3>Output</h3>
      <div data-testid="compare-output">
        {run.output ? (
          <RichText text={run.output} />
        ) : (
          <p className="muted">{run.error ?? 'none yet'}</p>
        )}
      </div>
      <h3>Trace</h3>
      <Waterfall run={run} runs={runs} />
    </div>
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
  if (!original || !fork) return <Empty>Loading both runs…</Empty>;

  const changed = new Set<string>();
  const length = Math.max(original.toolCalls.length, fork.toolCalls.length);
  for (let i = 0; i < length; i++) {
    const a = original.toolCalls[i];
    const b = fork.toolCalls[i];
    if (a?.name !== b?.name || !a || !b || pretty(a.result) !== pretty(b.result))
      changed.add(`${i}`);
  }
  const origin = fork.forkOf;

  return (
    <div className="compare-view" data-testid="compare-view">
      <h1>Fork at step {origin?.step ?? '?'}</h1>
      {origin && (
        <div className="notice">
          Changed:{' '}
          {[
            origin.input !== undefined && 'the input',
            origin.context !== undefined && 'the context',
            origin.toolResults && `the results of ${Object.keys(origin.toolResults).join(', ')}`,
          ]
            .filter(Boolean)
            .join(', ') || 'nothing, a plain rerun'}
          . Highlighted tool calls differ between the branches.
        </div>
      )}
      <div className="compare">
        <Column run={original} title="Original" runs={runs} changed={changed} />
        <Column run={fork} title="Fork" runs={runs} changed={changed} />
      </div>
    </div>
  );
}
