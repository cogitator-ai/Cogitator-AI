import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  GitFork,
  MessageSquare,
  RotateCcw,
  SquareTerminal,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { RunRecord, StepRecord, WorkflowInfo } from '../../protocol';
import { api } from '../api';
import { CopyButton, Empty, ErrorText, messageOf, StatusBadge, Topbar } from '../components/common';
import { Markdown } from '../components/markdown';
import { StateView } from '../components/state-view';
import { ToolCallCard } from '../components/tool-call';
import { totals, Waterfall } from '../components/waterfall';
import { WorkflowGraph } from '../components/workflow-graph';
import { formatCost, formatDuration, formatTime, formatTokens, pretty, timeAgo } from '../format';
import { href, navigate } from '../router';
import { loadRun, useStudio } from '../store';

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </div>
  );
}

function Properties({ run, runs }: { run: RunRecord; runs: Record<string, RunRecord> }) {
  const sum = totals(run, runs);
  const tokens = sum.inputTokens + sum.outputTokens;
  const live = run.status === 'running' || run.status === 'waiting';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [live]);
  return (
    <aside className="props" data-testid="run-summary" aria-label="Run properties">
      <Prop label="Status">
        <StatusBadge status={run.status} />
      </Prop>
      <Prop label={run.kind === 'workflow' ? 'Workflow' : 'Agent'}>
        <a
          href={
            run.kind === 'workflow' ? href('workflows', run.target) : href('agents', run.target)
          }
        >
          {run.target}
        </a>
      </Prop>
      {run.model && (
        <Prop label="Model">
          <span className="mono truncate">{run.model}</span>
        </Prop>
      )}
      <Prop label="Started">
        <span data-tip={formatTime(run.startedAt)}>{timeAgo(run.startedAt)}</span>
      </Prop>
      <Prop label="Duration">{formatDuration((run.endedAt ?? now) - run.startedAt)}</Prop>
      <Prop label="Cost">
        <span data-testid="run-cost">{formatCost(sum.cost, sum.priced)}</span>
      </Prop>
      <Prop label="Tokens">
        {formatTokens(sum.inputTokens)} in · {formatTokens(sum.outputTokens)} out
      </Prop>
      {tokens > 0 && (
        <div className="token-bar" aria-hidden="true">
          <span style={{ width: `${(sum.inputTokens / tokens) * 100}%` }} />
          <span style={{ width: `${(sum.outputTokens / tokens) * 100}%` }} />
        </div>
      )}
      {(run.threadId || run.parentRunId || run.forkOf || run.rerunOf) && (
        <div className="props-sep" />
      )}
      {run.threadId && run.kind === 'agent' && !run.parentRunId && (
        <Prop label="Thread">
          <a href={href('agents', run.target, run.threadId)}>Open the chat</a>
        </Prop>
      )}
      {run.parentRunId && (
        <Prop label="Started by">
          <a href={href('runs', run.parentRunId)}>Parent run</a>
        </Prop>
      )}
      {run.forkOf && (
        <Prop label="Fork of">
          <a href={href('compare', run.forkOf.runId, run.id)}>Step {run.forkOf.step}, compare</a>
        </Prop>
      )}
      {run.rerunOf && (
        <Prop label="Rerun of">
          <a href={href('runs', run.rerunOf.runId)}>From {run.rerunOf.fromNode}</a>
        </Prop>
      )}
      <div className="props-sep" />
      <Prop label="Run id">
        <span className="mono truncate muted">{run.id}</span>
        <CopyButton value={run.id} label="Copy run id" />
      </Prop>
    </aside>
  );
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** A workflow's final state as JSON when it parses, the text otherwise. */
function outputValue(output: string): unknown {
  const parsed = parseJson(output);
  return parsed.ok ? parsed.value : output;
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
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" id="fork" data-testid="fork-panel">
      <div className="panel-head">
        <div className="panel-title">
          <GitFork size={14} />
          Fork from a step
        </div>
      </div>
      <div className="panel-body">
        <p className="panel-desc">
          Go back to a step, change what the agent saw, and run on from there. The original stays as
          it is, and both are shown side by side.
        </p>
        <div className="steps" role="radiogroup" aria-label="Step">
          {steps.map((candidate) => (
            <button
              type="button"
              key={candidate.checkpointId}
              className={`step ${candidate.index === stepIndex ? 'active' : ''}`}
              onClick={() => pick(candidate)}
              role="radio"
              aria-checked={candidate.index === stepIndex}
              data-testid={`step-${candidate.index}`}
            >
              <span className="step-index">{candidate.index}</span>
              {candidate.label}
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
            placeholder="Anything the agent should know from this step on"
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
              placeholder="Leave empty to run the tool"
              onChange={(event) => setResults({ ...results, [name]: event.target.value })}
              data-testid={`fork-result-${name}`}
            />
          </label>
        ))}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void fork()}
          data-testid="fork"
        >
          {busy ? <span className="spinner" /> : <GitFork size={14} />}
          Fork from step {stepIndex}
        </button>
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </section>
  );
}

/** Reruns a workflow run from a node, keeping what the nodes before it produced. */
function WorkflowRunPanel({ run, workflow }: { run: RunRecord; workflow?: WorkflowInfo }) {
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  if (!workflow)
    return (
      <section className="panel">
        <Empty icon={Workflow} title={`No workflow ${run.target}`}>
          It is no longer in the registry, so its graph cannot be drawn.
        </Empty>
      </section>
    );
  const node = run.nodes?.find((candidate) => candidate.name === selected);
  const finished = run.status === 'completed' || run.status === 'failed';
  const rerun = async () => {
    if (!selected) return;
    setError(undefined);
    try {
      const started = await api.rerun(run.id, selected);
      navigate('runs', started.runId);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <Workflow size={14} />
          Nodes
        </div>
        <span className="muted">
          {selected
            ? ''
            : finished && run.workflowRunId
              ? 'Pick a node to read it or rerun from it'
              : 'Pick a node to read it'}
        </span>
      </div>
      <div className="canvas">
        <WorkflowGraph
          workflow={workflow}
          nodes={run.nodes}
          selected={selected}
          onSelect={(name) => setSelected(selected === name ? undefined : name)}
        />
      </div>
      {node && (
        <div className="node-detail">
          <div className="node-detail-head">
            <strong>{node.name}</strong>
            <StatusBadge status={node.status} />
            {node.duration !== undefined && (
              <span className="muted">{formatDuration(node.duration)}</span>
            )}
            <span style={{ flex: 1 }} />
            {finished && run.workflowRunId && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void rerun()}
                data-testid="rerun"
              >
                <RotateCcw size={13} />
                Rerun from {node.name}
              </button>
            )}
          </div>
          {node.output !== undefined && <StateView label="Output" value={node.output} />}
          {node.error && <ErrorText>{node.error}</ErrorText>}
          {node.output === undefined && !node.error && (
            <span className="muted">This node has no output in this run.</span>
          )}
        </div>
      )}
      {error && (
        <div style={{ padding: '0 16px 16px' }}>
          <ErrorText>{error}</ErrorText>
        </div>
      )}
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
    loadRun(runId).catch((failure: unknown) => setError(messageOf(failure)));
  }, [runId]);
  const run = runs[runId];
  const crumbs = [{ label: 'Runs', to: ['runs'] }];

  if (!run)
    return (
      <>
        <Topbar crumbs={[...crumbs, { label: runId }]} />
        <div className="scroll">
          {error ? (
            <Empty icon={Activity} title="Run not found">
              {error}
            </Empty>
          ) : (
            <div className="page">
              <div className="skeleton" style={{ height: 28, width: 240, marginBottom: 24 }} />
              <div className="skeleton" style={{ height: 320 }} />
            </div>
          )}
        </div>
      </>
    );

  const workflow =
    host.state === 'ready'
      ? host.registry.workflows.find((candidate) => candidate.key === run.target)
      : undefined;
  const forks = run.forks
    .map((id) => runs[id])
    .filter((fork): fork is RunRecord => fork !== undefined);
  const forkable =
    run.kind !== 'workflow' &&
    run.status === 'completed' &&
    !run.parentRunId &&
    (run.steps?.length ?? 0) > 0;
  const live = run.status === 'running' || run.status === 'waiting';
  const title =
    run.kind === 'workflow' ? 'Workflow run' : run.kind === 'fork' ? 'Fork' : 'Agent run';

  return (
    <>
      <Topbar
        crumbs={[...crumbs, { label: `${run.target} · ${run.id.slice(-8)}` }]}
        actions={
          <>
            {live && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void api.stop(run.id)}
              >
                Stop
              </button>
            )}
            {run.threadId && run.kind === 'agent' && !run.parentRunId && (
              <a
                className="btn btn-secondary btn-sm"
                href={href('agents', run.target, run.threadId)}
              >
                <MessageSquare size={13} />
                Chat
              </a>
            )}
            {forkable && (
              <a
                className="btn btn-secondary btn-sm"
                href="#fork"
                onClick={(event) => {
                  event.preventDefault();
                  document
                    .getElementById('fork')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                <GitFork size={13} />
                Fork
              </a>
            )}
          </>
        }
      />
      <div className="scroll">
        <div className="page" data-testid="run-view" data-status={run.status}>
          <div className="page-head">
            <div>
              <h1 className="page-title">{title}</h1>
              <div className="page-sub">
                {run.target} · started {formatTime(run.startedAt)}
              </div>
            </div>
          </div>
          <div className="run-layout">
            <div className="run-main">
              <section className="panel">
                <div className="panel-body io">
                  <div>
                    <div className="io-label">Input</div>
                    <div className="io-input">{run.input}</div>
                  </div>
                  <div>
                    <div className="io-label">{live ? 'Output so far' : 'Output'}</div>
                    {run.output ? (
                      run.kind === 'workflow' ? (
                        <StateView label="Final state" value={outputValue(run.output)} />
                      ) : (
                        <Markdown text={run.output} />
                      )
                    ) : (
                      <span className="muted">
                        {live ? 'Waiting for the first tokens' : 'No output'}
                      </span>
                    )}
                    {run.error && <ErrorText>{run.error}</ErrorText>}
                  </div>
                </div>
              </section>

              {run.kind === 'workflow' && <WorkflowRunPanel run={run} workflow={workflow} />}

              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title">
                    <SquareTerminal size={14} />
                    Trace
                  </div>
                  <div className="wf-legend">
                    <span>
                      <i style={{ background: 'var(--bar-llm)' }} />
                      Model
                    </span>
                    <span>
                      <i style={{ background: 'var(--bar-tool)' }} />
                      Tool
                    </span>
                    <span>
                      <i style={{ background: 'var(--bar-run)' }} />
                      Run
                    </span>
                  </div>
                </div>
                <div style={{ padding: '4px 0 8px' }}>
                  <Waterfall run={run} runs={runs} />
                </div>
              </section>

              {run.toolCalls.length > 0 && (
                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-title">
                      <Wrench size={14} />
                      Tool calls <span className="count">{run.toolCalls.length}</span>
                    </div>
                  </div>
                  <div className="panel-body" style={{ display: 'grid', gap: 8 }}>
                    {run.toolCalls.map((call) => (
                      <ToolCallCard key={call.id} call={call} />
                    ))}
                  </div>
                </section>
              )}

              {forks.length > 0 && (
                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-title">
                      <GitFork size={14} />
                      Forks <span className="count">{forks.length}</span>
                    </div>
                  </div>
                  {forks.map((fork) => (
                    <a
                      key={fork.id}
                      className="fork-row"
                      href={href('compare', run.id, fork.id)}
                      data-testid="fork-link"
                    >
                      <StatusBadge status={fork.status} />
                      <span>From step {fork.forkOf?.step}</span>
                      <span className="muted grow truncate" style={{ flex: 1 }}>
                        {fork.output ? fork.output.replace(/\s+/g, ' ') : ''}
                      </span>
                      <span className="muted">{timeAgo(fork.startedAt)}</span>
                    </a>
                  ))}
                </section>
              )}

              {forkable && <ForkPanel run={run} />}
            </div>
            <Properties run={run} runs={runs} />
          </div>
        </div>
      </div>
    </>
  );
}
