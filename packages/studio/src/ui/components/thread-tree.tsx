import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { GitBranch, GitFork, RotateCcw, X } from 'lucide-react';
import type {
  FileRestoreSummary,
  ForkPreview,
  RewindSummary,
  ThreadTree,
  TreeEntry,
} from '../../protocol';
import { api, ApiError } from '../api';
import { href, navigate } from '../router';
import { useStudio } from '../store';
import { Empty, ErrorText, messageOf } from './common';
import { eventLabel, eventText } from '../tree-events';

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

type ActionKind = 'rewind' | 'fork';

/** What the entries of the tree can do: rewind the thread to them and fork it at them. */
interface TreeActions {
  /** Whether the memory keeps a tree, which rewinds and forks need. */
  enabled: boolean;
  open?: { kind: ActionKind; entryId: string };
  start: (kind: ActionKind, entry: TreeEntry) => void;
  /** The confirm card of the open action, shown under its entry. */
  card: ReactNode;
}

const ActionsContext = createContext<TreeActions>({
  enabled: false,
  start: () => undefined,
  card: null,
});

const SHOWN_FILES = 8;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Whether some user message at or before `entryId` on its branch names a file checkpoint. */
function checkpointedAt(tree: ThreadTree, entryId: string): boolean {
  const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  let id: string | null | undefined = entryId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) return false;
    if (entry.checkpoint) return true;
    id = entry.parentId;
  }
  return false;
}

function FileList({ title, paths }: { title: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="tree-card-files">
      <span className="tree-card-label">{title}</span>
      {paths.slice(0, SHOWN_FILES).map((path) => (
        <span key={path} className="mono">
          {path}
        </span>
      ))}
      {paths.length > SHOWN_FILES && (
        <span className="muted">and {paths.length - SHOWN_FILES} more</span>
      )}
    </div>
  );
}

function FilesPreview({ files }: { files: FileRestoreSummary }) {
  return (
    <>
      {files.restored.length === 0 && files.deleted.length === 0 ? (
        <span className="muted">The files are as the checkpoint has them already.</span>
      ) : (
        <>
          <FileList title="Restores" paths={files.restored} />
          <FileList title="Deletes" paths={files.deleted} />
        </>
      )}
      {!files.exact && (
        <span className="muted">
          The checkpoint holds the files from before the turn this entry is in.
        </span>
      )}
      {files.busy && (
        <span className="is-warn">
          Commands still run in the workspace: the restore is refused until they end
        </span>
      )}
    </>
  );
}

function FilesCheck({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid="restore-files"
      />
      Restore files
    </label>
  );
}

/**
 * Rewinds the thread to an entry once the user saw what changes: a dry run first, again whenever
 * the files question changes, then the rewind itself.
 */
function RewindCard({
  threadId,
  entry,
  offerFiles,
  onDone,
  onCancel,
}: {
  threadId: string;
  entry: TreeEntry;
  offerFiles: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [files, setFiles] = useState(false);
  const [preview, setPreview] = useState<RewindSummary>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let current = true;
    setPreview(undefined);
    setError(undefined);
    setBusy(false);
    api
      .rewind(threadId, { entryId: entry.id, files, dryRun: true })
      .then((read) => current && setPreview(read))
      .catch((failure: unknown) => current && setError(messageOf(failure)));
    return () => {
      current = false;
    };
  }, [threadId, entry.id, files]);

  const apply = async (force: boolean) => {
    setWorking(true);
    setError(undefined);
    try {
      await api.rewind(threadId, { entryId: entry.id, files, ...(force && { force: true }) });
      onDone();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(failure instanceof ApiError && failure.status === 409);
    } finally {
      setWorking(false);
    }
  };

  const cut = preview?.conversation.cut.length ?? 0;
  return (
    <div className="tree-card" data-testid="rewind-card">
      <div className="tree-card-title">
        <RotateCcw size={12} />
        Rewind here
      </div>
      {offerFiles && <FilesCheck checked={files} onChange={setFiles} disabled={working} />}
      {!preview && !error && (
        <span className="muted">
          <span className="spinner" style={{ width: 10, height: 10 }} /> Checking what changes
        </span>
      )}
      {preview && (
        <ul className="tree-card-list" data-testid="rewind-preview">
          <li>
            {cut === 0
              ? 'Nothing leaves the active branch'
              : `${plural(cut, 'entry leaves', 'entries leave')} the active branch`}
          </li>
          {preview.staleItems > 0 && (
            <li>{plural(preview.staleItems, 'memory item goes', 'memory items go')} stale</li>
          )}
          {preview.runs.going.length > 0 && (
            <li className="is-warn">A run goes on in the thread</li>
          )}
          {preview.runs.paused && <li>The paused run of the thread is dropped</li>}
          {preview.runs.durable.length > 0 && (
            <li>
              {plural(preview.runs.durable.length, 'durable run is', 'durable runs are')} dropped
            </li>
          )}
        </ul>
      )}
      {preview?.files && <FilesPreview files={preview.files} />}
      {error && <ErrorText>{error}</ErrorText>}
      <div className="tree-card-actions">
        {busy ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={working}
            onClick={() => void apply(true)}
            data-testid="rewind-force"
          >
            Abort the run and rewind
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!preview || working}
            onClick={() => void apply(false)}
            data-testid="rewind-apply"
          >
            Apply
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Forks the thread at an entry into a new thread, with its files when asked, and opens it. */
function ForkCard({
  threadId,
  agentKey,
  entry,
  offerFiles,
  onCancel,
}: {
  threadId: string;
  agentKey: string;
  entry: TreeEntry;
  offerFiles: boolean;
  onCancel: () => void;
}) {
  const [files, setFiles] = useState(false);
  const [preview, setPreview] = useState<ForkPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let current = true;
    setPreview(undefined);
    setError(undefined);
    setBusy(false);
    if (!files) return;
    api
      .forkPreview(threadId, { entryId: entry.id, files: true })
      .then((read) => current && setPreview(read))
      .catch((failure: unknown) => current && setError(messageOf(failure)));
    return () => {
      current = false;
    };
  }, [threadId, entry.id, files]);

  const fork = async (force: boolean) => {
    setWorking(true);
    setError(undefined);
    try {
      const forked = await api.forkThread(threadId, {
        entryId: entry.id,
        files,
        ...(force && { force: true }),
      });
      navigate('agents', agentKey, forked.threadId);
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(failure instanceof ApiError && failure.status === 409);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="tree-card" data-testid="fork-card">
      <div className="tree-card-title">
        <GitFork size={12} />
        Fork here
      </div>
      <span className="muted">A new thread starts from this point, this one stays as it is.</span>
      {offerFiles && <FilesCheck checked={files} onChange={setFiles} disabled={working} />}
      {files && (
        <span className="muted">
          The files are restored in the agent's workspace, which this thread works in too.
        </span>
      )}
      {files && !preview && !error && (
        <span className="muted">
          <span className="spinner" style={{ width: 10, height: 10 }} /> Checking what changes
        </span>
      )}
      {preview && preview.going.length > 0 && (
        <span className="is-warn">A run goes on in the thread or its workspace</span>
      )}
      {preview?.files && <FilesPreview files={preview.files} />}
      {error && <ErrorText>{error}</ErrorText>}
      <div className="tree-card-actions">
        {busy ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={working}
            onClick={() => void fork(true)}
            data-testid="fork-force"
          >
            Abort the run and fork
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={working || (files && !preview)}
            onClick={() => void fork(false)}
            data-testid="fork-apply"
          >
            Fork
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
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
  const event = eventLabel(entry);
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
  const actions = useContext(ActionsContext);
  const open = actions.open?.entryId === entry.id;
  const row = entry.runId ? (
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
  if (!actions.enabled) return row;
  return (
    <>
      <div className={`tree-row ${open ? 'is-open' : ''}`}>
        {row}
        <span className="tree-actions">
          {onActive && !leaf && (
            <button
              type="button"
              className={`btn btn-ghost btn-icon btn-sm ${open && actions.open?.kind === 'rewind' ? 'is-on' : ''}`}
              onClick={() => actions.start('rewind', entry)}
              aria-label="Rewind here"
              data-tip="Rewind here"
              data-testid="tree-rewind"
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            type="button"
            className={`btn btn-ghost btn-icon btn-sm ${open && actions.open?.kind === 'fork' ? 'is-on' : ''}`}
            onClick={() => actions.start('fork', entry)}
            aria-label="Fork here"
            data-tip="Fork here"
            data-testid="tree-fork"
          >
            <GitFork size={12} />
          </button>
        </span>
      </div>
      {open && actions.card}
    </>
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
  agentKey,
  version,
  onClose,
  onRewound,
}: {
  threadId: string;
  /** The agent of the thread, whose new thread a fork opens. */
  agentKey: string;
  /** Changes when the thread does, to read the tree again. */
  version: string;
  onClose: () => void;
  /** Called after a rewind changed the thread. */
  onRewound: () => void;
}) {
  const [tree, setTree] = useState<ThreadTree>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<{ kind: ActionKind; entry: TreeEntry }>();
  const [reads, setReads] = useState(0);

  useEffect(() => setOpen(undefined), [threadId]);

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
  }, [threadId, version, reads]);

  const shape = tree && shapeOf(tree);
  const roots = shape?.children.get(null) ?? [];
  const leafId = tree?.branching ? tree.activeLeafId : undefined;
  const offerFiles = tree && open ? checkpointedAt(tree, open.entry.id) : false;
  const actions: TreeActions = {
    enabled: tree?.branching === true,
    ...(open && { open: { kind: open.kind, entryId: open.entry.id } }),
    start: (kind, entry) =>
      setOpen((current) =>
        current?.kind === kind && current.entry.id === entry.id ? undefined : { kind, entry }
      ),
    card:
      open?.kind === 'rewind' ? (
        <RewindCard
          key={`rewind:${open.entry.id}`}
          threadId={threadId}
          entry={open.entry}
          offerFiles={offerFiles}
          onCancel={() => setOpen(undefined)}
          onDone={() => {
            setOpen(undefined);
            setReads((count) => count + 1);
            onRewound();
          }}
        />
      ) : open?.kind === 'fork' ? (
        <ForkCard
          key={`fork:${open.entry.id}`}
          threadId={threadId}
          agentKey={agentKey}
          entry={open.entry}
          offerFiles={offerFiles}
          onCancel={() => setOpen(undefined)}
        />
      ) : null,
  };
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
        <ActionsContext.Provider value={actions}>
          {shape && roots.length === 1 && <Branch first={roots[0]} shape={shape} leafId={leafId} />}
          {shape && roots.length > 1 && <Forks entries={roots} shape={shape} leafId={leafId} />}
        </ActionsContext.Provider>
      </div>
    </aside>
  );
}
