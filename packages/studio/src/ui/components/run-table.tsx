import { Activity, GitFork, Workflow } from 'lucide-react';
import type { RunRecord } from '../../protocol';
import { excerpt, formatCost, formatDuration, formatTokens, timeAgo } from '../format';
import { href } from '../router';
import { StatusBadge } from './common';

const KIND_ICON = { agent: Activity, workflow: Workflow, fork: GitFork } as const;

/** Runs as rows: status, what ran, its input, tokens, cost, duration and when. */
export function RunTable({ runs, focused }: { runs: RunRecord[]; focused?: number }) {
  return (
    <div className="table" role="table" aria-label="Runs">
      <div className="tr thead" role="row">
        <span role="columnheader">Status</span>
        <span role="columnheader">Target</span>
        <span role="columnheader">Input</span>
        <span role="columnheader" className="td-right">
          Tokens
        </span>
        <span role="columnheader" className="td-right">
          Cost
        </span>
        <span role="columnheader" className="td-right">
          Duration
        </span>
        <span role="columnheader" className="td-right">
          Started
        </span>
      </div>
      {runs.map((run, index) => {
        const Icon = KIND_ICON[run.kind];
        const tokens = run.usage ? run.usage.inputTokens + run.usage.outputTokens : undefined;
        return (
          <a
            key={run.id}
            className={`tr ${focused === index ? 'focused' : ''}`}
            href={href('runs', run.id)}
            role="row"
            data-testid="run-row"
            data-index={index}
          >
            <span role="cell">
              <StatusBadge status={run.status} />
            </span>
            <span role="cell" className="td-target">
              <Icon size={14} />
              <span className="truncate">
                {run.kind === 'fork' ? `fork of ${run.target}` : run.target}
              </span>
            </span>
            <span role="cell" className="truncate subtle">
              {excerpt(run.input, 140)}
            </span>
            <span role="cell" className="td-right muted">
              {tokens !== undefined ? formatTokens(tokens) : ''}
            </span>
            <span role="cell" className="td-right muted">
              {run.usage ? formatCost(run.usage.cost, run.usage.priced !== false) : ''}
            </span>
            <span role="cell" className="td-right muted">
              {formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}
            </span>
            <span role="cell" className="td-right muted">
              {timeAgo(run.startedAt)}
            </span>
          </a>
        );
      })}
    </div>
  );
}
