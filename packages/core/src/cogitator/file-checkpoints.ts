import {
  CogitatorError,
  ErrorCode,
  FILE_CHECKPOINT_AT_KEY,
  fileCheckpointAtOf,
  fileCheckpointOf,
  type CogitatorCheckpointsConfig,
  type FileCheckpointAtRef,
  type FileCheckpointRef,
  type FileCheckpointsConfig,
  type ForkThreadEntryOptions,
  type MemoryEntry,
  type MemoryResult,
  type Thread,
  type Workspace,
  type WorkspaceRestoreOptions,
  type WorkspaceRestoreResult,
} from '@cogitator-ai/types';
import type { MemoryCascadeReport } from '@cogitator-ai/memory';
import type { Agent } from '../agent';
import { getLogger } from '../logger';

/** How a run takes its file checkpoints, once they are on */
export interface CheckpointSettings {
  exclude: string[];
  maxFileBytes?: number;
}

/**
 * The checkpoints of a run from the runtime's, the agent's and the run's `checkpoints`: the most
 * specific one that is set turns them on or off, the excludes of every level that sets some add
 * up, and the most specific `maxFileBytes` wins. Undefined when they are off
 */
export function checkpointSettings(
  runtime: boolean | CogitatorCheckpointsConfig | undefined,
  agent: boolean | FileCheckpointsConfig | undefined,
  run: boolean | FileCheckpointsConfig | undefined
): CheckpointSettings | undefined {
  const decided = run ?? agent ?? runtime;
  if (decided === undefined || decided === false) return undefined;
  if (typeof decided === 'object' && decided.enabled === false) return undefined;
  const levels = [runtime, agent, run].filter(
    (level): level is FileCheckpointsConfig => typeof level === 'object'
  );
  const exclude = [...new Set(levels.flatMap((level) => level.exclude ?? []))];
  const maxFileBytes = levels.reduce<number | undefined>(
    (found, level) => level.maxFileBytes ?? found,
    undefined
  );
  return { exclude, ...(maxFileBytes !== undefined && { maxFileBytes }) };
}

const warnedWorkspaces = new WeakSet<Workspace>();

/**
 * Takes the snapshot of `workspace` a user message entry about to be written names, labelled with
 * the entry's id. A workspace that cannot snapshot, or a snapshot that fails, is logged and the
 * message is written without a checkpoint: the run goes on
 */
export async function takeFileCheckpoint(
  workspace: Workspace,
  settings: CheckpointSettings,
  place: { entryId: string; threadId: string; runId: string }
): Promise<FileCheckpointRef | undefined> {
  if (!workspace.snapshot) {
    if (!warnedWorkspaces.has(workspace)) {
      warnedWorkspaces.add(workspace);
      getLogger().warn('File checkpoints are on, but the workspace cannot take snapshots', {
        workspace: workspace.id,
      });
    }
    return undefined;
  }
  try {
    const snapshot = await workspace.snapshot({
      label: place.entryId,
      exclude: settings.exclude,
      ...(settings.maxFileBytes !== undefined && { maxFileBytes: settings.maxFileBytes }),
      metadata: { threadId: place.threadId, runId: place.runId, entryId: place.entryId },
    });
    return { snapshotId: snapshot.id, workspaceId: workspace.id, root: workspace.root };
  } catch (error) {
    getLogger().warn('A file checkpoint could not be taken, the message is saved without one', {
      workspace: workspace.id,
      threadId: place.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** The file checkpoint at a point of a branch, see {@link checkpointAt} */
export interface CheckpointAtPoint {
  /** The user message entry whose checkpoint it is */
  entryId: string;
  checkpoint: FileCheckpointRef;
  /**
   * Whether the files it holds are the files at the point: nothing that could change files (a
   * model turn, a tool result) lies between the checkpoint and the point. When false, it holds
   * them as they were before the turn the point is in
   */
  exact: boolean;
}

function isUserMessage(entry: MemoryEntry): boolean {
  return (entry.type ?? 'message') === 'message' && entry.message.role === 'user';
}

/** Whether an entry tells of work that may have changed files: a model turn or a tool result */
function mayChangeFiles(entry: MemoryEntry): boolean {
  const type = entry.type ?? 'message';
  if (type === 'tool_result') return true;
  return (
    type === 'message' && (entry.message.role === 'assistant' || entry.message.role === 'tool')
  );
}

/**
 * The file checkpoint that holds the files as they were at entry `index` of `path` (a branch,
 * oldest first), the latest one not after it. A user message's checkpoint is taken right before
 * the message is written, so it holds the files at the entry before it too: a user message after
 * the point, when only session events and notes come between, gives the files at the point
 * exactly. Otherwise it is the checkpoint of the nearest user message at or before the point.
 * Undefined when no message there has one.
 *
 * With `tree`, every entry of the thread, the messages after the point are looked for on every
 * branch, and of those that name a checkpoint the one written last is taken: the choice does not
 * depend on the active branch, so a rewind to the point, which leaves the messages after it off
 * the active branch, restores the same checkpoint when it is repeated, as a fork from the point
 * does. Without it only the message after the point on `path` counts.
 *
 * An entry a thread was forked at names the checkpoint of the files at it
 * (`fileCheckpointAt`, the one of the message after it in the thread forked from, which the
 * fork does not copy): it counts as such a message's checkpoint, at or before the point
 */
export function checkpointAt(
  path: readonly MemoryEntry[],
  index: number,
  tree?: readonly MemoryEntry[]
): CheckpointAtPoint | undefined {
  const point = path[index];
  if (!point) return undefined;
  const after = tree ? checkpointAfterInTree(point.id, tree) : checkpointAfterOnPath(path, index);
  if (after) return after;
  let exact = true;
  for (let at = index; at >= 0; at--) {
    const entry = path[at];
    const own = fileCheckpointAtOf(entry.metadata);
    const ownRef = fileCheckpointRefOf(own);
    if (own && ownRef) return { entryId: own.entryId, checkpoint: ownRef, exact };
    if (isUserMessage(entry)) {
      const checkpoint = fileCheckpointOf(entry.metadata);
      if (checkpoint) return { entryId: entry.id, checkpoint, exact };
    }
    if (mayChangeFiles(entry)) exact = false;
  }
  return undefined;
}

/** The reference of a checkpoint at an entry, without the entry it was taken for */
function fileCheckpointRefOf(at: FileCheckpointAtRef | undefined): FileCheckpointRef | undefined {
  if (!at) return undefined;
  const { entryId: _entryId, ...checkpoint } = at;
  return checkpoint;
}

/** The checkpoint of the user message after entry `index` of `path`, see {@link checkpointAt} */
function checkpointAfterOnPath(
  path: readonly MemoryEntry[],
  index: number
): CheckpointAtPoint | undefined {
  for (let next = index + 1; next < path.length; next++) {
    const entry = path[next];
    if (mayChangeFiles(entry)) return undefined;
    if (!isUserMessage(entry)) continue;
    const checkpoint = fileCheckpointOf(entry.metadata);
    return checkpoint ? { entryId: entry.id, checkpoint, exact: true } : undefined;
  }
  return undefined;
}

/**
 * The checkpoint of the user message written last of those after entry `pointId` on any branch of
 * `tree`, see {@link checkpointAt}
 */
function checkpointAfterInTree(
  pointId: string,
  tree: readonly MemoryEntry[]
): CheckpointAtPoint | undefined {
  const children = new Map<string, MemoryEntry[]>();
  for (const entry of tree) {
    if (typeof entry.parentId !== 'string') continue;
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  }
  const seen = new Set<string>([pointId]);
  const queue = [...(children.get(pointId) ?? [])];
  let found: { entry: MemoryEntry; checkpoint: FileCheckpointRef } | undefined;
  for (const entry of queue) {
    if (seen.has(entry.id) || mayChangeFiles(entry)) continue;
    seen.add(entry.id);
    if (!isUserMessage(entry)) {
      queue.push(...(children.get(entry.id) ?? []));
      continue;
    }
    const checkpoint = fileCheckpointOf(entry.metadata);
    if (checkpoint && (!found || writtenAfter(entry, found.entry))) found = { entry, checkpoint };
  }
  return found && { entryId: found.entry.id, checkpoint: found.checkpoint, exact: true };
}

/** Whether entry `a` was written after entry `b`: by their place in the thread, else their time */
function writtenAfter(a: MemoryEntry, b: MemoryEntry): boolean {
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq > b.seq;
  const time = a.createdAt.getTime() - b.createdAt.getTime();
  return time !== 0 ? time > 0 : a.id > b.id;
}

/**
 * What a fork of `branch` (the entries up to the point, oldest first) at its last entry writes on
 * the copy of the point: the checkpoint `at` the files at it are in when it is exact and the
 * message it was taken for lies after the point, so the fork does not copy it. Rewinds and forks
 * of the fork then restore it from the point, as they would in the thread forked from
 */
export function forkPointMetadata(
  branch: readonly MemoryEntry[],
  at: CheckpointAtPoint | undefined
): ForkThreadEntryOptions {
  if (!at?.exact || branch.some((entry) => entry.id === at.entryId)) return {};
  return { pointMetadata: { [FILE_CHECKPOINT_AT_KEY]: { ...at.checkpoint, entryId: at.entryId } } };
}

/**
 * The snapshots the user messages of `path` name, each once, in the order of the path, then
 * `also` when the path does not name it
 */
export function checkpointsOn(
  path: readonly MemoryEntry[],
  also?: FileCheckpointRef
): FileCheckpointRef[] {
  const seen = new Set<string>();
  const found: FileCheckpointRef[] = [];
  const named = path.flatMap((entry) => [
    fileCheckpointOf(entry.metadata),
    fileCheckpointRefOf(fileCheckpointAtOf(entry.metadata)),
  ]);
  for (const checkpoint of [...named, also]) {
    if (!checkpoint || seen.has(checkpoint.snapshotId)) continue;
    seen.add(checkpoint.snapshotId);
    found.push(checkpoint);
  }
  return found;
}

/** What `Cogitator.rewind()` rewinds, and how */
export interface RewindOptions {
  /** Agents (or their memory ids) whose memory items to go through, besides those the thread names */
  agents?: readonly (Agent | string)[];
  /** Rewind the conversation and the memory that stood on it (default: true) */
  memory?: boolean;
  /**
   * Restore the files of the workspace from the file checkpoint at that point (default:
   * `CogitatorConfig.checkpoints.rewindFiles`, else false). Files are rewritten and removed, so
   * look at a `dryRun` first
   */
  files?: boolean;
  /** The workspace to restore, by default the workspace of the first of `agents` that has one */
  workspace?: Workspace;
  /** Change nothing, report what the rewind would change (default: false) */
  dryRun?: boolean;
  /**
   * Stop what is in the way first instead of refusing (default: false): the runs going on in the
   * thread here (`THREAD_BUSY`), and with files the runs of this runtime of other threads in the
   * workspace (`WORKSPACE_BUSY`). A durable run another process holds loses its run and stops at
   * its next step, and is never forced while files are restored, as its tools may still write
   */
  force?: boolean;
  /**
   * With files and `force`, milliseconds to wait for the tool calls of the stopped runs to end:
   * a tool may go on regardless of its abort signal and still write the files. Past it the rewind
   * is refused with `WORKSPACE_BUSY` (default: 10000)
   */
  toolSettleMs?: number;
}

/** What a file restore of a rewind or a fork did, see `Workspace.restore()` */
export interface FileRewindReport extends WorkspaceRestoreResult {
  /** The user message entry whose checkpoint was restored */
  entryId: string;
  /** Whether the checkpoint holds the files at that very point, see {@link CheckpointAtPoint} */
  exact: boolean;
  /** The workspace restored */
  workspaceId: string;
  /**
   * The snapshot of the files as they were right before the restore, taken when the restore
   * changed anything and the workspace can snapshot: `workspace.restore(safetySnapshotId)` undoes
   * a rewind or a fork that went too far. Absent for a dry run
   */
  safetySnapshotId?: string;
}

/** What `Cogitator.rewind()` changed, or would change with `dryRun` */
export interface RewindReport extends MemoryCascadeReport {
  threadId: string;
  toEntryId: string;
  dryRun: boolean;
  conversation: {
    /** Whether the active leaf moved back (false for a dry run and with `memory: false`) */
    rewound: boolean;
    /** The entries after `toEntryId` that leave the active branch, oldest first */
    cut: string[];
    /** The active leaf before the rewind */
    previousLeafId?: string;
  };
  /** The file restore, when files were rewound */
  files?: FileRewindReport;
  runs: {
    /** Runs going on in the thread when the rewind began (here, or durable runs held elsewhere) */
    going: string[];
    /** The runs here that `force` aborted */
    interrupted: string[];
    /** Whether the paused run of the thread was dropped (with `dryRun`: would be) */
    paused: boolean;
    /** The durable runs of the thread dropped (with `dryRun`: would be) */
    durable: string[];
  };
}

/** How `Cogitator.forkThread()` forks */
export interface ForkThreadOptions {
  /** Id of the new thread (default: generated) */
  newThreadId?: string;
  /** Restore the files of the fork's workspace to that point (default: false) */
  files?: boolean;
  /** The fork's workspace, by default the workspace of the first of `agents` that has one */
  workspace?: Workspace;
  /** Where the checkpoints of the thread are kept, when not in `workspace` */
  source?: Workspace;
  agents?: readonly (Agent | string)[];
  /**
   * With `files`, abort the runs going on in the thread and in the fork's workspace first,
   * instead of refusing with `THREAD_BUSY` or `WORKSPACE_BUSY` (default: false)
   */
  force?: boolean;
  /** With `files` and `force`, milliseconds to wait for the tool calls of stopped runs, see `RewindOptions` */
  toolSettleMs?: number;
  /**
   * Make no thread and change no files, only report what the fork would restore (default:
   * false). Into another workspace than `source`, the checkpoint to restore is copied into its
   * store first, as the plan needs it there
   */
  dryRun?: boolean;
}

/** What `Cogitator.forkThread()` made */
export interface ForkThreadResult {
  dryRun?: false;
  /** The new thread */
  thread: Thread;
  /** The checkpoints copied into the fork's workspace, when it is not `source` */
  snapshotsCopied: string[];
  /** The file restore, with `files` */
  files?: FileRewindReport;
}

/** What `Cogitator.forkThread()` with `dryRun` would do */
export interface ForkThreadPlan {
  dryRun: true;
  /** The checkpoints the fork would copy into its workspace, when it is not `source` */
  snapshotsCopied: string[];
  /** What the file restore would change, with `files` */
  files?: FileRewindReport;
  /** Runs going on in the thread or the workspace that a fork with `files` would need `force` for */
  going: string[];
}

/** The checkpoint a file restore takes, and how it restores the workspace */
export interface FileRestorePlan {
  at: CheckpointAtPoint;
  workspace: Workspace;
  restore(options?: WorkspaceRestoreOptions): Promise<FileRewindReport>;
}

/**
 * How the files at entry `index` of `path` are restored: from {@link checkpointAt} (with `tree`,
 * every entry of the thread) into `options.workspace`, or the workspace of the first of
 * `options.agents` that has one
 */
export function fileRestorePlan(
  path: readonly MemoryEntry[],
  index: number,
  options: { workspace?: Workspace; agents?: readonly (Agent | string)[] },
  tree?: readonly MemoryEntry[]
): FileRestorePlan {
  const at = checkpointAt(path, index, tree);
  if (!at) {
    throw new CogitatorError({
      message: `There is no file checkpoint at or before entry ${path[index]?.id}: turn checkpoints on (CogitatorConfig.checkpoints) for runs with a workspace`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  const workspace =
    options.workspace ??
    options.agents
      ?.map((agent) => (typeof agent === 'string' ? undefined : agent.config.workspace))
      .find((found) => found !== undefined);
  if (!workspace) {
    throw new CogitatorError({
      message:
        'Restoring files needs the workspace: pass workspace, or an agent that has one in agents',
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  const restore = workspace.restore?.bind(workspace);
  if (!restore) {
    throw new CogitatorError({
      message: `Workspace ${workspace.id} cannot restore snapshots`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  return {
    at,
    workspace,
    restore: async (restoreOptions) => ({
      ...(await restore(at.checkpoint.snapshotId, restoreOptions)),
      entryId: at.entryId,
      exact: at.exact,
      workspaceId: workspace.id,
    }),
  };
}

/** A cascade report of nothing */
export function emptyCascadeReport(): MemoryCascadeReport {
  return {
    entries: { deleted: [], redacted: [] },
    threads: [],
    threadsChanged: [],
    summaries: [],
    items: { purged: [], trimmed: [], stale: [] },
    entities: [],
    facts: { deleted: [], trimmed: [] },
    graph: { nodes: [], edges: [], trimmed: [] },
    fileVersions: [],
    playbookRules: 0,
  };
}

/** The value of a memory operation, or a `CogitatorError` that says which failed */
export function unwrapMemory<T>(result: MemoryResult<T>): T {
  if (!result.success) {
    throw new CogitatorError({
      message: `Memory failed: ${result.error}`,
      code: ErrorCode.INTERNAL_ERROR,
    });
  }
  return result.data;
}
