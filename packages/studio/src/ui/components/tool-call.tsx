import { useState } from 'react';
import { ChevronRight, ShieldAlert, Wrench } from 'lucide-react';
import type { ToolCallRecord } from '../../protocol';
import { api } from '../api';
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

/** A tool call of a run: one line until opened, the approval it waits for always in view. */
export function ToolCallCard({ call }: { call: ToolCallRecord }) {
  const approval = call.approval;
  const waiting = approval?.status === 'waiting';
  const [open, setOpen] = useState(Boolean(call.error));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running =
    call.result === undefined && !call.error && !waiting && approval?.status !== 'rejected';

  const decide = async (approved: boolean) => {
    if (!approval) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.approve(approval.id, approved, approved ? undefined : reason.trim() || undefined);
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
        <span className="tool-name">{call.name}</span>
        <span className="tool-args">{summarize(call.arguments)}</span>
        {running && <span className="spinner" aria-label="running" />}
        {waiting && <StatusBadge status="waiting" />}
        {approval && approval.status !== 'waiting' && (
          <span className="status" data-status={approval.status} title={approval.reason}>
            {approval.status === 'approved' ? 'Approved' : 'Rejected'}
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
      {open && (
        <div className="tool-body">
          <JsonBlock label="Arguments" value={call.arguments} />
          {call.result !== undefined && !(call.error && call.result === null) && (
            <JsonBlock label="Result" value={call.result} />
          )}
          {approval?.reason && <div className="notice">Rejected because: {approval.reason}</div>}
          {call.error && <ErrorText>{call.error}</ErrorText>}
        </div>
      )}
      {waiting && (
        <div className="approval" data-testid="approval">
          <div className="approval-text">
            <ShieldAlert size={15} />
            {call.name} needs your approval before it runs
          </div>
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
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      )}
    </div>
  );
}
