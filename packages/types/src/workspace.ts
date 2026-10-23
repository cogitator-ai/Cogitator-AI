/**
 * Workspace: the directory an agent works in, with file access and command execution that
 * cannot leave it.
 *
 * A workspace has a root and a current directory. Every path it takes is relative to the root
 * (an absolute path inside the root is accepted too), and a path that resolves outside the root,
 * through `..`, an absolute path elsewhere or a symlink that points out, is refused with a
 * {@link WorkspaceError} of code `OUTSIDE_ROOT`.
 *
 * Lifecycle: whoever creates a workspace owns it and calls `dispose()` when done. A workspace
 * starts itself on first use, `start()` only does it ahead of time, to surface errors (a missing
 * root, no Docker) early or to keep the first command fast. The runtime only uses the workspace it
 * is given (`AgentConfig.workspace`, `RunOptions.workspace`), it never starts or disposes one.
 */
export interface Workspace {
  /** Stable id of the workspace, used in logs and snapshot records */
  readonly id: string;
  /** Absolute path of the root as the workspace's file operations see it */
  readonly root: string;
  /**
   * The current directory, relative to the root (`.` for the root itself): commands run there by
   * default, and project instructions (`AGENTS.md`) are looked up from the root down to it
   */
  readonly cwd: string;

  /** Prepares the workspace (creates the root, starts a container). Idempotent, optional: the first operation does it */
  start(): Promise<void>;
  /**
   * Releases what the workspace holds (a container, the processes its commands left running).
   * Idempotent, the workspace and its `withCwd()` views are unusable afterwards
   */
  dispose(): Promise<void>;

  /**
   * The same workspace (same id, files, container and lifecycle) with another current directory,
   * relative to the root. Disposing the view disposes the workspace
   */
  withCwd(cwd: string): Workspace;

  /** Whether `path` lies inside the root once symlinks are followed. Never throws */
  contains(path: string): Promise<boolean>;

  /** The text of a file, read as UTF-8 */
  read(path: string, options?: WorkspaceReadOptions): Promise<string>;
  /** The bytes of a file */
  readBytes(path: string, options?: WorkspaceReadOptions): Promise<Uint8Array>;
  /** Writes text (as UTF-8) or bytes to a file, replacing what it held */
  write(path: string, content: string | Uint8Array, options?: WorkspaceWriteOptions): Promise<void>;

  /** Entries of a directory (the root by default): each directory's entries by name, its contents right after it */
  list(path?: string, options?: WorkspaceListOptions): Promise<WorkspaceEntry[]>;
  /** What is at `path`, symlinks inside the root followed */
  stat(path: string): Promise<WorkspaceStat>;
  /** Whether something exists at `path`. A path outside the root is refused, not `false` */
  exists(path: string): Promise<boolean>;
  /** Creates a directory and its missing parents */
  mkdir(path: string): Promise<void>;
  /** Removes a file, a symlink (not its target) or a directory, or moves it to the trash */
  remove(path: string, options?: WorkspaceRemoveOptions): Promise<WorkspaceRemoveResult>;
  /** Moves or renames a file or a directory inside the workspace */
  rename(from: string, to: string, options?: WorkspaceRenameOptions): Promise<void>;

  /**
   * Runs a shell command in the workspace (`sh -c`, `cmd.exe /d /s /c` for a local workspace on
   * Windows), in `cwd` by default. Resolves with the outcome, also for a non-zero exit or a
   * timeout, and rejects with a `WorkspaceError` of code `ABORTED` when `signal` aborts it. The
   * command's process group is killed on a timeout or an abort
   */
  exec(command: string, options?: WorkspaceExecOptions): Promise<WorkspaceExecResult>;

  /**
   * Records the state of the files, to go back to it with `restore()`, for example one snapshot
   * per user message. Optional: a workspace that cannot snapshot leaves these methods out
   */
  snapshot?(options?: WorkspaceSnapshotOptions): Promise<WorkspaceSnapshot>;
  /**
   * Brings the files back to a snapshot: changed files rewritten, new ones removed, the paths the
   * snapshot excluded left alone
   */
  restore?(snapshotId: string): Promise<void>;
  /** The snapshots kept, oldest first */
  listSnapshots?(): Promise<WorkspaceSnapshot[]>;
  /** Forgets a snapshot and frees what only it kept */
  deleteSnapshot?(snapshotId: string): Promise<void>;
}

export interface WorkspaceReadOptions {
  /** Refuse files larger than this many bytes (code `TOO_LARGE`). Default: the workspace's limit */
  maxBytes?: number;
}

export interface WorkspaceWriteOptions {
  /** Create missing parent directories (default: true) */
  createParents?: boolean;
  /** Refuse content larger than this many bytes (code `TOO_LARGE`). Default: the workspace's limit */
  maxBytes?: number;
  /** Replace the file even when it is read-only, which is refused with code `DENIED` otherwise */
  force?: boolean;
}

export interface WorkspaceListOptions {
  /** Descend into subdirectories (symlinked directories are listed, not entered). Default: false */
  recursive?: boolean;
  /**
   * Only entries whose path relative to the listed directory matches this glob: `*` and `?`
   * within a name, `**` across directories, `{a,b}` and `[abc]`. `*.ts` matches the listed
   * directory only, `**\/*.ts` every depth (with `recursive`)
   */
  glob?: string;
  /** Include entries whose name starts with `.` (default: false) */
  includeHidden?: boolean;
  /** Directory names not descended into, e.g. `node_modules` (default: none) */
  skipDirs?: readonly string[];
  /** Stop after this many entries (default: no limit) */
  limit?: number;
}

export interface WorkspaceRemoveOptions {
  /** Remove a directory with everything in it (default: false, only an empty one) */
  recursive?: boolean;
  /**
   * Move the entry to the workspace's trash instead of deleting it, so it can be brought back
   * (default: false)
   */
  trash?: boolean;
}

export interface WorkspaceRemoveResult {
  /** The removed path, relative to the root */
  path: string;
  /** Where the entry went when trashed, relative to the root */
  trashedTo?: string;
}

export interface WorkspaceRenameOptions {
  /** Replace an existing entry at `to` (default: false) */
  overwrite?: boolean;
}

export interface WorkspaceExecOptions {
  /** Directory to run in, relative to the root (default: the workspace's `cwd`) */
  cwd?: string;
  /** Environment variables on top of the workspace's own */
  env?: Record<string, string>;
  /** Milliseconds before the command is killed (default: the workspace's timeout) */
  timeout?: number;
  /** Kills the command when aborted */
  signal?: AbortSignal;
  /** Every piece of stdout as it arrives, also past the kept limit */
  onStdout?: (chunk: string) => void;
  /** Every piece of stderr as it arrives, also past the kept limit */
  onStderr?: (chunk: string) => void;
  /** Bytes of each stream kept in the result (default: the workspace's limit) */
  maxOutputBytes?: number;
  /**
   * What happens to processes the command started in the background (`&`) when it exits:
   * `kill` (default) ends its whole process group, `keep` leaves them running until `dispose()`.
   * Either way the call returns when the command itself exits, and a kept process's output is
   * no longer read, so redirect it (`server > server.log 2>&1 &`)
   */
  background?: 'kill' | 'keep';
}

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  /** Exit code, 124 when the command timed out, 128 + n when a signal n ended it */
  exitCode: number;
  timedOut: boolean;
  /** Whether stdout or stderr was cut at `maxOutputBytes` */
  truncated: boolean;
  durationMs: number;
}

export type WorkspaceEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface WorkspaceStat {
  /** Path relative to the root, with `/` separators, after symlinks are followed */
  path: string;
  type: WorkspaceEntryType;
  /** Size in bytes */
  size: number;
  /** Last modification time, in milliseconds since the epoch */
  modifiedAt: number;
}

export interface WorkspaceEntry extends WorkspaceStat {
  /** The entry's own name */
  name: string;
}

/** Paths a snapshot leaves out unless told otherwise: the workspace's own trash, tool results and temporary files. */
export const WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE: readonly string[] = ['.cogitator/**'];

export interface WorkspaceSnapshotOptions {
  /** What the snapshot marks, e.g. the id of the user message it was taken before */
  label?: string;
  /**
   * Globs (relative to the root) the snapshot leaves out, and `restore()` leaves alone
   * (default: {@link WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE})
   */
  exclude?: readonly string[];
  /** Your own data to keep with the snapshot */
  metadata?: Record<string, unknown>;
}

/** A recorded state of a workspace's files, see `Workspace.snapshot()`. */
export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  /** ISO 8601 time the snapshot was taken */
  createdAt: string;
  label?: string;
  metadata?: Record<string, unknown>;
  /** The globs the snapshot left out */
  exclude: readonly string[];
}

/**
 * Why a workspace operation was refused or failed:
 *
 * - `OUTSIDE_ROOT`: the path resolves outside the root
 * - `NOT_FOUND`: nothing exists at the path
 * - `NOT_A_FILE`, `NOT_A_DIRECTORY`: the path is of the other kind
 * - `EXISTS`: the target already exists
 * - `NOT_EMPTY`: a directory to remove holds entries and `recursive` is not set
 * - `TOO_LARGE`: a file or content is over the size limit
 * - `INVALID_PATH`: the path is malformed (empty, a NUL byte) or names the root where it cannot
 * - `NOT_STARTED`, `DISPOSED`: the workspace is not started yet or disposed already
 * - `UNAVAILABLE`: what the workspace needs is missing, e.g. Docker
 * - `ABORTED`: the operation's signal aborted it
 * - `DENIED`: the operating system or a policy refused it (permissions, a sandbox rule)
 * - `BUSY`: a process the workspace started is still running, and the operation would race it
 *   (`remove` and `rename` of a `LocalWorkspace`)
 * - `UNSUPPORTED`: the workspace cannot do this
 * - `IO`: the file system or the container failed otherwise
 */
export type WorkspaceErrorCode =
  | 'OUTSIDE_ROOT'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'EXISTS'
  | 'NOT_EMPTY'
  | 'TOO_LARGE'
  | 'INVALID_PATH'
  | 'NOT_STARTED'
  | 'DISPOSED'
  | 'UNAVAILABLE'
  | 'ABORTED'
  | 'DENIED'
  | 'BUSY'
  | 'UNSUPPORTED'
  | 'IO';

/** The error every `Workspace` operation fails with, see {@link WorkspaceErrorCode}. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  /** The path the operation was given, when it had one */
  readonly path?: string;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    options?: { path?: string; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorkspaceError';
    this.code = code;
    if (options?.path !== undefined) this.path = options.path;
  }

  /** Whether `error` is a `WorkspaceError`, with `code` when given */
  static is(error: unknown, code?: WorkspaceErrorCode): error is WorkspaceError {
    return error instanceof WorkspaceError && (code === undefined || error.code === code);
  }
}
