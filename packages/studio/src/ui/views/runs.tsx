import { useEffect, useState } from 'react';
import type { RunRecord } from '../../protocol';
import { api } from '../api';
import { Empty, StatusBadge } from '../components/common';
import { excerpt, formatCost, formatDuration, timeAgo } from '../format';
import { href } from '../router';
import { useStudio } from '../store';

/** Every run of the project, searchable and filtered by agent or workflow. */
export function RunsView() {
  const host = useStudio((state) => state.host);
  const live = useStudio((state) => state.runs);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState('');
  const [found, setFound] = useState<RunRecord[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .runs({ q, target, kind })
        .then((response) => {
          setFound(response.runs);
          setError(undefined);
        })
        .catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure))
        );
    }, 150);
    return () => clearTimeout(timer);
  }, [q, target, kind]);

  const targets =
    host.state === 'ready'
      ? [
          ...host.registry.agents.map((agent) => agent.key),
          ...host.registry.workflows.map((workflow) => workflow.key),
        ]
      : [];
  const rows = (found ?? []).map((run) => live[run.id] ?? run);

  return (
    <div className="runs-view">
      <h1>Runs</h1>
      <div className="filters">
        <input
          className="input"
          placeholder="Search inputs, outputs and errors"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          data-testid="search"
        />
        <select
          className="input"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          data-testid="filter-target"
        >
          <option value="">every agent and workflow</option>
          {targets.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select className="input" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">every kind</option>
          <option value="agent">chats</option>
          <option value="workflow">workflows</option>
          <option value="fork">forks</option>
        </select>
      </div>
      {error && <div className="error-text">{error}</div>}
      {found && rows.length === 0 && <Empty>No runs match.</Empty>}
      <div className="list">
        {rows.map((run) => (
          <a
            key={run.id}
            className="list-row run-row"
            href={href('runs', run.id)}
            data-testid="run-row"
          >
            <StatusBadge status={run.status} />
            <span className="run-target">
              {run.kind === 'fork' ? 'fork of ' : ''}
              {run.target}
            </span>
            <span className="run-input">{excerpt(run.input)}</span>
            <span className="muted">
              {run.usage ? formatCost(run.usage.cost, run.usage.priced !== false) : ''}
            </span>
            <span className="muted">
              {formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}
            </span>
            <span className="muted">{timeAgo(run.startedAt)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
