import { useEffect, useState } from 'react';
import { GitBranch, X } from 'lucide-react';
import type { ThreadTree, TreeEntry } from '../../protocol';
import { api } from '../api';
import { href } from '../router';
import { useStudio } from '../store';
import { Empty, ErrorText, messageOf } from './common';

const EVENT_LABEL: Record<string, string> = {
  model_change: 'Model change',
  compaction: 'Compaction',
  approval: 'Paused for approval',
  interrupt: 'Interrupted',
  label: 'Label',
  custom: 'Event',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** What an event entry says, in a line. */
function eventText(entry: TreeEntry): string {
  const event = record(entry.event);
  if (entry.type === 'model_change' && typeof event.to === 'string') {
    return typeof event.from === 'string' ? `${event.from} → ${event.to}` : event.to;
  }
  if (entry.type === 'approval' && Array.isArray(event.pending)) {
    return event.pending
      .map((item) => record(item).toolName)
      .filter((name): name is string => typeof name === 'string')
      .join(', ');
  }
  return entry.text;
}

interface Shape {
  children: Map<string | null, TreeEntry[]>;
  active: Set<string>;
}

/** The children of every entry, oldest first, and the entries on the active branch. */
function shapeOf(tree: ThreadTree): Shape {
  const ids = new Set(tree.entries.map((entry) => entry.id));
  const children = new Map<string | null, TreeEntry[]>();
  tree.entries.forEach((entry, index) => {
    const previous = index > 0 ? tree.entries[index - 1].id : null;
    const parent = !tree.branching
      ? previous
      : entry.parentId && ids.has(entry.parentId)
        ? entry.parentId
        : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  });
  const parents = new Map(tree.entries.map((entry) => [entry.id, entry.parentId]));
  const active = new Set<string>();
  let id: string | null | undefined = tree.branching ? tree.activeLeafId : tree.entries.at(-1)?.id;
  while (id && ids.has(id) && !active.has(id)) {
    active.add(id);
    id = tree.branching ? parents.get(id) : undefined;
  }
  if (!tree.branching) for (const entry of tree.entries) active.add(entry.id);
  return { children, active };
}

function Entry({
  entry,
  shape,
  leaf,
  opens,
}: {
  entry: TreeEntry;
  shape: Shape;
  leaf: boolean;
  /** Whether the entry starts a branch. */
  opens: boolean;
}) {
  const event = EVENT_LABEL[entry.type];
  const forked = useStudio((state) =>
    opens && entry.runId ? state.runs[entry.runId]?.kind === 'fork' : false
  );
  const onActive = shape.active.has(entry.id);
  const body = (
    <>
      <span className="tree-dot" aria-hidden />
      <span className="tree-text">
        {event ? (
          <>
            <span className="tree-event">{event}</span> {eventText(entry)}
          </>
        ) : (
          <>
            <span className="tree-role">{entry.type === 'tool_result' ? 'tool' : entry.role}</span>{' '}
            {entry.text ||
              (entry.toolCalls?.length ? (
                <span className="tree-calls">calls {entry.toolCalls.join(', ')}</span>
              ) : (
                <span className="tree-empty">(empty)</span>
              ))}
          </>
        )}
      </span>
      {forked && <span className="chip tree-tag">fork</span>}
      {leaf && <span className="chip tree-tag">next message</span>}
    </>
  );
  const className = `tree-entry ${onActive ? 'on-path' : ''} ${event ? 'is-event' : ''}`;
  return entry.runId ? (
    <a
      className={className}
      href={href('runs', entry.runId)}
      data-tip="Open the run that wrote it"
      data-testid="tree-entry"
    >
      {body}
    </a>
  ) : (
    <div className={className} data-testid="tree-entry">
      {body}
    </div>
  );
}

/**
 * The entries from `first` on while the thread does not branch, then every branch from there, so
 * a long conversation reads as a column and only forks indent.
 */
function Branch({
  first,
  shape,
  leafId,
}: {
  first: TreeEntry;
  shape: Shape;
  leafId: string | undefined;
}) {
  const chain: TreeEntry[] = [first];
  let next = shape.children.get(first.id) ?? [];
  while (next.length === 1) {
    chain.push(next[0]);
    next = shape.children.get(next[0].id) ?? [];
  }
  return (
    <>
      {chain.map((entry, index) => (
        <Entry
          key={entry.id}
          entry={entry}
          shape={shape}
          leaf={entry.id === leafId}
          opens={index === 0}
        />
      ))}
      {next.length > 1 && <Forks entries={next} shape={shape} leafId={leafId} />}
    </>
  );
}

function Forks({
  entries,
  shape,
  leafId,
}: {
  entries: TreeEntry[];
  shape: Shape;
  leafId: string | undefined;
}) {
  return (
    <div className="tree-forks">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`tree-branch ${shape.active.has(entry.id) ? 'on-path' : ''}`}
          data-testid="tree-branch"
        >
          <Branch first={entry} shape={shape} leafId={leafId} />
        </div>
      ))}
    </div>
  );
}

/**
 * Every branch of a thread as its memory keeps it: forks and replays branch off where they went
 * on from, and the active branch is the one the next message continues.
 */
export function ThreadTreePanel({
  threadId,
  version,
  onClose,
}: {
  threadId: string;
  /** Changes when the thread does, to read the tree again. */
  version: string;
  onClose: () => void;
}) {
  const [tree, setTree] = useState<ThreadTree>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    api
      .threadTree(threadId)
      .then((read) => {
        if (!current) return;
        setTree(read);
        setError(undefined);
      })
      .catch((failure: unknown) => current && setError(messageOf(failure)));
    return () => {
      current = false;
    };
  }, [threadId, version]);

  const shape = tree && shapeOf(tree);
  const roots = shape?.children.get(null) ?? [];
  const leafId = tree?.branching ? tree.activeLeafId : undefined;
  return (
    <aside className="tree-panel" aria-label="Memory tree" data-testid="thread-tree">
      <div className="tree-head">
        <GitBranch size={13} />
        <span>Memory tree</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onClose}
          aria-label="Close the memory tree"
        >
          <X size={13} />
        </button>
      </div>
      <div className="tree-body">
        {error && <ErrorText>{error}</ErrorText>}
        {tree && !tree.branching && (
          <div className="notice tree-notice">
            The memory of this project keeps entries as a list, so forks do not show as branches.
          </div>
        )}
        {tree?.truncated && (
          <div className="notice tree-notice">Only the newest {tree.entries.length} entries.</div>
        )}
        {tree && tree.entries.length === 0 && !error && (
          <Empty icon={GitBranch} title="Nothing in memory yet" />
        )}
        {shape && roots.length === 1 && <Branch first={roots[0]} shape={shape} leafId={leafId} />}
        {shape && roots.length > 1 && <Forks entries={roots} shape={shape} leafId={leafId} />}
      </div>
    </aside>
  );
}
