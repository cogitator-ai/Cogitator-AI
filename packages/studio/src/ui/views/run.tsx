import { useEffect, useState } from 'react';
import type { RunRecord, StepRecord, WorkflowInfo } from '../../protocol';
import { api } from '../api';
import { Empty, JsonBlock, RichText, StatusBadge } from '../components/common';
import { ToolCallCard } from '../components/tool-call';
import { totals, Waterfall } from '../components/waterfall';
import { WorkflowGraph } from '../components/workflow-graph';
import { formatCost, formatDuration, formatTokens, pretty, timeAgo } from '../format';
import { href, navigate } from '../router';
import { loadRun, useStudio } from '../store';

function Summary({ run, runs }: { run: RunRecord; runs: Record<string, RunRecord> }) {
  const sum = totals(run, runs);
  return (
    <div className="summary" data-testid="run-summary">
      <div>
        <span className="label">status</span>
        <StatusBadge status={run.status} />
      </div>
      <div>
        <span className="label">{run.kind}</span>
        <span>{run.target}</span>
      </div>
      {run.model && (
        <div>
          <span className="label">model</span>
          <span>{run.model}</span>
        </div>
      )}
      <div>
        <span className="label">tokens</span>
        <span>
          {formatTokens(sum.inputTokens)} in · {formatTokens(sum.outputTokens)} out
        </span>
      </div>
      <div>
        <span className="label">cost</span>
        <span data-testid="run-cost">{formatCost(sum.cost, sum.priced)}</span>
      </div>
      <div>
        <span className="label">duration</span>
        <span>{formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}</span>
      </div>
      <div>
        <span className="label">started</span>
        <span>{timeAgo(run.startedAt)}</span>
      </div>
      {run.threadId && run.kind === 'agent' && !run.parentRunId && (
        <div>
          <span className="label">thread</span>
          <a href={href('agents', run.target, run.threadId)}>open</a>
        </div>
      )}
      {run.parentRunId && (
        <div>
          <span className="label">started by</span>
          <a href={href('runs', run.parentRunId)}>parent run</a>
        </div>
      )}
      {run.forkOf && (
        <div>
          <span className="label">fork of</span>
          <a href={href('compare', run.forkOf.runId, run.id)}>step {run.forkOf.step}, compare</a>
        </div>
      )}
    </div>
  );
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Forks a run from one of its steps with a changed input, context or tool results. */
function ForkPanel({ run }: { run: RunRecord }) {
  const steps = run.steps ?? [];
  const resultsAt = (candidate: StepRecord | undefined) =>
    Object.fromEntries(
      (candidate?.toolCalls ?? []).map((call) => [call.name, pretty(call.result)])
    );
  const [stepIndex, setStepIndex] = useState(steps.at(-1)?.index ?? 0);
  const step: StepRecord | undefined = steps.find((candidate) => candidate.index === stepIndex);
  const [input, setInput] = useState(run.input);
  const [context, setContext] = useState('');
  const toolNames = [...new Set(run.toolCalls.map((call) => call.name))];
  const [results, setResults] = useState<Record<string, string>>(() => resultsAt(step));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pick = (candidate: StepRecord) => {
    setStepIndex(candidate.index);
    setResults(resultsAt(candidate));
  };

  if (steps.length === 0) return null;

  const fork = async () => {
    setError(undefined);
    const toolResults: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(results)) {
      if (!text.trim()) continue;
      const original = step?.toolCalls.find((call) => call.name === name);
      if (original && pretty(original.result) === text) continue;
      const parsed = parseJson(text);
      toolResults[name] = parsed.ok ? parsed.value : text;
    }
    setBusy(true);
    try {
      const started = await api.fork(run.id, {
        step: stepIndex,
        ...(input !== run.input && { input }),
        ...(context.trim() && { context: context.trim() }),
        ...(Object.keys(toolResults).length > 0 && { toolResults }),
      });
      navigate('compare', run.id, started.runId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" data-testid="fork-panel">
      <h2>Fork this run</h2>
      <p className="muted">
        Go back to a step, change what the agent saw, and run on from there. The original stays as
        it is, both are shown side by side.
      </p>
      <div className="steps">
        {steps.map((candidate) => (
          <button
            type="button"
            key={candidate.checkpointId}
            className={`step ${candidate.index === stepIndex ? 'active' : ''}`}
            onClick={() => pick(candidate)}
            data-testid={`step-${candidate.index}`}
          >
            <span className="step-index">{candidate.index}</span> {candidate.label}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Input</span>
        <textarea
          className="input"
          rows={2}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          data-testid="fork-input"
        />
      </label>
      <label className="field">
        <span>Extra context for the agent</span>
        <textarea
          className="input"
          rows={2}
          value={context}
          onChange={(event) => setContext(event.target.value)}
        />
      </label>
      {toolNames.map((name) => (
        <label className="field" key={name}>
          <span>
            Result of <code>{name}</code> from this step on
          </span>
          <textarea
            className="input mono"
            rows={3}
            value={results[name] ?? ''}
            placeholder="leave empty to run the tool"
            onChange={(event) => setResults({ ...results, [name]: event.target.value })}
            data-testid={`fork-result-${name}`}
          />
        </label>
      ))}
      <div className="row">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void fork()}
          data-testid="fork"
        >
          Fork from step {stepIndex}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}

/** Reruns a workflow run from a node, keeping what the nodes before it produced. */
function WorkflowRunPanel({ run, workflow }: { run: RunRecord; workflow?: WorkflowInfo }) {
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  if (!workflow) return <Empty>The workflow {run.target} is no longer in the registry.</Empty>;
  const node = run.nodes?.find((candidate) => candidate.name === selected);
  const finished = run.status === 'completed' || run.status === 'failed';
  const rerun = async () => {
    if (!selected) return;
    setError(undefined);
    try {
      const started = await api.rerun(run.id, selected);
      navigate('runs', started.runId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <section className="panel">
      <h2>Nodes</h2>
      <WorkflowGraph
        workflow={workflow}
        nodes={run.nodes}
        selected={selected}
        onSelect={setSelected}
      />
      {node && (
        <div className="node-detail">
          <div className="detail-title">
            {node.name} <StatusBadge status={node.status} />{' '}
            {node.duration !== undefined && (
              <span className="muted">{formatDuration(node.duration)}</span>
            )}
          </div>
          {node.output !== undefined && <JsonBlock label="output" value={node.output} />}
          {node.error && <div className="error-text">{node.error}</div>}
          {finished && run.workflowRunId && (
            <button
              type="button"
              className="button primary"
              onClick={() => void rerun()}
              data-testid="rerun"
            >
              Rerun from {node.name}
            </button>
          )}
        </div>
      )}
      {!node && (
        <p className="muted">
          Pick a node to see its output
          {finished && run.workflowRunId ? ' or rerun the workflow from it' : ''}.
        </p>
      )}
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}

/** One run: what went in and out, its trace, its tool calls, and the forks or reruns it allows. */
export function RunView({ runId }: { runId: string }) {
  const runs = useStudio((state) => state.runs);
  const host = useStudio((state) => state.host);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setError(undefined);
    loadRun(runId).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure))
    );
  }, [runId]);
  const run = runs[runId];
  if (error && !run) return <Empty>{error}</Empty>;
  if (!run) return <Empty>Loading the run…</Empty>;
  const workflow =
    host.state === 'ready'
      ? host.registry.workflows.find((candidate) => candidate.key === run.target)
      : undefined;
  const forks = run.forks
    .map((id) => runs[id])
    .filter((fork): fork is RunRecord => fork !== undefined);

  return (
    <div className="run-view" data-testid="run-view" data-status={run.status}>
      <h1>
        {run.kind === 'workflow' ? 'Workflow run' : run.kind === 'fork' ? 'Fork' : 'Run'}{' '}
        <span className="muted mono">{run.id}</span>
      </h1>
      <Summary run={run} runs={runs} />
      {run.rerunOf && (
        <div className="notice">
          Rerun of <a href={href('runs', run.rerunOf.runId)}>an earlier run</a> from the node{' '}
          {run.rerunOf.fromNode}.
        </div>
      )}
      <section className="panel">
        <h2>Input</h2>
        <pre className="io">{run.input}</pre>
        <h2>{run.status === 'running' || run.status === 'waiting' ? 'Output so far' : 'Output'}</h2>
        {run.output ? (
          run.kind === 'workflow' ? (
            <pre className="io">{run.output}</pre>
          ) : (
            <RichText text={run.output} />
          )
        ) : (
          <p className="muted">none yet</p>
        )}
        {run.error && <div className="error-text">{run.error}</div>}
      </section>
      {run.kind === 'workflow' && <WorkflowRunPanel run={run} workflow={workflow} />}
      <section className="panel">
        <h2>Trace</h2>
        <Waterfall run={run} runs={runs} />
      </section>
      {run.toolCalls.length > 0 && (
        <section className="panel">
          <h2>Tool calls</h2>
          {run.toolCalls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </section>
      )}
      {forks.length > 0 && (
        <section className="panel">
          <h2>Forks</h2>
          {forks.map((fork) => (
            <a
              key={fork.id}
              className="list-row"
              href={href('compare', run.id, fork.id)}
              data-testid="fork-link"
            >
              <StatusBadge status={fork.status} />
              <span>step {fork.forkOf?.step}</span>
              <span className="muted">{timeAgo(fork.startedAt)}</span>
            </a>
          ))}
        </section>
      )}
      {run.kind !== 'workflow' && run.status === 'completed' && !run.parentRunId && (
        <ForkPanel run={run} />
      )}
    </div>
  );
}
