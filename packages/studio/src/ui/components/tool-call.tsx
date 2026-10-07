import { useState } from 'react';
import type { ToolCallRecord } from '../../protocol';
import { api } from '../api';
import { JsonBlock } from './common';

/** A tool call of a run: its arguments and result, and the approval it waits for. */
export function ToolCallCard({ call }: { call: ToolCallRecord }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const approval = call.approval;

  const decide = async (approved: boolean) => {
    if (!approval) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.approve(approval.id, approved, approved ? undefined : reason.trim() || undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`tool-call ${call.error ? 'tool-error' : ''}`}
      data-testid="tool-call"
      data-tool={call.name}
    >
      <div className="tool-head">
        <span className="tool-icon">⚙</span>
        <span className="tool-name">{call.name}</span>
        {approval && approval.status !== 'waiting' && (
          <span
            className={`badge badge-${approval.status === 'approved' ? 'completed' : 'failed'}`}
          >
            {approval.status}
            {approval.reason ? `: ${approval.reason}` : ''}
          </span>
        )}
        {call.result === undefined &&
          !call.error &&
          approval?.status !== 'waiting' &&
          approval?.status !== 'rejected' && <span className="spinner" aria-label="running" />}
      </div>
      <JsonBlock label="arguments" value={call.arguments} />
      {approval?.status === 'waiting' && (
        <div className="approval" data-testid="approval">
          <div className="approval-text">This call needs your approval before it runs.</div>
          <input
            className="input"
            placeholder="Reason, if you reject it"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="row">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void decide(true)}
              data-testid="approve"
            >
              Approve
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void decide(false)}
              data-testid="reject"
            >
              Reject
            </button>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}
      {call.result !== undefined && <JsonBlock label="result" value={call.result} />}
      {call.error && <div className="error-text">{call.error}</div>}
    </div>
  );
}
