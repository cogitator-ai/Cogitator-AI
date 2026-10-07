import { useEffect, useState } from 'react';
import { Activity, Play, Workflow } from 'lucide-react';
import type { RunRecord } from '../../protocol';
import { api } from '../api';
import { Empty, ErrorText, Kbd, messageOf, StatusBadge, Topbar } from '../components/common';
import { WorkflowGraph } from '../components/workflow-graph';
import { formatDuration, pretty, timeAgo } from '../format';
import { MOD } from '../hotkeys';
import { href, navigate } from '../router';
import { loadRuns, useStudio } from '../store';

function jsonError(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch (failure) {
    return messageOf(failure);
  }
}

/** A workflow of the registry: its graph with the latest run, a form to run it, and its runs. */
export function WorkflowView({ workflowKey }: { workflowKey: string }) {
  const host = useStudio((state) => state.host);
  const runs = useStudio((state) => state.runs);
  const workflow =
    host.state === 'ready'
      ? host.registry.workflows.find((candidate) => candidate.key === workflowKey)
      : undefined;
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (workflow) setInput(pretty(workflow.initialState ?? {}));
  }, [workflow?.key]);

  useEffect(() => {
    void loadRuns({ target: workflowKey, kind: 'workflow' }).catch(() => undefined);
  }, [workflowKey]);

  const crumbs = [{ label: workflow?.name ?? workflowKey }];
  if (host.state !== 'ready')
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={Workflow} title="Waiting for the project" />
        </div>
      </>
    );
  if (!workflow)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={Workflow} title={`No workflow ${workflowKey}`}>
            It is not in the registry of this project anymore.
          </Empty>
        </div>
      </>
    );

  const history = Object.values(runs)
    .filter((run): run is RunRecord => run.kind === 'workflow' && run.target === workflowKey)
    .sort((a, b) => b.startedAt - a.startedAt);
  const latest = history[0];
  const invalid = jsonError(input);

  const start = async () => {
    if (invalid || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      const started = await api.runWorkflow(
        workflowKey,
        input.trim() ? (JSON.parse(input) as unknown) : {}
      );
      navigate('runs', started.runId);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={Boolean(invalid) || busy}
            onClick={() => void start()}
          >
            <Play size={12} fill="currentColor" />
            Run
          </button>
        }
      />
      <div className="scroll">
        <div className="page">
          <div className="page-head">
            <div>
              <h1 className="page-title">{workflow.name}</h1>
              <div className="page-sub">
                {workflow.nodes.length} nodes, starts at <code>{workflow.entryPoint}</code>
              </div>
            </div>
          </div>
          <div className="workflow-layout">
            <section className="panel">
              <div className="panel-head">
                <div className="panel-title">
                  <Workflow size={14} />
                  Graph
                </div>
                {latest && (
                  <a className="link" href={href('runs', latest.id)}>
                    Latest run, {timeAgo(latest.startedAt)}
                  </a>
                )}
              </div>
              <div className="canvas" style={{ minHeight: 220 }}>
                <WorkflowGraph workflow={workflow} nodes={latest?.nodes} />
              </div>
            </section>
            <div className="side-stack">
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title">
                    <Play size={14} />
                    Run it
                  </div>
                  <Kbd keys={[MOD, 'Enter']} />
                </div>
                <div className="panel-body">
                  <label className="field">
                    <span>Input state (JSON)</span>
                    <textarea
                      className="input mono"
                      rows={8}
                      value={input}
                      spellCheck={false}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void start();
                        }
                      }}
                      aria-invalid={Boolean(invalid)}
                      data-testid="workflow-input"
                    />
                  </label>
                  {invalid && <ErrorText>Not JSON yet: {invalid}</ErrorText>}
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ width: '100%', marginTop: invalid ? 12 : 0 }}
                    disabled={Boolean(invalid) || busy}
                    onClick={() => void start()}
                    data-testid="run-workflow"
                  >
                    {busy ? <span className="spinner" /> : <Play size={12} fill="currentColor" />}
                    Run {workflow.name}
                  </button>
                  {error && <ErrorText>{error}</ErrorText>}
                </div>
              </section>
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title">
                    <Activity size={14} />
                    Runs <span className="count">{history.length}</span>
                  </div>
                </div>
                {history.length === 0 && (
                  <div className="panel-body muted">No runs yet. Run it to see each node work.</div>
                )}
                {history.slice(0, 12).map((run) => (
                  <a key={run.id} className="list-row" href={href('runs', run.id)}>
                    <StatusBadge status={run.status} />
                    <span className="grow truncate">
                      {run.rerunOf ? `Rerun from ${run.rerunOf.fromNode}` : 'Run'}
                    </span>
                    <span className="muted num">
                      {formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}
                    </span>
                    <span className="muted">{timeAgo(run.startedAt)}</span>
                  </a>
                ))}
                {history.length > 12 && (
                  <a className="list-row link" href={href('runs')}>
                    All {history.length} runs
                  </a>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
