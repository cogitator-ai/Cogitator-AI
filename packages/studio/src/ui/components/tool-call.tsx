import { lazy, Suspense, useState } from 'react';
import { ChevronRight, ShieldAlert, Wrench } from 'lucide-react';
import type { RunRecord, ToolCallRecord } from '../../protocol';
import { api } from '../api';
import { useStudio } from '../store';

const ToolAppFrame = lazy(() =>
  import('./tool-app-frame').then((module) => ({ default: module.ToolAppFrame }))
);
import { excerpt, pretty } from '../format';
import { ErrorText, JsonBlock, messageOf, StatusBadge } from './common';

/** `city: "Lisbon", days: 3` for an object of arguments, the JSON of anything else. */
function summarize(args: unknown): string {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return Object.entries(args)
      .map(
        ([key, value]) =>
          `${key}: ${typeof value === 'string' ? JSON.stringify(value) : pretty(value)}`
      )
      .join(', ')
      .replace(/\s+/g, ' ');
  }
  return excerpt(pretty(args), 120);
}

/**
 * The registry key of the run's agent when its tool `tool` has an MCP App, looked up by the run's
 * target, else by the agent's name for a run an agent delegated to
 */
function useAppAgent(
  run: Pick<RunRecord, 'target' | 'agentName'> | undefined,
  tool: string
): string | undefined {
  return useStudio((state) => {
    if (!run || state.host.state !== 'ready') return undefined;
    const agents = state.host.registry.agents;
    const agent =
      agents.find((candidate) => candidate.key === run.target) ??
      agents.find((candidate) => candidate.name === run.agentName);
    return agent?.tools.some((candidate) => candidate.name === tool && candidate.app)
      ? agent.key
      : undefined;
  });
}

/**
 * A tool call of a run: one line until opened, the approval it waits for always in view, and the
 * tool's MCP App, when it has one, below it.
 */
export function ToolCallCard({
  call,
  run,
}: {
  call: ToolCallRecord;
  run?: Pick<RunRecord, 'target' | 'agentName'>;
}) {
  const appAgent = useAppAgent(run, call.name);
  const approval = call.approval;
  const waiting = approval?.status === 'waiting';
  const [open, setOpen] = useState(Boolean(call.error));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running =
    call.result === undefined && !call.error && !waiting && approval?.status !== 'rejected';

  const decide = async (approved: boolean, remember = false) => {
    if (!approval) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.approve(
        approval.id,
        approved,
        approved ? undefined : reason.trim() || undefined,
        approved && remember
      );
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="tool"
      data-state={waiting ? 'waiting' : call.error ? 'error' : 'done'}
      data-open={open}
      data-testid="tool-call"
      data-tool={call.name}
    >
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ChevronRight size={13} className="tool-chevron" />
        <Wrench size={13} />
        <span className="tool-name" title={call.presentation ? call.name : undefined}>
          {call.presentation?.label ?? call.name}
        </span>
        <span className="tool-args">
          {call.presentation ? (call.presentation.detail ?? '') : summarize(call.arguments)}
        </span>
        {running && call.progress !== undefined && (
          <span className="tool-result" data-testid="tool-progress">
            {excerpt(pretty(call.progress), 60)}
          </span>
        )}
        {running && <span className="spinner" aria-label="running" />}
        {waiting && <StatusBadge status="waiting" />}
        {approval && approval.status !== 'waiting' && (
          <span
            className="status"
            data-status={approval.status}
            title={approval.remembered ? approval.remembered.rule : approval.reason}
          >
            {approval.status === 'rejected'
              ? 'Rejected'
              : approval.remembered
                ? 'Always allowed'
                : 'Approved'}
          </span>
        )}
        {call.error && (
          <span className="tool-result tool-result-error">{excerpt(call.error, 60)}</span>
        )}
        {call.error && <StatusBadge status="failed" />}
        {call.result !== undefined && !call.error && (
          <span className="tool-result">→ {excerpt(pretty(call.result), 60)}</span>
        )}
      </button>
      {appAgent && approval?.status !== 'waiting' && approval?.status !== 'rejected' && (
        <Suspense fallback={null}>
          <ToolAppFrame agent={appAgent} call={call} />
        </Suspense>
      )}
      {open && (
        <div className="tool-body">
          <JsonBlock label="Arguments" value={call.arguments} />
          {call.result !== undefined && !(call.error && call.result === null) && (
            <JsonBlock label="Result" value={call.result} />
          )}
          {call.details !== undefined && <JsonBlock label="Details" value={call.details} />}
          {approval?.reason && <div className="notice">Rejected because: {approval.reason}</div>}
          {approval?.remembered && (
            <div className="notice">
              Allowed from now on by <code>{approval.remembered.rule}</code>, saved to the{' '}
              {approval.remembered.layer} rules
            </div>
          )}
          {call.error && <ErrorText>{call.error}</ErrorText>}
        </div>
      )}
      {waiting && (
        <div className="approval" data-testid="approval">
          <div className="approval-text">
            <ShieldAlert size={15} />
            {call.name} needs your approval before it runs
          </div>
          {(approval.askReason || approval.rule) && (
            <div className="approval-why" data-testid="approval-why">
              {approval.askReason}
              {approval.rule && (
                <span className="approval-rule">
                  Rule <code>{approval.rule}</code>
                </span>
              )}
            </div>
          )}
          {!open && <JsonBlock label="Arguments" value={call.arguments} />}
          <div className="approval-row">
            <input
              className="input"
              placeholder="Reason the model sees if you reject it (optional)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void decide(false)}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void decide(false)}
              data-testid="reject"
            >
              Reject
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void decide(true)}
              data-testid="approve"
            >
              Approve
            </button>
          </div>
          {approval.suggestedRule && (
            <div className="approval-always">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void decide(true, true)}
                data-testid="approve-always"
              >
                Always allow
              </button>
              <span className="approval-rule">
                saves <code>{approval.suggestedRule}</code>, calls like this one run without asking
              </span>
            </div>
          )}
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      )}
    </div>
  );
}
