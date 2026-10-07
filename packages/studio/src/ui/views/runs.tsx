import { useEffect, useState } from 'react';
import { Activity, Search } from 'lucide-react';
import type { RunRecord } from '../../protocol';
import { api } from '../api';
import { Empty, ErrorText, Kbd, messageOf, Topbar } from '../components/common';
import { RunTable } from '../components/run-table';
import { usePageKey } from '../hotkeys';
import { navigate } from '../router';
import { useStudio } from '../store';

const KINDS = [
  { value: '', label: 'All' },
  { value: 'agent', label: 'Chats' },
  { value: 'workflow', label: 'Workflows' },
  { value: 'fork', label: 'Forks' },
] as const;

/** Every run of the project, searchable and filtered by agent, workflow or kind. */
export function RunsView() {
  const host = useStudio((state) => state.host);
  const live = useStudio((state) => state.runs);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState('');
  const [found, setFound] = useState<RunRecord[]>();
  const [error, setError] = useState<string>();
  const [focused, setFocused] = useState(-1);
  const liveCount = Object.keys(live).length;

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      api
        .runs({ q, target, kind })
        .then((response) => {
          if (!current) return;
          setFound(response.runs);
          setError(undefined);
        })
        .catch((failure: unknown) => current && setError(messageOf(failure)));
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, target, kind, liveCount]);

  useEffect(() => setFocused(-1), [q, target, kind]);

  const targets =
    host.state === 'ready'
      ? [
          ...host.registry.agents.map((agent) => agent.key),
          ...host.registry.workflows.map((workflow) => workflow.key),
        ]
      : [];
  const rows = (found ?? []).map((run) => live[run.id] ?? run);

  usePageKey(['j', 'k', 'ArrowDown', 'ArrowUp', 'Enter'], (event) => {
    if (event.key === 'Enter') {
      const run = rows[focused];
      if (run) navigate('runs', run.id);
      return;
    }
    const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1;
    const next = Math.min(Math.max(focused + step, 0), rows.length - 1);
    setFocused(next);
    document.querySelector(`.tr[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <>
      <Topbar crumbs={[{ label: 'Runs' }]} />
      <div className="scroll">
        <div className="page">
          <div className="page-head">
            <div>
              <h1 className="page-title">Runs</h1>
              <div className="page-sub">
                Every chat, workflow run and fork, with its trace and cost.
              </div>
            </div>
          </div>
          <div className="toolbar">
            <label className="input-icon">
              <Search size={14} />
              <input
                className="input"
                placeholder="Search inputs, outputs and errors"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                onKeyDown={(event) => event.key === 'Escape' && event.currentTarget.blur()}
                aria-label="Search runs"
                data-testid="search"
                data-search
              />
              <Kbd keys={['/']} />
            </label>
            <div className="seg" role="group" aria-label="Kind">
              {KINDS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={kind === option.value}
                  onClick={() => setKind(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <select
              className="input select"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              aria-label="Agent or workflow"
              data-testid="filter-target"
            >
              <option value="">Every agent and workflow</option>
              {targets.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          {!found && !error && <div className="skeleton" style={{ height: 240 }} />}
          {found && rows.length === 0 && (
            <div className="panel">
              <Empty icon={Activity} title={q || target || kind ? 'No runs match' : 'No runs yet'}>
                {q || target || kind
                  ? 'Try other words or clear the filters.'
                  : 'Chat with an agent or run a workflow to see it here.'}
              </Empty>
            </div>
          )}
          {rows.length > 0 && <RunTable runs={rows} focused={focused} />}
        </div>
      </div>
    </>
  );
}
