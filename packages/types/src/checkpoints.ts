/**
 * File checkpoints: a run with a workspace takes a snapshot of its files before every user
 * message it writes to the thread, so `cogitator.rewind()` can bring the files back together
 * with the conversation and memory.
 */

/** `checkpoints` on an agent or a run: whether and how runs take file checkpoints */
export interface FileCheckpointsConfig {
  /** Default: true once `checkpoints` is an object */
  enabled?: boolean;
  /** Globs the snapshots leave out on top of the workspace's defaults (`node_modules`, `.git`, `.cogitator`) */
  exclude?: readonly string[];
  /** Files larger than this many bytes are skipped, see `WorkspaceSnapshotOptions.maxFileBytes` */
  maxFileBytes?: number;
}

/** `CogitatorConfig.checkpoints`: the runtime's default for its runs, and how rewinds treat files */
export interface CogitatorCheckpointsConfig extends FileCheckpointsConfig {
  /**
   * Whether `cogitator.rewind()` restores files when its call does not say (`files`). Default:
   * false, a rewind restores files only when asked to, as it rewrites and removes files
   */
  rewindFiles?: boolean;
}

/**
 * The metadata key a user message entry keeps its file checkpoint under, see
 * {@link FileCheckpointRef}
 */
export const FILE_CHECKPOINT_KEY = 'fileCheckpoint';

/**
 * What a user message entry keeps of the snapshot taken right before it was written
 * (`entry.metadata.fileCheckpoint`): the files as they were at that point of the conversation
 */
export interface FileCheckpointRef {
  /** Id of the snapshot, as `Workspace.restore()` takes it */
  snapshotId: string;
  /** Id of the workspace that took it */
  workspaceId: string;
  /** Root of that workspace */
  root: string;
}

/** The checkpoint `metadata` names, when it names a well-formed one */
export function fileCheckpointOf(
  metadata: Record<string, unknown> | undefined
): FileCheckpointRef | undefined {
  const value = metadata?.[FILE_CHECKPOINT_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const { snapshotId, workspaceId, root } = value as Record<string, unknown>;
  if (typeof snapshotId !== 'string' || typeof workspaceId !== 'string' || typeof root !== 'string')
    return undefined;
  return { snapshotId, workspaceId, root };
}

/**
 * The metadata key an entry keeps, when it is the point a thread was forked at, the checkpoint
 * that holds the files exactly as they were there, see {@link FileCheckpointAtRef}
 */
export const FILE_CHECKPOINT_AT_KEY = 'fileCheckpointAt';

/**
 * The checkpoint of the files at an entry itself (`entry.metadata.fileCheckpointAt`): the one of
 * the user message that came right after it in the thread it was forked from, which the fork
 * does not copy
 */
export interface FileCheckpointAtRef extends FileCheckpointRef {
  /** The user message entry the checkpoint was taken for, in the thread forked from */
  entryId: string;
}

/** The checkpoint of the files at the entry itself `metadata` names, when it is well-formed */
export function fileCheckpointAtOf(
  metadata: Record<string, unknown> | undefined
): FileCheckpointAtRef | undefined {
  const value = metadata?.[FILE_CHECKPOINT_AT_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const checkpoint = fileCheckpointOf({ [FILE_CHECKPOINT_KEY]: value });
  const { entryId } = value as Record<string, unknown>;
  if (!checkpoint || typeof entryId !== 'string') return undefined;
  return { ...checkpoint, entryId };
}
