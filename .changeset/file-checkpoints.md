---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/memory': minor
'@cogitator-ai/config': minor
'@cogitator-ai/sandbox': minor
'@cogitator-ai/test-utils': minor
'@cogitator-ai/cli': minor
---

File checkpoints and a rewind that takes the conversation, the memory and the files back to an earlier message in one operation.

An agent that edits a project changes files with its tools and its shell commands, and going back in the conversation left them as the agent made them. Now a run can take a snapshot of its workspace before every user message, and `cog.rewind()` restores it together with the conversation. Everything is off by default: without `checkpoints` no snapshot is taken, and a rewind restores files only when asked.

Snapshots (types, core, sandbox):

- `LocalWorkspace` implements `snapshot`, `restore`, `listSnapshots`, `deleteSnapshot`, and adds `pruneSnapshots(retention)` and `copySnapshot(id, target)`. Snapshots are content-addressed in `.cogitator/checkpoints`: sha256 blobs for file contents and directory trees, one manifest per snapshot. A file whose size, times, inode and mode did not change since the snapshot before is not read again, and a content or a directory that did not change is stored once, so a snapshot per message stays cheap on a real project (`snapshot.stats` says what was read and stored). Symlinks are recorded as links and never followed, modes are kept, a file that changes while it is read is read again, files over `maxFileBytes` (10 MiB) are skipped and listed in `skipped`. `restore(id, { dryRun })` writes through the workspace's safe placement (a temporary file with `O_NOFOLLOW` renamed over the path), removes what the snapshot did not have, never touches excluded or skipped paths, checks every content against its hash before it changes anything, refuses with `BUSY` while a command of the workspace runs, and returns what it `restored`, `deleted` and `kept`. `LocalWorkspaceOptions.snapshots` sets `exclude`, `maxFileBytes`, a retention policy (`retain: { count, maxAgeMs }`) and `gcGraceMs` for the mark and sweep collection that `deleteSnapshot` and `pruneSnapshots` run.
- `DockerWorkspace` forwards `restore` with its options, `listSnapshots`, `deleteSnapshot` and `copySnapshot` to its host workspace, and exposes the host as `host`. `RemoteShellWorkspace` (E2B, Daytona, Vercel) keeps its tar snapshots with the same API: `maxFileBytes` and `skipped`, `restore(id, { dryRun })` with the same result (a tar restore rewrites every file it holds, so `restored` lists them all).
- New types: `WorkspaceRestoreOptions`, `WorkspaceRestoreResult`, `WorkspaceSnapshotSkip`, `WorkspaceSnapshotStats`, `WORKSPACE_SNAPSHOT_MAX_FILE_BYTES`, and `Workspace.copySnapshot?`.

Checkpoints and rewind (types, core, config, memory):

- `checkpoints: true | { enabled?, exclude?, maxFileBytes? }` on `CogitatorConfig` (with `rewindFiles?`), `AgentConfig` and `RunOptions`: a run whose workspace can snapshot takes `workspace.snapshot({ label: entryId })` before every user message it writes (the input and queued `steer`, `followUp` and `inject` messages) and names it in the entry, `metadata.fileCheckpoint` (`FILE_CHECKPOINT_KEY`, `FileCheckpointRef`, `fileCheckpointOf()`). The entry id is known before the entry is written, as `NewMemoryEntry` takes an `id` now. Changes made by shell commands between messages are caught too. The config package reads `checkpoints`.
- `cog.rewind(threadId, toEntryId, options)` takes `RewindOptions` (`agents`, `memory`, `files`, `workspace`, `dryRun`, `force`) and returns a `RewindReport`: the `MemoryCascadeReport` with `conversation` (`rewound`, `cut`, `previousLeafId`), `files` (the restore result with the `entryId` whose checkpoint was restored and whether it is `exact`) and `runs` (`going`, `interrupted`, `paused`, `durable`). The files come from the checkpoint right after the point when only notes lie before the next user message, else from the nearest one before it. Files are restored first, so a rewind that fails leaves the conversation as it was. `dryRun` changes nothing and reports what would change, `MemoryCascade.rewind` takes `{ dryRun }` for it.
- `cog.forkThread(threadId, atEntryId, { newThreadId?, files?, workspace?, source?, agents?, force? })` forks a thread with its checkpoint references, and with `files` restores the fork's workspace to that point, copying the branch's checkpoints into it first when it is another workspace.
- A run aborted while `onApproval` (or `guardrails.onToolApproval`) waits for an answer now ends with the abort instead of waiting for the answer.

CLI:

- `cogitator rewind <thread> [entry]` lists the active branch of a thread of the project's registry, entries with a file checkpoint marked, or rewinds it: the dry run first, then a prompt (`--yes` without a terminal), with `--files`, `--no-memory`, `--dry-run`, `--force`, `--agent`, `--registry` and `--json`.

Memory adapters (memory, test-utils):

- Every built-in adapter keeps a caller-given entry id (`NewMemoryEntry.id`, letters, digits, `_` and `-`, at most 128) and refuses an id it keeps already. The adapter conformance suite has the case `entry-named-id`.

Breaking changes and migration:

- `Workspace.restore(snapshotId, options?)` returns a `WorkspaceRestoreResult` instead of `void`. A workspace of your own that implements `restore` returns `{ snapshotId, dryRun, restored, deleted, unchanged, kept }` and honors `dryRun`, callers that ignored the result need no change.
- `WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE` is `['.cogitator/**', '**/node_modules/**', '**/.git/**']`, so snapshots of every workspace leave out installed dependencies and the git repository, and a restore leaves them alone. Install dependencies again after a restore that changed the lockfile, and use git itself for the repository.
- Remote workspace snapshots skip files over 10 MiB by default: pass `maxFileBytes` to `snapshot()` to keep larger ones.
- `cog.rewind()` drops the paused run and the durable runs of the thread (their checkpoints hold the conversation that was cut), so a paused run can no longer be resumed after a rewind of its thread. It refuses with `THREAD_BUSY` while a run goes on in the thread, here or as a durable run another process holds: wait for the run, or pass `force: true` to abort it first. It throws `VALIDATION_ERROR` for an entry that is not on the active branch before anything changes. The report it returns extends the `MemoryCascadeReport` it returned, so code that reads it needs no change.
- A memory adapter of your own that ignores `NewMemoryEntry.id` still works with checkpoints (the entry names its snapshot in metadata either way), but fails the new `entry-named-id` conformance case until it keeps the id.
