import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ArrowUp,
  Bot,
  ChevronRight,
  Info,
  Plus,
  Search,
  ShieldAlert,
  Square,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import type { AgentInfo, RunRecord, ThreadRecord } from '../../protocol';
import { api } from '../api';
import {
  CopyButton,
  Empty,
  ErrorText,
  Kbd,
  messageOf,
  StatusIcon,
  Topbar,
} from '../components/common';
import { Markdown } from '../components/markdown';
import { ToolCallCard } from '../components/tool-call';
import { agentModel, formatCost, formatDuration, formatTokens, timeAgo } from '../format';
import { usePageKey } from '../hotkeys';
import { href, navigate } from '../router';
import { loadThread, useStudio } from '../store';

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  return (
    <div className="reasoning" data-testid="reasoning">
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ChevronRight
          size={12}
          style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s' }}
        />
        {live ? 'Reasoning' : 'Reasoned'}
        {live && <span className="spinner" style={{ width: 10, height: 10 }} />}
      </button>
      {open && (
        <div className="reasoning-text">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

function Turn({ run }: { run: RunRecord }) {
  const live = run.status === 'running' || run.status === 'waiting';
  const tokens = run.usage ? run.usage.inputTokens + run.usage.outputTokens : undefined;
  return (
    <div className="turn" data-testid="turn" data-run={run.id} data-status={run.status}>
      <div className="msg-user">{run.input}</div>
      <div className="msg-assistant">
        {run.reasoning && (
          <Reasoning
            text={run.reasoning}
            live={run.status === 'running' && !run.output && run.toolCalls.length === 0}
          />
        )}
        {run.toolCalls.map((call) => (
          <ToolCallCard key={call.id} call={call} />
        ))}
        {run.output ? (
          <div data-testid="answer">
            <Markdown text={run.output} />
            {live && <span className="cursor" />}
          </div>
        ) : live && run.status === 'running' ? (
          <div className="msg-thinking">
            <span className="spinner" /> Thinking
          </div>
        ) : null}
        {run.error &&
          (run.status === 'stopped' ? (
            <div className="notice" data-testid="run-error">
              <Square size={13} />
              {run.error}
            </div>
          ) : (
            <div data-testid="run-error">
              <ErrorText>{run.error}</ErrorText>
            </div>
          ))}
        {!(live && !run.usage) && (
          <div className="turn-meta">
            <StatusIcon status={run.status} size={14} />
            {run.usage && (
              <>
                <span className="sep">·</span>
                <span>{formatDuration(run.usage.duration)}</span>
                <span className="sep">·</span>
                <span>{formatCost(run.usage.cost, run.usage.priced !== false)}</span>
                {tokens !== undefined && (
                  <>
                    <span className="sep">·</span>
                    <span>{formatTokens(tokens)} tokens</span>
                  </>
                )}
              </>
            )}
            {run.children.length > 0 && (
              <>
                <span className="sep">·</span>
                <span>
                  {run.children.length} nested run{run.children.length === 1 ? '' : 's'}
                </span>
              </>
            )}
            <span className="turn-actions">
              {run.output && <CopyButton value={run.output} label="Copy answer" />}
              <a
                className="btn btn-ghost btn-sm"
                href={href('runs', run.id)}
                data-testid="trace-link"
              >
                <SquareTerminal size={13} />
                Trace
              </a>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function groupOf(at: number, now = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (at >= start.getTime()) return 'Today';
  if (at >= start.getTime() - day) return 'Yesterday';
  if (at >= start.getTime() - 6 * day) return 'Previous 7 days';
  return 'Older';
}

function ThreadList({
  agent,
  threads,
  active,
}: {
  agent: string;
  threads: ThreadRecord[];
  active?: string;
}) {
  const [filter, setFilter] = useState('');
  const shown = threads.filter((thread) =>
    thread.title.toLowerCase().includes(filter.trim().toLowerCase())
  );
  let group = '';
  return (
    <aside className="threads" aria-label="Threads">
      <div className="threads-head">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => navigate('agents', agent)}
          data-testid="new-thread"
        >
          <Plus size={14} />
          New thread
          <span style={{ marginLeft: 'auto' }}>
            <Kbd keys={['N']} />
          </span>
        </button>
        {threads.length > 4 && (
          <label className="input-icon">
            <Search size={13} />
            <input
              className="input"
              placeholder="Filter threads"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              style={{ minHeight: 30, padding: '4px 10px 4px 30px' }}
            />
          </label>
        )}
      </div>
      <div className="threads-list">
        {shown.length === 0 && (
          <div className="muted" style={{ padding: '8px 10px' }}>
            {threads.length === 0 ? 'No threads yet.' : 'No thread matches.'}
          </div>
        )}
        {shown.map((thread) => {
          const heading = groupOf(thread.updatedAt);
          const show = heading !== group;
          group = heading;
          return (
            <div key={thread.id}>
              {show && <div className="thread-group">{heading}</div>}
              <a
                href={href('agents', agent, thread.id)}
                className={`thread ${thread.id === active ? 'active' : ''}`}
                aria-current={thread.id === active ? 'page' : undefined}
                data-testid="thread"
              >
                <span className="thread-title">{thread.title}</span>
                <span className="thread-meta">
                  {thread.runs.length} turn{thread.runs.length === 1 ? '' : 's'} ·{' '}
                  {timeAgo(thread.updatedAt)}
                </span>
              </a>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function AgentIntro({ agent }: { agent: AgentInfo }) {
  return (
    <div className="agent-intro">
      <div className="agent-intro-mark">
        <Bot size={20} />
      </div>
      <h2>{agent.name}</h2>
      <p>{agent.description ?? 'An agent of this project. Send a message to start a thread.'}</p>
      {agent.tools.length > 0 && (
        <div className="agent-intro-tools">
          {agent.tools.map((tool) => (
            <span key={tool.name} className="chip" data-tip={tool.description || tool.name}>
              {tool.requiresApproval ? <ShieldAlert size={11} /> : <Wrench size={11} />}
              {tool.name}
              {tool.requiresApproval && <span className="chip-flag">approval</span>}
            </span>
          ))}
        </div>
      )}
      {agent.instructions && (
        <>
          <div className="instructions-label">Instructions</div>
          <div className="instructions">{agent.instructions}</div>
        </>
      )}
    </div>
  );
}

/** Chat with an agent of the registry, one thread at a time. */
export function AgentView({ agentKey, threadId }: { agentKey: string; threadId?: string }) {
  const host = useStudio((state) => state.host);
  const memory = host.state === 'ready' ? host.memory : undefined;
  const agent: AgentInfo | undefined =
    host.state === 'ready' ? host.registry.agents.find((a) => a.key === agentKey) : undefined;
  const threadsById = useStudio((state) => state.threads);
  const runs = useStudio((state) => state.runs);
  const threads = Object.values(threadsById)
    .filter((thread) => thread.agent === agentKey)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const thread = threadId ? threadsById[threadId] : undefined;
  const turns = (thread?.runs ?? [])
    .map((id) => runs[id])
    .filter((run): run is RunRecord => run !== undefined);
  const active = turns.find((run) => run.status === 'running' || run.status === 'waiting');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (threadId) void loadThread(threadId).catch(() => undefined);
  }, [threadId]);

  useEffect(() => {
    pinned.current = true;
    composer.current?.focus();
  }, [threadId]);

  const last = turns.at(-1);
  const progress = `${turns.length}:${last?.output?.length ?? 0}:${last?.toolCalls.length ?? 0}:${last?.status ?? ''}`;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [progress]);

  useLayoutEffect(() => {
    const element = composer.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [input]);

  usePageKey(['n', 'c'], (event) => {
    if (event.key === 'n') navigate('agents', agentKey);
    else composer.current?.focus();
  });

  if (host.state !== 'ready')
    return (
      <>
        <Topbar crumbs={[{ label: 'Agents' }, { label: agentKey }]} />
        <div className="scroll">
          <Empty icon={Bot} title="Waiting for the project" />
        </div>
      </>
    );
  if (!agent)
    return (
      <>
        <Topbar crumbs={[{ label: 'Agents' }, { label: agentKey }]} />
        <div className="scroll">
          <Empty icon={Bot} title={`No agent ${agentKey}`}>
            It is not in the registry of this project anymore.
          </Empty>
        </div>
      </>
    );

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || sending || active) return;
    setSending(true);
    setError(undefined);
    pinned.current = true;
    try {
      const started = await api.chat(agentKey, text, threadId);
      setInput('');
      if (started.threadId !== threadId) navigate('agents', agentKey, started.threadId);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setSending(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      event.currentTarget.blur();
    }
  };

  return (
    <>
      <Topbar
        crumbs={[
          { label: agent.name, to: ['agents', agent.key] },
          ...(thread ? [{ label: thread.title }] : [{ label: 'New thread' }]),
        ]}
        actions={
          <>
            <span
              className="chip"
              data-tip={agent.model ? 'Model of the agent' : 'Default model of the runtime'}
            >
              {agentModel(agent, host.registry)}
            </span>
            <span
              className="chip"
              data-tip={agent.tools.map((tool) => tool.name).join(', ') || 'No tools'}
            >
              <Wrench size={11} />
              {agent.tools.length}
            </span>
          </>
        }
      />
      <div className="agent-layout">
        <ThreadList agent={agentKey} threads={threads} active={threadId} />
        <section className="chat" aria-label={`Chat with ${agent.name}`}>
          <div
            className="chat-scroll"
            ref={scroller}
            onScroll={(event) => {
              const element = event.currentTarget;
              pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
          >
            <div className="chat-inner" data-testid="messages">
              {memory === 'studio' && turns.length === 0 && (
                <div className="notice chat-notice">
                  <Info size={14} />
                  <span>
                    The project has no memory configured, so the studio keeps the conversation of
                    each thread for its runs.
                  </span>
                </div>
              )}
              {turns.length === 0 && <AgentIntro agent={agent} />}
              {turns.map((run) => (
                <Turn key={run.id} run={run} />
              ))}
            </div>
          </div>
          <form className="composer-wrap" onSubmit={(event) => void send(event)}>
            <div
              className="composer"
              onMouseDown={(event) => {
                if (
                  event.target instanceof HTMLElement &&
                  !event.target.closest('button, textarea')
                ) {
                  event.preventDefault();
                  composer.current?.focus();
                }
              }}
            >
              <textarea
                ref={composer}
                rows={1}
                placeholder={`Message ${agent.name}`}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onKey}
                aria-label={`Message ${agent.name}`}
                data-testid="chat-input"
              />
              <div className="composer-foot">
                <div className="composer-hint">
                  <span>
                    <Kbd keys={['Enter']} /> send
                  </span>
                  <span>
                    <Kbd keys={['Shift', 'Enter']} /> new line
                  </span>
                </div>
                {active ? (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => void api.stop(active.id)}
                    data-testid="stop"
                  >
                    <Square size={11} fill="currentColor" />
                    Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="btn btn-primary btn-icon btn-sm"
                    disabled={sending || !input.trim()}
                    aria-label="Send"
                    data-testid="send"
                  >
                    <ArrowUp size={15} />
                  </button>
                )}
              </div>
            </div>
            {error && (
              <div style={{ maxWidth: 780, margin: '0 auto' }}>
                <ErrorText>{error}</ErrorText>
              </div>
            )}
          </form>
        </section>
      </div>
    </>
  );
}
