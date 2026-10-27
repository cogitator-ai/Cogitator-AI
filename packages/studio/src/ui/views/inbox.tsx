import { useEffect, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  CircleCheck,
  Inbox,
  Mail,
  MailOpen,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import type { InboxItem, InboxItemKind, InboxItemStatus } from '@cogitator-ai/types';
import type { InboxAnswer, InboxItemRecord } from '../../protocol';
import { api } from '../api';
import { Empty, ErrorText, messageOf, Topbar } from '../components/common';
import { Markdown } from '../components/markdown';
import { excerpt, formatTime, timeAgo } from '../format';
import { href, navigate } from '../router';
import { useStudio } from '../store';

const KIND_LABEL: Record<InboxItemKind, string> = {
  result: 'Result',
  approval: 'Approval',
  question: 'Question',
  failure: 'Failure',
};

const STATUS_LABEL: Record<InboxItemStatus, string> = {
  unread: 'Unread',
  read: 'Read',
  archived: 'Archived',
};

const VIEWS = [
  { value: 'unread', label: 'Unread', status: ['unread'] },
  { value: 'open', label: 'All', status: ['unread', 'read'] },
  { value: 'archived', label: 'Archived', status: ['archived'] },
] as const satisfies ReadonlyArray<{
  value: string;
  label: string;
  status: readonly InboxItemStatus[];
}>;

type View = (typeof VIEWS)[number]['value'];

/** A question of a run as its inbox item keeps it. */
interface Interrupt {
  id: string;
  kind?: string;
  message: string;
  toolName?: string;
}

/** The questions an item waits on, from the interrupts its metadata keeps, approvals left out. */
function questionsOf(item: InboxItem): Interrupt[] {
  const raw = item.metadata?.interrupts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown): Interrupt[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { id, kind, message, toolName } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || kind === 'approval') return [];
    return [
      {
        id,
        message: typeof message === 'string' ? message : '',
        ...(typeof kind === 'string' && { kind }),
        ...(typeof toolName === 'string' && { toolName }),
      },
    ];
  });
}

/** The tool calls an agent's approval item waits on, by tool call id. */
function approvalsOf(item: InboxItem): string[] {
  return [
    ...new Set(
      (item.actions ?? []).flatMap((action) =>
        (action.kind === 'approve' || action.kind === 'reject') && action.approvalId !== undefined
          ? [action.approvalId]
          : []
      )
    ),
  ];
}

/** An answer to a question: JSON when the text is JSON, the text itself otherwise. */
function answerOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function InboxKindBadge({ kind }: { kind: InboxItemKind }) {
  return (
    <span className="status" data-status={`inbox-${kind}`} data-testid="inbox-kind">
      {KIND_LABEL[kind]}
    </span>
  );
}

function InboxRow({
  item,
  active,
  onOpen,
}: {
  item: InboxItemRecord;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`inbox-row ${active ? 'active' : ''}`}
      data-unread={item.status === 'unread'}
      onClick={onOpen}
      data-testid="inbox-row"
    >
      <span className="inbox-row-head">
        <span
          className="inbox-unread"
          aria-label={item.status === 'unread' ? 'unread' : undefined}
        />
        <span className="inbox-row-title truncate">{item.title}</span>
        <span className="inbox-row-time muted">{timeAgo(item.createdAt)}</span>
      </span>
      <span className="inbox-row-meta">
        <InboxKindBadge kind={item.kind} />
        {item.routineId && <span className="chip">{item.routineId}</span>}
        {item.status === 'archived' && <span className="muted">archived</span>}
      </span>
      <span className="inbox-row-summary subtle">{excerpt(item.summary, 160)}</span>
    </button>
  );
}

/** Approve and Reject for an item a run waits on, answered through the routine. */
function ApprovalForm({ item, onAnswer }: { item: InboxItem; onAnswer: (a: InboxAnswer) => void }) {
  const [reason, setReason] = useState('');
  const ids = approvalsOf(item);
  const workflow = item.approvalId !== undefined && item.threadId === undefined;
  const answer = (approved: boolean): InboxAnswer => {
    if (workflow) return { decision: approved };
    const decision = approved
      ? { approved: true }
      : { approved: false, ...(reason.trim() && { reason: reason.trim() }) };
    return { decisions: Object.fromEntries(ids.map((id) => [id, decision])) };
  };
  if (!workflow && ids.length === 0)
    return <div className="muted">The item names no tool call to approve.</div>;
  return (
    <div className="inbox-answer">
      {!workflow && (
        <input
          className="input"
          placeholder="Why it is rejected, for the model (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-label="Reason to reject"
        />
      )}
      <div className="inbox-answer-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onAnswer(answer(true))}
          data-testid="inbox-approve"
        >
          <Check size={12} />
          {ids.length > 1 ? `Approve all ${ids.length}` : 'Approve'}
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => onAnswer(answer(false))}
          data-testid="inbox-reject"
        >
          <X size={12} />
          {ids.length > 1 ? `Reject all ${ids.length}` : 'Reject'}
        </button>
      </div>
    </div>
  );
}

/** A text answer to each question of a run, sent as its response. */
function QuestionForm({ item, onAnswer }: { item: InboxItem; onAnswer: (a: InboxAnswer) => void }) {
  const questions = questionsOf(item);
  const [texts, setTexts] = useState<Record<string, string>>({});
  if (questions.length === 0)
    return <div className="muted">The item keeps no question to answer.</div>;
  const ready = questions.every((question) => (texts[question.id] ?? '').trim() !== '');
  return (
    <div className="inbox-answer">
      {questions.map((question) => (
        <label key={question.id} className="inbox-question">
          <span>
            {question.message || 'The run asks'}
            {question.toolName && <span className="chip">{question.toolName}</span>}
          </span>
          <textarea
            className="input"
            rows={2}
            value={texts[question.id] ?? ''}
            onChange={(event) =>
              setTexts((current) => ({ ...current, [question.id]: event.target.value }))
            }
            placeholder="Your answer, as text or JSON"
            data-testid="inbox-answer"
          />
        </label>
      ))}
      <div className="inbox-answer-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!ready}
          onClick={() =>
            onAnswer({
              responses: Object.fromEntries(
                questions.map((question) => [question.id, answerOf(texts[question.id] ?? '')])
              ),
            })
          }
          data-testid="inbox-send"
        >
          <Send size={12} />
          Send
        </button>
        <span className="muted">An answer that parses as JSON is sent as JSON.</span>
      </div>
    </div>
  );
}

function InboxDetail({
  item,
  onChange,
}: {
  item: InboxItemRecord;
  onChange: (item: InboxItemRecord) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [answered, setAnswered] = useState<string>();

  const mark = async (action: 'read' | 'unread' | 'archive') => {
    setBusy(true);
    setError(undefined);
    try {
      onChange({
        ...(await api.markInbox(item.id, action)),
        ...(item.links && { links: item.links }),
      });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const respond = async (answer: InboxAnswer) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.respondInbox(item.id, answer);
      setAnswered(
        `Answered, the run ${result.runId ? `${result.runId} ` : ''}goes on and its outcome comes to the inbox.`
      );
      onChange({ ...item, status: 'archived' });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const waits =
    (item.kind === 'approval' || item.kind === 'question') && item.status !== 'archived';
  return (
    <section className="panel inbox-detail" data-testid="inbox-detail">
      <div className="panel-head">
        <div className="panel-title inbox-detail-title">
          <InboxKindBadge kind={item.kind} />
          <span className="truncate">{item.title}</span>
        </div>
        <div className="plugin-actions">
          {item.status === 'unread' ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void mark('read')}
              data-testid="inbox-mark-read"
            >
              <MailOpen size={12} />
              Mark read
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void mark('unread')}
              data-testid="inbox-mark-unread"
            >
              {item.status === 'archived' ? <ArchiveRestore size={12} /> : <Mail size={12} />}
              {item.status === 'archived' ? 'Restore' : 'Mark unread'}
            </button>
          )}
          {item.status !== 'archived' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void mark('archive')}
              data-testid="inbox-archive"
            >
              <Archive size={12} />
              Archive
            </button>
          )}
        </div>
      </div>
      <div className="panel-body plugin-body">
        {error && <ErrorText>{error}</ErrorText>}
        {answered && (
          <div className="notice plugin-outcome" role="status">
            <CircleCheck size={14} />
            <span>{answered}</span>
          </div>
        )}
        <dl className="kv">
          <dt>Status</dt>
          <dd>{STATUS_LABEL[item.status]}</dd>
          <dt>Created</dt>
          <dd>{formatTime(item.createdAt)}</dd>
          {item.routineId && (
            <>
              <dt>Routine</dt>
              <dd>
                <a href={href('schedules', item.routineId)}>{item.routineId}</a>
              </dd>
            </>
          )}
          {item.triggerId && (
            <>
              <dt>Trigger</dt>
              <dd className="mono">{item.triggerId}</dd>
            </>
          )}
          {item.source && (
            <>
              <dt>Source</dt>
              <dd>{item.source}</dd>
            </>
          )}
          {item.runId && (
            <>
              <dt>Run</dt>
              <dd className="mono">
                {item.links?.run ? (
                  <a href={href('runs', item.links.run)}>{item.runId}</a>
                ) : (
                  item.runId
                )}
              </dd>
            </>
          )}
          {item.threadId && (
            <>
              <dt>Thread</dt>
              <dd className="mono">
                {item.links?.thread ? (
                  <a href={href('agents', item.links.thread.agent, item.links.thread.threadId)}>
                    {item.threadId}
                  </a>
                ) : (
                  item.threadId
                )}
              </dd>
            </>
          )}
        </dl>
        <div className="plugin-section">
          <div className="field-title">Summary</div>
          <div className="inbox-text">{item.summary || <span className="muted">Empty</span>}</div>
        </div>
        {item.body && (
          <div className="plugin-section">
            <div className="field-title">In full</div>
            <div className="inbox-text">
              <Markdown text={item.body} />
            </div>
          </div>
        )}
        {waits && !answered && (
          <div className="plugin-section">
            <div className="field-title">
              {item.kind === 'approval' ? 'The run waits for approval' : 'The run asks'}
            </div>
            {busy ? (
              <span className="spinner" />
            ) : item.kind === 'approval' ? (
              <ApprovalForm item={item} onAnswer={(answer) => void respond(answer)} />
            ) : (
              <QuestionForm item={item} onAnswer={(answer) => void respond(answer)} />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The inbox of the project's routines: their results, failures, approvals and questions, newest
 * first, updated live. An approval is approved or rejected here and a question answered, and the
 * run goes on.
 */
export function InboxView({ itemId }: { itemId?: string }) {
  const host = useStudio((state) => state.host);
  const inbox = useStudio((state) => state.inbox);
  const [view, setView] = useState<View>('open');
  const [kind, setKind] = useState<InboxItemKind | ''>('');
  const [items, setItems] = useState<InboxItemRecord[]>();
  const [configured, setConfigured] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [opened, setOpened] = useState<InboxItemRecord>();
  const revision = inbox?.revision ?? 0;
  const loadedAt = host.state === 'ready' ? host.loadedAt : 0;

  useEffect(() => {
    if (!loadedAt) return;
    let current = true;
    const status = VIEWS.find((option) => option.value === view)?.status ?? [];
    const timer = setTimeout(() => {
      api
        .inbox({ status: [...status], ...(kind && { kind }), limit: 200 })
        .then((listing) => {
          if (!current) return;
          setItems(listing.items);
          setConfigured(listing.configured);
          setError(undefined);
        })
        .catch((failure: unknown) => current && setError(messageOf(failure)));
    }, 60);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [view, kind, revision, loadedAt]);

  useEffect(() => {
    if (!itemId) {
      setOpened(undefined);
      return;
    }
    const found = items?.find((item) => item.id === itemId);
    if (found) setOpened(found);
  }, [itemId, items]);

  const crumbs = [{ label: 'Inbox' }];
  if (host.state !== 'ready' && configured === undefined)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={Inbox} title="Waiting for the project">
            {host.state === 'failed' ? 'The project does not load.' : undefined}
          </Empty>
        </div>
      </>
    );
  if (configured === false)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={Inbox} title="No routines in this runtime">
            The inbox holds what the routines of <code>experimental_triggers</code> come to: their
            results, failures, approvals and questions. Give the Cogitator config{' '}
            <code>experimental_triggers</code> with routines to see them here.
          </Empty>
        </div>
      </>
    );

  const shown = opened && opened.id === itemId ? opened : undefined;
  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="scroll">
        <div className="page">
          <div className="page-head">
            <div>
              <h1 className="page-title">Inbox</h1>
              <div className="page-sub">
                What the routines came to: results, failures and the runs that wait for a person.
                {inbox && inbox.unread > 0 && ` ${inbox.unread} unread.`}
              </div>
            </div>
          </div>
          <div className="toolbar">
            <div className="seg" role="group" aria-label="Status">
              {VIEWS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={view === option.value}
                  onClick={() => setView(option.value)}
                  data-testid={`inbox-view-${option.value}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <select
              className="input select"
              value={kind}
              onChange={(event) => setKind(event.target.value as InboxItemKind | '')}
              aria-label="Kind"
              data-testid="inbox-kind-filter"
            >
              <option value="">Every kind</option>
              {(Object.keys(KIND_LABEL) as InboxItemKind[]).map((value) => (
                <option key={value} value={value}>
                  {KIND_LABEL[value]}s
                </option>
              ))}
            </select>
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          {!items && !error && <div className="skeleton" style={{ height: 240 }} />}
          {items && (
            <div className="inbox-layout">
              <div className="inbox-list" role="list" aria-label="Inbox items">
                {items.length === 0 ? (
                  <div className="panel">
                    <Empty icon={view === 'unread' ? CircleCheck : Inbox} title="Nothing here">
                      {view === 'unread'
                        ? 'Every item is read.'
                        : 'Results of routines show up here once they run.'}
                    </Empty>
                  </div>
                ) : (
                  items.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      active={item.id === itemId}
                      onOpen={() => navigate('inbox', item.id)}
                    />
                  ))
                )}
              </div>
              {shown ? (
                <InboxDetail
                  key={shown.id}
                  item={shown}
                  onChange={(changed) => {
                    setOpened(changed);
                    setItems((current) =>
                      current?.map((entry) => (entry.id === changed.id ? changed : entry))
                    );
                  }}
                />
              ) : (
                <div className="panel inbox-detail">
                  <Empty icon={MessageSquare} title={itemId ? 'Not in this list' : 'Open an item'}>
                    {itemId
                      ? 'The item is not among the ones listed: pick another status or kind.'
                      : 'Pick an item to read it in full, answer it or archive it.'}
                  </Empty>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
