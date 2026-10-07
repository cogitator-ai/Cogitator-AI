import { useEffect, useState } from 'react';
import type { RunRecord } from '../../protocol';
import { api } from '../api';
import { Empty, StatusBadge } from '../components/common';
import { WorkflowGraph } from '../components/workflow-graph';
import { formatDuration, pretty, timeAgo } from '../format';
import { href, navigate } from '../router';
import { loadRuns, useStudio } from '../store';

/** A workflow of the registry: its graph, a form to run it, and its runs. */
export function WorkflowView({ workflowKey }: { workflowKey: string }) {
  const host = useStudio((state) => state.host);
  const runs = useStudio((state) => state.runs);
  const workflow =
    host.state === 'ready'
      ? host.registry.workflows.find((candidate) => candidate.key === workflowKey)
      : undefined;
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (workflow) setInput(pretty(workflow.initialState ?? {}));
  }, [workflow?.key]);

  useEffect(() => {
    void loadRuns({ target: workflowKey, kind: 'workflow' }).catch(() => undefined);
  }, [workflowKey]);

  if (host.state !== 'ready') return <Empty>The project is not loaded yet.</Empty>;
  if (!workflow) return <Empty>There is no workflow {workflowKey} in the registry.</Empty>;

  const history = Object.values(runs)
    .filter((run): run is RunRecord => run.kind === 'workflow' && run.target === workflowKey)
    .sort((a, b) => b.startedAt - a.startedAt);
  const latest = history[0];

  const start = async () => {
    setError(undefined);
    let parsed: unknown;
    try {
      parsed = input.trim() ? (JSON.parse(input) as unknown) : {};
    } catch (failure) {
      setError(
        `The input is not JSON: ${failure instanceof Error ? failure.message : String(failure)}`
      );
      return;
    }
    try {
      const started = await api.runWorkflow(workflowKey, parsed);
      navigate('runs', started.runId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="workflow-view">
      <h1>{workflow.name}</h1>
      <section className="panel">
        <h2>Graph{latest ? ', latest run' : ''}</h2>
        <WorkflowGraph workflow={workflow} nodes={latest?.nodes} />
      </section>
      <section className="panel">
        <h2>Run it</h2>
        <label className="field">
          <span>Input state (JSON)</span>
          <textarea
            className="input mono"
            rows={6}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            data-testid="workflow-input"
          />
        </label>
        <button
          type="button"
          className="button primary"
          onClick={() => void start()}
          data-testid="run-workflow"
        >
          Run {workflow.name}
        </button>
        {error && <div className="error-text">{error}</div>}
      </section>
      <section className="panel">
        <h2>Runs</h2>
        {history.length === 0 && <p className="muted">No runs yet.</p>}
        {history.map((run) => (
          <a key={run.id} className="list-row" href={href('runs', run.id)}>
            <StatusBadge status={run.status} />
            <span>{run.rerunOf ? `rerun from ${run.rerunOf.fromNode}` : 'run'}</span>
            <span className="muted">
              {formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}
            </span>
            <span className="muted">{timeAgo(run.startedAt)}</span>
          </a>
        ))}
      </section>
    </div>
  );
}
