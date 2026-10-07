import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentInfo, RunRecord, ThreadRecord } from '../../protocol';
import { api } from '../api';
import { Collapsible, Empty, RichText, StatusBadge } from '../components/common';
import { ToolCallCard } from '../components/tool-call';
import { formatCost, formatDuration, timeAgo } from '../format';
import { href, navigate } from '../router';
import { loadThread, useStudio } from '../store';

function Turn({ run }: { run: RunRecord }) {
  const live = run.status === 'running' || run.status === 'waiting';
  return (
    <div className="turn" data-testid="turn" data-run={run.id} data-status={run.status}>
      <div className="message user">
        <div className="message-body">{run.input}</div>
      </div>
      <div className="message assistant">
        {run.reasoning && (
          <Collapsible title={<span className="muted">reasoning</span>} open={live}>
            <div className="reasoning">{run.reasoning}</div>
          </Collapsible>
        )}
        {run.toolCalls.map((call) => (
          <ToolCallCard key={call.id} call={call} />
        ))}
        {run.output ? (
          <div className="message-body" data-testid="answer">
            <RichText text={run.output} />
            {live && <span className="cursor" />}
          </div>
        ) : live ? (
          <div className="message-body muted">
            <span className="spinner" />{' '}
            {run.status === 'waiting' ? 'waiting for your approval' : 'thinking'}
          </div>
        ) : null}
        {run.error && (
          <div
            className={run.status === 'stopped' ? 'notice' : 'error-text'}
            data-testid="run-error"
          >
            {run.error}
          </div>
        )}
        <div className="turn-meta">
          <StatusBadge status={run.status} />
          {run.usage && <span>{formatCost(run.usage.cost, run.usage.priced !== false)}</span>}
          {run.usage && <span>{formatDuration(run.usage.duration)}</span>}
          {run.children.length > 0 && (
            <span>
              {run.children.length} nested run{run.children.length === 1 ? '' : 's'}
            </span>
          )}
          <a href={href('runs', run.id)} data-testid="trace-link">
            trace
          </a>
        </div>
      </div>
    </div>
  );
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
  return (
    <div className="threads">
      <button
        type="button"
        className="button"
        onClick={() => navigate('agents', agent)}
        data-testid="new-thread"
      >
        New thread
      </button>
      {threads.map((thread) => (
        <a
          key={thread.id}
          href={href('agents', agent, thread.id)}
          className={`thread ${thread.id === active ? 'active' : ''}`}
          data-testid="thread"
        >
          <span className="thread-title">{thread.title}</span>
          <span className="muted">{timeAgo(thread.updatedAt)}</span>
        </a>
      ))}
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
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (threadId) void loadThread(threadId).catch(() => undefined);
  }, [threadId]);

  const lastOutput = turns.at(-1)?.output?.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, lastOutput]);

  if (host.state !== 'ready') return <Empty>The project is not loaded yet.</Empty>;
  if (!agent) return <Empty>There is no agent {agentKey} in the registry.</Empty>;

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || sending || active) return;
    setSending(true);
    setError(undefined);
    try {
      const started = await api.chat(agentKey, text, threadId);
      setInput('');
      if (started.threadId !== threadId) navigate('agents', agentKey, started.threadId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) void send();
  };

  return (
    <div className="agent-view">
      <ThreadList agent={agentKey} threads={threads} active={threadId} />
      <div className="chat">
        <header className="chat-head">
          <div>
            <h1>{agent.name}</h1>
            <div className="muted">
              {agent.description ?? 'An agent of this project'} · {agent.model ?? 'default model'}
            </div>
          </div>
          <div className="tools-line">
            {agent.tools.map((tool) => (
              <span key={tool.name} className="chip" title={tool.description}>
                {tool.name}
                {tool.requiresApproval && <span className="chip-flag">approval</span>}
              </span>
            ))}
          </div>
        </header>
        {memory === 'studio' && (
          <div className="notice">
            The project has no memory configured, so the studio keeps the conversation of each
            thread for its runs.
          </div>
        )}
        <div className="messages" data-testid="messages">
          {turns.length === 0 && <Empty>Send a message to start a thread with {agent.name}.</Empty>}
          {turns.map((run) => (
            <Turn key={run.id} run={run} />
          ))}
          <div ref={bottom} />
        </div>
        <form className="composer" onSubmit={(event) => void send(event)}>
          <textarea
            className="input"
            rows={2}
            placeholder={`Message ${agent.name}, Enter to send, Shift+Enter for a new line`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKey}
            data-testid="chat-input"
          />
          {active ? (
            <button
              type="button"
              className="button danger"
              onClick={() => void api.stop(active.id)}
              data-testid="stop"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="button primary"
              disabled={sending || !input.trim()}
              data-testid="send"
            >
              Send
            </button>
          )}
        </form>
        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  );
}
