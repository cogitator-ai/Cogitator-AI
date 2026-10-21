/**
 * Memory files: notes an agent keeps under `/memories` and edits with the memory tool, each
 * change kept as a version of its own
 */

import type { MemoryResult } from './memory';
import type { MemoryItemScope } from './memory-items';

/** Who wrote a version of a memory file */
export type MemoryFileAuthor = 'model' | 'user' | 'system';

/**
 * One version of a memory file. Versions are never changed, only added: an edit adds the file's
 * next version, a deletion adds one without content. Redacting replaces the content of a version
 * in place, the one change a version takes, so what must not be kept is gone from every store.
 */
export interface MemoryFileVersion {
  id: string;
  /** Who the file belongs to: its agent, and the user, project or thread it is kept for */
  scope: MemoryItemScope;
  /** The file's path, starting with `/memories/` */
  path: string;
  /**
   * Its place among the versions of its path in its scope, from 1, one more than the newest
   * version when it was written: two writers that read the same newest version cannot both add
   * the next one
   */
  sequence: number;
  /** The file's text, null when this version deletes it */
  content: string | null;
  /** SHA-256 of `content` as hex, null when this version deletes the file */
  sha256: string | null;
  /** SHA-256 of the version this one replaces, null for a new file */
  previousSha256: string | null;
  /**
   * The thread entry the run that wrote it stood on: a version is seen in its own thread only on
   * the branches that hold that entry, so a branch keeps its own edits. Absent for a file written
   * outside a conversation.
   */
  place?: { threadId: string; entryId: string };
  /** The path the file had before, when this version renamed it */
  renamedFrom?: string;
  author: MemoryFileAuthor;
  createdAt: Date;
  /** When the content of this version was redacted, and why */
  redacted?: { at: Date; reason?: string };
}

/** Which versions a {@link MemoryFileAdapter} finds: all of the given conditions hold */
export interface MemoryFileFilter {
  agentId: string;
  ids?: string[];
  /** Versions of exactly these paths */
  paths?: string[];
  /** Versions of the paths under this one, `/memories/notes/` for example */
  prefix?: string;
  /**
   * Versions a run of this scope sees: for each of `userId`, `projectId` and `threadId`, the
   * version has none or the same one. Its `agentId` is not read, the filter's is.
   */
  visibleTo?: MemoryItemScope;
  /** Versions of exactly this scope. Its `agentId` is not read, the filter's is. */
  scope?: MemoryItemScope;
}

/** What a {@link MemoryFileAdapter} reports when the version's place is taken already */
export const MEMORY_FILE_CONFLICT = 'memory-file-conflict';

/**
 * Where memory file versions are kept. Every built-in memory adapter is one.
 */
export interface MemoryFileAdapter {
  /**
   * Adds `versions`, all of them or none: fails with {@link MEMORY_FILE_CONFLICT} as its error
   * when a version of the same scope and path holds the `sequence` of one of them already, and
   * keeps none of them then
   */
  putFileVersions(versions: MemoryFileVersion[]): Promise<MemoryResult<MemoryFileVersion[]>>;
  /** The versions the filter finds, oldest first: by `createdAt`, then `sequence`, then `id` */
  findFileVersions(filter: MemoryFileFilter): Promise<MemoryResult<MemoryFileVersion[]>>;
  /**
   * Replaces the content of these versions with `content` (and its `sha256`), marks them
   * redacted at `at`, and changes nothing else. Missing versions are left alone.
   */
  redactFileVersions(
    ids: string[],
    redaction: { content: string; sha256: string; at: Date; reason?: string }
  ): Promise<MemoryResult<void>>;
  /** Deletes the versions for good */
  deleteFileVersions(ids: string[]): Promise<MemoryResult<void>>;
}

/**
 * `memory.files`: the memory tool, notes under `/memories` an agent views and edits, each change
 * a version of its own. The runtime adds the `memory` tool to every run and the list of files to
 * its context.
 */
export interface MemoryFilesConfig {
  /**
   * Who the files belong to: `user` (default) the run's user, agent-wide for a run without one,
   * `agent` everyone the agent talks to, `thread` the thread alone
   */
  scope?: 'user' | 'agent' | 'thread';
  /** The agent views the files and never changes them */
  readOnly?: boolean;
  /** Characters of the context the list of files takes at most (default 2000) */
  indexChars?: number;
}
