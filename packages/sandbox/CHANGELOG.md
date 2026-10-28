# @cogitator-ai/sandbox

## 0.10.0

### Minor Changes

- [#311](https://github.com/cogitator-ai/Cogitator-AI/pull/311) [`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a) - Local commands inside the operating system's sandbox, and deletions an agent can take back.

  OS sandbox (sandbox, types):

  - `OsSandbox` runs a workspace's commands under Seatbelt (`sandbox-exec` with a generated profile) on macOS and bubblewrap (`bwrap --unshare-net --unshare-pid --die-with-parent --new-session`, with `socat` bridging the proxy, the command in a second `bwrap` with `--disable-userns` and a seccomp filter that refuses new namespaces, mounts, io_uring and Unix sockets (datagram socket pairs too), so it cannot undo the read-only binds, the filter required unless `allowAllUnixSockets` lets commands reach every socket anyway) on Linux, with the semantics of Claude Code's sandboxed Bash tool. Writes only in the workspace root, `filesystem.allowWrite` and a temporary directory for each command (`TMPDIR`, removed once it is over), never in the protected paths (settings, hooks, skills, agents, commands and plugins of `.claude` and `.cogitator` in the root and above, `~/.claude`, `~/.cogitator`, `~/.claude.json`, the root's `.cogitator`, `.mcp.json`, shell startup files, `.gitconfig`, `.gitmodules`, `.vscode`, `.idea`, the repository's `hooks`, `config`, `commondir` and `config.worktree` (of linked worktrees and submodules too), the root's `.git` entry itself so no command swaps it for a `gitdir:` file, and a `HEAD` at the root so no command makes it a bare repository), a symlink at a protected path closing its target too, no protected or read-denied path (nor a directory above one) renamed or removed (Seatbelt rules for that on macOS, the directories bound over themselves on Linux), and a protected file (or hook script) with another hard link failing the launch. Reads everywhere but `filesystem.denyRead`, the narrower of a deny and an allow winning, an `allowRead` that reaches a denied region only through a symlink ignored, and a launch failing while a denied file (or one in a denied directory) has another hard link. `credentials.envVars` and `credentials.files` hide secrets. Loader variables (`LD_*`, `DYLD_*`, `GCONV_PATH`) never reach `bwrap` or `sandbox-exec`, which would run their code before any restriction holds: on Linux the inner bubblewrap hands them to the command alone.
  - Network only through an in-process HTTP `CONNECT` and SOCKS5 proxy for each command: `deniedDomains` wins, then `allowedDomains` (`host`, `*.domain`, `*`, IPv4, bracketed IPv6, optional `:port`), then the hosts the call lists for itself, then a decider (`onUnknownHost` of the call, else of the sandbox), else refused. A host name resolving only to loopback, link-local, a cloud metadata endpoint or an address of this machine is refused, `localhost` aside, and the address that passed is the one dialed (a 6to4 or NAT64 address is judged by the IPv4 address it carries, but dialed as itself). `strictAllowlist` refuses unknown hosts and per-command lists.
  - Proxy refusals and the file accesses the system refused are attributed to the command, in `result.sandbox.violations` and a sanitized `<sandbox_violations>` block appended to its stderr, a block the command prints itself neutralized. File violations are advisory (read from the command's stderr). `ignoreViolations` silences expected ones.
  - `failIfUnavailable` (default true) fails with `SANDBOX_UNAVAILABLE` and the reason instead of running unprotected, `excludedCommands` (Bash rule patterns, every command of the line must match, redirections, `cd` and substitutions stay sandboxed) and an honored `dangerouslyDisableSandbox` (only with `allowUnsandboxed`, default false) run outside it, and each result says how its command ran.
  - The `SandboxManager` has an `os` type (`SandboxConfig.os` is its policy, `isOsAvailable()`), with no fallback: its writable root is `workdir` (or the process's working directory, never `/`), not the `cwd` of the request, `excludedCommands` and `allowUnsandboxed` are ignored, `failIfUnavailable` is always true there, and `allowNativeFallback` keeps applying to Docker only, as before. A tool with `sandbox: { type: 'os' }` runs through it and fails with `SANDBOX_UNAVAILABLE` when no manager is available, never natively.
  - Config (`loadConfig`, `defineConfig`): `sandbox.defaults.type` accepts `os` and `sandbox.defaults.os` holds its policy, validated by the new `OsSandboxPolicySchema`.
  - New types: `OsSandboxPolicy` and its parts, `OsSandboxKind`, `OsSandboxAvailability`, `SandboxViolation`, `SandboxHostRequest`, `SandboxHostDecider`, `WorkspaceSandbox`, `WorkspaceCommandSandbox`, `WorkspaceSandboxRoute`, `WorkspaceExecSandbox`, `WorkspaceLaunch` (moved from core, still exported there, now with the required `root`, `command` and `request`, so code that builds one itself must add them), `WorkspaceLaunchOverride` (with `extraInputs` for descriptors 3 and on), `WorkspaceLaunchReport` (with `output` replacing the command's), `SandboxSettingsFile`. `SandboxType` gained `os`, `PermissionDecider` gained `sandbox`.

  Workspace and permissions (core):

  - `LocalWorkspace` takes `exec.sandbox`, checked when the workspace starts (code `UNAVAILABLE`, caused by `SANDBOX_UNAVAILABLE`) and exposed as `workspace.sandbox`. `exec.launch` may now return a promise, a whole environment, `extraInputs` and a `cleanup(result)` whose report sets `result.sandbox`, may replace the output and appends to stderr. A hook written for the old synchronous `{ file, args }` form works as before, but code that calls a `launch` hook itself must now await its result.
  - `exec()` takes `dangerouslyDisableSandbox`, `allowedDomains` and `onUnknownHost`, and `run_command` takes `allowedDomains` and `dangerouslyDisableSandbox` from the model.
  - A command that runs in the workspace's sandbox skips `run_command`'s own approval and a bare `Bash` ask rule (`decidedBy: 'sandbox'`, also in a run without permission setup). Only `run_command` of `workspaceTools()` executing in that workspace qualifies, never `exec` or a tool bound to another workspace. Deny rules, ask rules with a pattern, plan mode, the guardrails (a bare `Bash` ask rule then asks a person, no hook or classifier), lines a rule cannot read in full, commands with a variable in front, `eval`, `make X=y`, `source`, `alias`, `export`, `set -a`, `trap`, a shell reading stdin, and commands that list hosts of their own keep the normal flow.
  - A host a sandboxed command connects to that no list decides is decided as a `WebFetch(domain:...)` call: rules first, `bypassPermissions` allows, `auto` and `dontAsk` refuse, other modes ask a person through `onApproval`, and an allowed host stays allowed for the session (`ToolPermissionsView.decideHost`, `allowHost`). A direct `invokeTool` with `onApproval` asks it too, through `ToolContext.delegation`.
  - `loadSandboxPolicy(root)` reads the `sandbox` section of Claude Code's settings files as they are (lists merged across layers, booleans from the highest, managed locks such as `allowManagedDomainsOnly`, `allowManagedReadPathsOnly` and the admin-required sandbox applied (under which no repository `false` of `failIfUnavailable` counts), `Edit`, `Read` and `WebFetch(domain:...)` rules added), `sandboxPolicyOf(layers)` merges layers yourself. `readPermissionLayer` now also returns a layer for a file with only a `sandbox` section.
  - RT24: `listTrash()`, `restoreFromTrash(id, { to, overwrite })` and `emptyTrash({ olderThan })` on `LocalWorkspace` (a record per trashed entry, older entries listed by their folder) and `DockerWorkspace` (through its host), and a `delete_file` workspace tool that always moves to the trash. `emptyTrash` also removes leftovers no entry lists, trashing the trash is refused, and an entry reached through a symlink in its folder is never listed.

  Behavior changes:

  - `rm` and `rmdir` of a critical path, an `mv` that moves one away and an `rsync --delete` into one, behind wrappers such as `env -i` or `caffeinate` too, and through a symlinked parent (`rm -rf alias/objects` with `alias` leading to `.git`) (the workspace root or above it, `~`, `/`, `.git`, compared without case on a case-insensitive filesystem, a path the shell or another program decides: `$X`, `~user`, `{a,b}`, `xargs rm`, `find -delete`, `find -exec rm`, a wildcard over those) now ask in every permission mode, `bypassPermissions` and `acceptEdits` included, over any allow rule. A removal outside the workspace by a command without a sandbox, and `file_delete` of a path outside it, now ask in every mode but `bypassPermissions`. Both apply to tool calls only: plugin hook commands keep their behavior (`PermissionContext.removalChecks: false`).
  - `workspaceTools()` returns `delete_file` too (an edit, so it asks in `default` mode unless allowed), and harness agents get it.
  - Deviations from Claude Code, on the safe side: `failIfUnavailable` defaults to true once the sandbox is enabled, `allowUnsandboxedCommands` to false. Not supported and left out with a warning: TLS termination and credential masking (a `mask` entry is denied instead), custom proxy ports, the weaker isolation switches, Apple Events. A shell `rm` deletes for good, the trash is `delete_file`'s.

### Patch Changes

- Updated dependencies [[`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a)]:
  - @cogitator-ai/types@0.85.0

## 0.9.2

### Patch Changes

- Updated dependencies [[`74439c2`](https://github.com/cogitator-ai/Cogitator-AI/commit/74439c22cce3f000a35a104392b6d290dbb3327d)]:
  - @cogitator-ai/types@0.84.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445)]:
  - @cogitator-ai/types@0.83.0

## 0.9.0

### Minor Changes

- [#307](https://github.com/cogitator-ai/Cogitator-AI/pull/307) [`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6) - File checkpoints and a rewind that takes the conversation, the memory and the files back to an earlier message in one operation.

  An agent that edits a project changes files with its tools and its shell commands, and going back in the conversation left them as the agent made them. Now a run can take a snapshot of its workspace before every user message, and `cog.rewind()` restores it together with the conversation. Everything is off by default: without `checkpoints` no snapshot is taken, and a rewind restores files only when asked.

  Snapshots (types, core, sandbox):

  - `LocalWorkspace` implements `snapshot`, `restore`, `listSnapshots`, `deleteSnapshot`, and adds `pruneSnapshots(retention)` and `copySnapshot(id, target)`. Snapshots are content-addressed in `.cogitator/checkpoints`: sha256 blobs for file contents and directory trees, one manifest per snapshot. A file whose size, times, inode and mode did not change since the snapshot before is not read again, and a content or a directory that did not change is stored once, so a snapshot per message stays cheap on a real project (`snapshot.stats` says what was read and stored). Symlinks are recorded as links and never followed, modes are kept, a file that changes while it is read is read again, files over `maxFileBytes` (10 MiB) are skipped and listed in `skipped`. `restore(id, { dryRun })` writes through the workspace's safe placement (a temporary file with `O_NOFOLLOW` renamed over the path), removes what the snapshot did not have, opens for the time it runs a directory of the owner made read-only since (one of another user is refused up front, and a directory the restore replaced never gets its mode back), never touches excluded or skipped paths, checks every content against its hash before it changes anything, refuses with `BUSY` while a command of the workspace runs, and returns what it `restored`, `deleted` and `kept`. `LocalWorkspaceOptions.snapshots` sets `exclude`, `maxFileBytes`, a retention policy (`retain: { count, maxAgeMs }`) and `gcGraceMs` for the mark and sweep collection that `deleteSnapshot` and `pruneSnapshots` run.
  - The store is safe to keep and share: it is owner only (`0700` directories, `0600` files), blobs and directories are synced before a manifest names them and a blob is reused only at its stored size, names are kept as they are (`__proto__` included), files are hashed a chunk at a time, unreadable directories are recorded as skipped and protected, a file that keeps changing while read is skipped as `changing` instead of stored torn, and a restore plans every change first, so its dry run lists exactly what it then deletes. A restore keeps files made since that the snapshot could not have kept (over its size limit, unreadable) and always applies the default excludes, a dry run reports `busy` while commands of the workspace run, and stores are released when their workspaces are disposed. Several processes may share a store: snapshots, restores and copies leave markers in `locks/`, a collection takes `locks/gc.lock` and defers its sweep while a marker is there (`gc.deferred`), skips manifests whose trees cannot be read (`gc.unreadable`), and sweeps only the names the store gives in directories checked to be its own, never through a symlink. A failed retention prune no longer fails the snapshot before it, and copies between two stores in opposite directions no longer wait for each other.
  - `DockerWorkspace` removes in the container what a restore deletes and refuses with `BUSY` while commands or their process groups (kept in the background, or still stopping after SIGTERM) run there, holds its host for the whole restore (new `Workspace.holdForRestore`, which `LocalWorkspace` implements), and forwards `restore` with its options, `listSnapshots`, `deleteSnapshot` and `copySnapshot` to its host workspace, and exposes the host as `host`. `RemoteShellWorkspace` (E2B, Daytona, Vercel) keeps its tar snapshots with the same API, the modes of their directories too, so a restore plans a directory whose mode alone changed: `maxFileBytes` and `skipped`, `restore(id, { dryRun })` with the same result (a tar restore rewrites every file it holds, so `restored` lists them all).
  - New types: `WorkspaceRestoreOptions`, `WorkspaceRestoreResult` (with `busy` for a dry run), `WorkspaceSnapshotSkip` (`too-large`, `unreadable`, `changing`, `hard-link`, `unsupported-name` for a backslash in a name on Windows, which POSIX keeps), `WorkspaceSnapshotStats`, `WorkspaceSnapshot.maxFileBytes`, `WORKSPACE_SNAPSHOT_MAX_FILE_BYTES`, and `Workspace.copySnapshot?`. Remote restores keep directories that hold excluded entries and files over the snapshot's size limit.

  Checkpoints and rewind (types, core, config, memory):

  - `checkpoints: true | { enabled?, exclude?, maxFileBytes? }` on `CogitatorConfig` (with `rewindFiles?`), `AgentConfig` and `RunOptions`: a run whose workspace can snapshot takes `workspace.snapshot({ label: entryId })` before every user message it writes (the input and queued `steer`, `followUp` and `inject` messages) and names it in the entry, `metadata.fileCheckpoint` (`FILE_CHECKPOINT_KEY`, `FileCheckpointRef`, `fileCheckpointOf()`). The entry id is known before the entry is written, as `NewMemoryEntry` takes an `id` now. Changes made by shell commands between messages are caught too. The config package reads `checkpoints`.
  - `cog.rewind(threadId, toEntryId, options)` takes `RewindOptions` (`agents`, `memory`, `files`, `workspace`, `dryRun`, `force`) and returns a `RewindReport`: the `MemoryCascadeReport` with `conversation` (`rewound`, `cut`, `previousLeafId`), `files` (the restore result with the `entryId` whose checkpoint was restored and whether it is `exact`) and `runs` (`going`, `interrupted`, `paused`, `durable`). The files come from the checkpoint right after the point when only notes lie before the next user message, else from the nearest one before it. The message after the point is looked for on every branch of the thread, so a repeated rewind restores the same checkpoint. A checkpoint whose message could not be written is dropped, and a durable run that loses its lease while a checkpoint is taken writes nothing and drops it: the lease is checked right before every entry is added. Files are restored first, so a rewind that fails leaves the conversation as it was. `dryRun` changes nothing and reports what would change, `MemoryCascade.rewind` takes `{ dryRun }` for it.
  - `cog.forkThread(threadId, atEntryId, { newThreadId?, files?, workspace?, source?, agents?, force?, dryRun? })` forks a thread with its checkpoint references, and with `files` restores the fork's workspace to that point, copying the branch's checkpoints into it first when it is another workspace. `dryRun` returns a `ForkThreadPlan` without making the thread and leaves no copied checkpoint behind. Every check runs before the thread is made, so a refused fork leaves nothing, and a fork whose files fail to restore takes back the thread, its link and the copied checkpoints. The fork's copy of the point names the exact checkpoint of the files at it (`metadata.fileCheckpointAt`, `FILE_CHECKPOINT_AT_KEY`, `fileCheckpointAtOf()`) when it comes from the message after the point, so rewinds and forks of the fork restore it, and `MemoryAdapter.forkThread` takes `{ pointMetadata }` for that. `MemoryAdapter.forkThread` refuses a `newThreadId` that names a thread already, before it changes anything, and takes back a fork that fails on the way, deleting only the thread it made.
  - A rewind or a fork with files holds the thread and the workspace for the whole operation (runs asked for meanwhile wait), refuses while runs of other threads work in the same workspace or commands of the workspace run (new `ErrorCode.WORKSPACE_BUSY`, 409), never forces past a durable run another process holds while files are restored, validates the restore with a dry run before `force` stops anything, checks that the checkpoint is one the workspace keeps for this thread and entry (forged references are refused), and takes a safety snapshot first (`files.safetySnapshotId`) so it can be undone, kept when the restore fails unless the files are still those it holds. A tool call that goes on after its run stopped (regardless of its signal) keeps the workspace busy until it ends, and a forced rewind or fork waits for those calls (`toolSettleMs`), so a late write never lands over a restore. Runs on a side branch of the thread count as busy too, and so do runs in a workspace whose root holds the restored one or lies in it, also a root made later under a symlink. A restore that would change a file the safety snapshot could not keep (one it skipped, or one the workspace's own snapshot excludes leave out) is refused with `DENIED` before anything changes, snapshots honor `refuseHardLinks` (such files are skipped as `hard-link` and never read on restore), commands are refused while a restore changes the files, holds of a workspace are taken one at a time, a copy between stores marks the source store too, and remote restores leave alone everything under a skipped path. The safety snapshot covers every path the restore changes (the checkpoint's excludes, files as large as the largest one changed), and the checkpoint being restored is kept from the workspace's retention (`WorkspaceSnapshotOptions.protect`). Checkpoints follow the agent a run handed over to, approval hooks are raced against an abort like `onApproval`, and a tool asking to rewind its own run's thread gets a clear error. `cog.durableByDefault` says whether runs are durable by default.
  - A run aborted while `onApproval` (or `guardrails.onToolApproval`) waits for an answer now ends with the abort instead of waiting for the answer.

  CLI:

  - `cogitator rewind <thread> [entry]` lists the active branch of a thread of the project's registry, entries with a file checkpoint marked, or rewinds it: the dry run first, then a prompt (`--yes` without a terminal), with `--files`, `--no-memory`, `--dry-run`, `--force`, `--agent`, `--registry` and `--json` (which needs `--dry-run` or `--yes`). It warns that only durable runs of other processes are seen, and falls back to the only registry agent with a workspace for a thread whose agent has no configured id.

  Memory adapters (memory, test-utils):

  - Every built-in adapter keeps a caller-given entry id (`NewMemoryEntry.id`, letters, digits, `_` and `-`, at most 128) and refuses an id it keeps already. The adapter conformance suite has the case `entry-named-id`.

  Breaking changes and migration:

  - `Workspace.restore(snapshotId, options?)` returns a `WorkspaceRestoreResult` instead of `void`. A workspace of your own that implements `restore` returns `{ snapshotId, dryRun, restored, deleted, unchanged, kept }` and honors `dryRun`, callers that ignored the result need no change.
  - `WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE` is `['.cogitator/**', '**/node_modules/**', '**/.git/**']`, so snapshots of every workspace leave out installed dependencies and the git repository, and a restore leaves them alone. Install dependencies again after a restore that changed the lockfile, and use git itself for the repository.
  - Remote workspace snapshots skip files over 10 MiB by default: pass `maxFileBytes` to `snapshot()` to keep larger ones.
  - `cog.rewind()` drops the paused run and the durable runs of the thread (their checkpoints hold the conversation that was cut), so a paused run can no longer be resumed after a rewind of its thread. It refuses with `THREAD_BUSY` while a run goes on in the thread, here or as a durable run another process holds: wait for the run, or pass `force: true` to abort it first. It throws `VALIDATION_ERROR` for an entry that is not on the active branch before anything changes. The report it returns extends the `MemoryCascadeReport` it returned, so code that reads it needs no change.
  - `addEntry` keeps a caller-given `id`: code that spreads an existing `MemoryEntry` into `addEntry` (to copy it) now keeps its id, which fails with "already exists" in the same adapter. Leave `id` out of the copy, as `forkThread` does.
  - `ErrorCode` has a new member, `WORKSPACE_BUSY`: a `switch` over every code with no `default` needs a case for it.
  - `cog.rewind()` and `forkThread()` with files refuse while a run of another thread works in the same workspace (`WORKSPACE_BUSY`), and refuse a checkpoint the workspace does not keep for the thread (`VALIDATION_ERROR`): pass the workspace the thread ran in, and `force` to stop the other runs.
  - A memory adapter of your own that ignores `NewMemoryEntry.id` still works with checkpoints (the entry names its snapshot in metadata either way), but fails the new `entry-named-id` conformance case until it keeps the id.

### Patch Changes

- Updated dependencies [[`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6)]:
  - @cogitator-ai/types@0.82.0

## 0.8.11

### Patch Changes

- Updated dependencies [[`cb4a7fa`](https://github.com/cogitator-ai/Cogitator-AI/commit/cb4a7fa20594805d6bf150f680185cc07520fec0)]:
  - @cogitator-ai/types@0.81.0

## 0.8.10

### Patch Changes

- Updated dependencies [[`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4)]:
  - @cogitator-ai/types@0.80.0

## 0.8.9

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/types@0.79.0

## 0.8.8

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0

## 0.8.7

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0

## 0.8.6

### Patch Changes

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/types@0.76.0

## 0.8.5

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0

## 0.8.4

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0

## 0.8.3

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0

## 0.8.2

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0

## 0.8.1

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/types@0.71.0

## 0.8.0

### Minor Changes

- [#286](https://github.com/cogitator-ai/Cogitator-AI/pull/286) [`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2) - Remote workspaces: an agent's whole workspace, files and commands, in a cloud sandbox on E2B, Daytona or Vercel Sandbox, with the same behavior on every provider.

  - `E2BWorkspace`, `DaytonaWorkspace` and `VercelSandboxWorkspace` (sandbox) create their sandbox on first use, or reuse one by `sandboxId`, `sandbox` (id or name) or `name`, and release it in `dispose()` as `onDispose` says: `destroy`, `stop` (Daytona, Vercel) or `keep`. Their SDKs (`e2b` 2.28.1 or later, `@daytona/sdk`, `@vercel/sandbox`) are optional peer dependencies loaded on first use. Without the SDK, without credentials (`E2B_API_KEY`, `DAYTONA_API_KEY`, Vercel's OIDC token found by its SDK, or `VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`) or when the sandbox cannot be created, the first operation fails with a `WorkspaceError` of code `UNAVAILABLE` that says which, and an SDK that fails to load for another reason is reported with that reason. E2B and Vercel sandboxes get a `lifetime` (30 minutes) that the workspace pushes back while it is used. A Vercel sandbox created without a name is not persistent, `destroy` deletes the snapshots only it used, and `image` picks its image. Daytona commands get their `env` from a short-lived file of a private directory, so the values stay out of the command line Daytona records.
  - `RemoteShellWorkspace` (sandbox) is what they share, over a small `RemoteShellDriver` (connect, read and write bytes, run a program, start one with streamed output and stdin, release), so another provider is one driver away. Everything else runs as shell scripts in the sandbox: paths normalized against the root and resolved with `realpath -m`, so a symlink out of the root is refused with `OUTSIDE_ROOT`, also by the workspace's own directories, reads that copy at most one byte over `maxFileBytes` to a private file of the sandbox's temporary directory before they download (reads never write the root), atomic writes that keep the file's mode (uploads go through the temporary directory, and `.cogitator/snapshots` is checked to be a real directory of the root every time a script uses it), listings sorted like `LocalWorkspace` with `includeHidden`, `skipDirs`, `glob` and `limit` (sorted, cut and narrowed in the sandbox, 64 MiB at most), the trash in `.cogitator/trash`, the `rename` rules for `overwrite`, and `BUSY` while a command runs or kept background processes. Commands run under `setsid` in their own process group, reported with marker lines whose token comes on stdin: a timeout returns exit code 124 and kills the group, an abort rejects with `ABORTED`, `background: 'keep'` leaves background processes until `dispose()`, and output past `maxStreamBytes` (64 MiB) stops the command, since the SDKs keep whole outputs in memory. A group is only signalled while it still leads the session its command started.
  - Remote workspaces implement snapshots: `snapshot({ label, metadata, exclude })`, `restore(id)`, `listSnapshots()` and `deleteSnapshot(id)` keep tar archives in `.cogitator/snapshots` inside the sandbox, always without `.cogitator/**`, names that are not UTF-8 kept as they are and `maxSnapshotBytes` (1 GiB) as the cap, and a restore removes what was made since and leaves the excluded paths alone.
  - `shellQuote` and `shellCommand` (sandbox) build a shell line that passes every argument as it is, quotes, newlines, globs and leading dashes included.
  - `workspaceGlobMatcher` (types) is the glob matcher of `WorkspaceListOptions.glob`, now shared by every workspace. `LocalWorkspace` and `workspaceTools` (core) use it, with no change in what they match.

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0

## 0.7.0

### Minor Changes

- [#284](https://github.com/cogitator-ai/Cogitator-AI/pull/284) [`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83) - Workspaces: one directory an agent works in, with file access and commands that cannot leave it, locally or in a Docker container, and long tool results saved there instead of lost.

  - `Workspace` (types) is the interface: `id`, `root` and `cwd`, `withCwd(cwd)` for a view with another current directory, `read`, `readBytes` and `write` with size limits, `list({ recursive, glob })`, `stat`, `exists`, `mkdir`, `rename`, `remove({ recursive, trash })`, `exec(command, { cwd, env, timeout, signal, onStdout, onStderr })`, `contains`, `start` and `dispose`, and optional `snapshot`, `restore`, `listSnapshots` and `deleteSnapshot` (snapshots leave `.cogitator/**` out by default, see `WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE`). Paths are relative to the root, and a path that resolves outside it (`..`, an absolute path elsewhere, a symlink out, also a dangling one or one a command created) fails with a `WorkspaceError` of code `OUTSIDE_ROOT`. Every failure is a `WorkspaceError` with a typed `code`, `DENIED` for what the system or a policy refuses. Workspaces start themselves on first use, `start()` is optional, `dispose()` is the owner's.
  - `LocalWorkspace` (core) works in a directory of this machine. Only regular files are read and written (a FIFO or a device is refused before it is opened, files open with `O_NONBLOCK` and `O_NOFOLLOW` and are checked again once open). Writes are atomic and flushed: a temporary file in the same directory is renamed over the target, keeping its mode, so a crash never leaves half a file (see the sweep below) and a hard link to a file outside the root is replaced, not written through. A read-only file is refused (code `DENIED`) unless `force` is passed. `remove` and `rename` move the entry into `.cogitator/pending/` and check it is the one they resolved, and an entry only ever takes a name nothing else holds (a fresh random name in the verified directory, then a hard link or a rename onto nothing), so a directory swapped for a symlink cannot make them delete, replace, pull in or push out anything outside the root. An entry pulled in by such a swap is never moved to a path resolved anew: it stays quarantined in `.cogitator/pending/`, named in the error and logged, never deleted. `remove` and `rename` refuse with the new code `BUSY` while a command the workspace started is still running or left processes behind. Leftover temporary write files are swept on start once untouched for `leftoverAge`, and entries an interrupted move left are recovered into `.cogitator/pending/recovered-*`, never deleted. `.cogitator` and `.cogitator/pending` are off limits to the workspace's own operations, and errors no longer carry host paths. `refuseHardLinks` refuses to read hard-linked files (off by default, pnpm stores hard-link `node_modules`). `remove(path, { trash: true })` moves entries to `.cogitator/trash/<time>/`, and `.cogitator/` gets a `.gitignore` with `*`.
  - `LocalWorkspace.exec` runs each command in a process group of its own with only the environment a shell needs (no API keys, `HOME` included), streams and caps its output, and on a timeout or an abort sends SIGTERM to the group and SIGKILL after `exec.killGrace`, also to background processes the shell left behind. A call returns when the command exits, also when a background process still holds its output: `background: 'kill'` (default) stops the rest of the group then, `'keep'` leaves it running until `dispose()`, which kills every group the workspace started that still has processes. `exec.launch` changes what is spawned, for OS sandboxes such as `sandbox-exec` or `bwrap`. On Windows commands run with `cmd.exe /d /s /c` and only the command itself is killed.
  - `DockerWorkspace` (sandbox) runs the commands of a host workspace in one long-lived container with an init process, created on first use and removed in `dispose()` (which also disposes the host), the host root bind-mounted at `/workspace`, files read and written through the host workspace and its guard, `remove` and `rename` done in the container where no symlink reaches the host, and paths under `/workspace` mapped to the root. Each command leads its own process group, reported by a marker line taken out of stderr wherever it appears (its token comes on stdin, out of the command's reach), and signalled with the container's `kill` on a timeout or an abort, so background and `env -i` processes go too, and the call returns at most `killGrace` plus a second later. `background` works as for `LocalWorkspace`, and an abort while the command is starting is honored. Starting removes containers of the same root left by a gone process of this machine, matched by host name, boot and PID namespace. Defaults are 2 GB, 2 CPUs and 512 processes, Docker API failures come as code `IO`, no Docker as `UNAVAILABLE`.
  - `createSandboxContainer` (sandbox) is the container setup the pool and `DockerWorkspace` share. The pool's containers are created as before.
  - `AgentConfig.workspace` and `RunOptions.workspace` (the run's wins) reach tools as `context.workspace` and middleware as `RunMiddlewareContext.workspace`. A handoff target brings its own, an agent called with `agentAsTool` gets the caller's unless it has one, `invokeTool` takes `workspace`, and `resume()` takes it again like `deps`.
  - `workspaceTools(workspace?, options?)` (core) gives an agent `read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep` and `run_command` (with `background` to keep what it starts with `&`), named apart from the global `file_read`, `file_write` and `exec` built-in tools so both sets fit in one agent. `read_file` pages by line (`offset`, `limit`) and, inside a line too long for one page, by `column`, and reports CRLF endings. `edit_file` refuses binary and non-UTF-8 files and keeps CRLF endings when the strings use plain newlines. `grep` matches whole lines in a worker thread with `grepTimeout` per file, so a pattern such as `(a+)+$` fails instead of blocking every run, takes `includeHidden`, and searches what it listed when the listing hits its limit (`incomplete`). Only `run_command` asks for approval by default.
  - A tool result longer than the model may read is saved in full to `.cogitator/tool-results/<runId>/<toolCallId>.txt` in the workspace the agent's `read_file` reads (its bound workspace, else the run's), and the model gets the cut preview with the path and how to page through it. Saved results of runs older than `limits.toolResultRetention` (7 days by default) are removed when a new one is saved, and ids that are not safe file names get a short hash so two never share a file. Without one, with a `read_file` of another origin, or when saving fails (logged), the result is only cut, as before. `toolResultPath()` gives the path.
  - The assistant preset of `create-cogitator-app` builds its workspace tools on `LocalWorkspace` and `workspaceTools`. Its tools are renamed: `file_read` is now `read_file`, `file_list` is `list_files`, `file_write` is `write_file`, and `edit_file`, `glob` and `grep` are new. `file_exists` and `file_delete` are gone, the assistant no longer deletes files. `write_file` and `edit_file` still need approval.

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0

## 0.6.25

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0

## 0.6.24

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0

## 0.6.23

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0

## 0.6.22

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0

## 0.6.21

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/types@0.64.0

## 0.6.20

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/types@0.63.0

## 0.6.19

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0

## 0.6.18

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0

## 0.6.17

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0

## 0.6.16

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0

## 0.6.15

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0

## 0.6.14

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0

## 0.6.13

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0

## 0.6.12

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0

## 0.6.11

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0

## 0.6.10

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0

## 0.6.9

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0

## 0.6.8

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0

## 0.6.7

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0

## 0.6.6

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0

## 0.6.5

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/types@0.48.0

## 0.6.4

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/types@0.47.0

## 0.6.3

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/types@0.46.0

## 0.6.2

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/types@0.45.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0

## 0.6.0

### Minor Changes

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - A sandboxed execution stops when its signal aborts. `SandboxExecutionRequest` takes `signal`: aborting it kills the native process group, ends the Docker exec and removes its container (an aborted container is never reused), or closes the WASM plugin, which ends its worker. The result is a failure naming the reason, `Execution aborted: <reason>`, and a signal that is already aborted runs nothing. A Docker execution aborted while its container is still being pulled or started fails at once, and the container is removed when it comes up. A WASM execution aborted while its module downloads fails at once too.

  Core passes the run's signal to sandboxed tools, so cancelling a run stops a Docker or WASM tool instead of leaving it running until its own timeout, and the call fails with the abort reason, as a native tool does.

  The container pool removes a container once even when an aborted execution releases it while the pool shuts down, and `destroyAll()` waits for removals still in progress and for containers still starting, which it removes, so no container outlives the pool.

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/types@0.43.0

## 0.5.16

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0

## 0.5.15

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/types@0.41.1

## 0.5.14

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0

## 0.5.13

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/types@0.40.0

## 0.5.12

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/types@0.39.0

## 0.5.11

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0

## 0.5.10

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0

## 0.5.9

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A WASM tool run that traps or panics, times out, or writes more than the sandbox keeps now comes back as a tool error with the reason, instead of an empty successful result the model would guess around. `SandboxExecutionResult` has a new `truncated` flag the WASM executor sets when it cuts the output.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0

## 0.5.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0

## 0.5.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0

## 0.5.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2

## 0.5.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/types@0.33.1

## 0.5.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0

## 0.5.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 0.5.1

### Patch Changes

- [`e150c83`](https://github.com/cogitator-ai/Cogitator-AI/commit/e150c83e8c9dc1bd9961d0a3413cf31d0d9175f1) - A WASM module given as a package path, such as `@cogitator-ai/wasm-tools/wasm/calc.wasm`, now resolves from your application. The executor resolved it from `@cogitator-ai/sandbox` itself, which does not depend on the package that ships the module, so with pnpm's strict layout (or any install that does not hoist) the call failed with `WASM module not found` unless a launcher happened to set `NODE_PATH`. Package paths are now resolved from the working directory, then from the entry script's directory, then from the sandbox package as before. Relative paths are read from the working directory, and a module that cannot be found is reported with the directory it was looked up from.
- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 0.5.0

### Minor Changes

- db2e373: Sandbox fallbacks are explicit and safe. `sandbox.allowNativeFallback: false` refuses to run Docker-sandboxed tools on the host when Docker is unavailable (the fallback stays on by default, with a loud warning). WASM tools no longer fall back to Docker or native execution, which failed with "Command array is empty". Every Docker execution now gets a container no code ran in before (a fresh one is kept warm), so files and processes cannot leak between runs or users; `pool.reuseContainers: true` restores reuse.

### Patch Changes

- db2e373: The Docker executor finds the daemon the way the `docker` CLI does: it tries the endpoint of the current Docker context (`DOCKER_CONTEXT` or `~/.docker/config.json`), then the sockets of Docker Engine, Docker Desktop, OrbStack, Colima, Rancher Desktop and rootless Docker, so `isDockerAvailable()` no longer reports `false` when only a non-default context is running.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0

## 0.4.4

### Patch Changes

- b8c7c3d: `memoryPages` now limits the WASM module's own memory, not only the memory Extism uses for input and output: the module's memory section gets that maximum before it loads, so `memory.grow` past it fails inside the module, and a module that needs more to start is refused. Modules given by URL are fetched by the executor so the limit applies to them as well.
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 0.4.3

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 0.4.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 0.4.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 0.4.0

### Minor Changes

- `wasm.memoryPages` caps Extism's allocations; dockerode 5 (peer range ^4 || ^5).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 0.3.0

### Minor Changes

- `wasm.memoryPages` (default 256 = 16 MB) is now passed to Extism as `memory.maxPages`, capping the memory Extism allocates for plugin input, output and vars. It was previously ignored.
- The WASM executor could not load any local module: it passed a raw Buffer as the Extism manifest ("Expected wasm key in manifest", reproduced). Its timeouts could never stop a spinning module, and concurrent calls hit 'plugin is not reentrant'. Rewritten: correct manifests, a worker per plugin (runInWorker) terminated on timeout, a per-key plugin pool with LRU, and executor-level defaults and allowedHosts honored. The native executor ran join(' ') through the shell. That broke argument boundaries (the package's own example failed with a shell syntax error), allowed shell injection through args, passed the full host process.env (secrets) to executed code, ignored stdin, and hung on grandchildren after a timeout. Fixed: exact argv for multi-element commands (single-element commands still use the shell), minimal env, stdin piped, whole process group killed. Docker fixes: the pool reused containers across different security settings (host mounts or bridge network handed to an isolated request); multiplexed frames split across chunks were dropped; host config ignored DOCKER_HOST; network.allowedHosts was silently ignored (now rejected), dns wired; 0MB/negative limits silently ran unlimited (now rejected); containers that failed to start leaked; the cleanup interval kept the process alive; containers are now labeled. Manager: concurrent initialize() created duplicate executors; fallbacks skipped the manager defaults.

  **Breaking changes**
  - NativeSandboxExecutor: multi-element commands run with exact argv and no shell (e.g. ['echo', '$VAR'] no longer expands; use ['echo $VAR'] or ['sh','-c',...]). Only PATH/HOME/temp/locale/Windows system variables are inherited from process.env.
  - DockerSandboxExecutor: network.allowedHosts is rejected with an error instead of being ignored. Zero/negative memory or CPU limits are rejected. Without docker options, Dockerode defaults (DOCKER_HOST) are used instead of a hard-coded /var/run/docker.sock.

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

## 0.2.29

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 0.2.28

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 0.2.27

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 0.2.26

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 0.2.25

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 0.2.24

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 0.2.23

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 0.2.21

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 0.2.20

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 0.2.19

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 0.2.16

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 0.2.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 0.2.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 0.2.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 0.2.9

### Patch Changes

- abdafa3: fix: properly terminate Docker containers on timeout

  Previously, when a timeout occurred in Docker executor, only a flag was set but the exec process continued running in the background. Now:
  - Uses Promise.race to immediately resolve on timeout
  - Closes stream when timeout fires
  - Marks timed-out containers as corrupted so they're destroyed instead of returned to pool
  - Uses exit code 124 (standard timeout exit code)

## 0.2.8

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 0.2.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 0.2.5

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 0.2.0

### Minor Changes

- Add error logging for Docker/WASM initialization failures in SandboxManager
- Add error logging for container stop/remove failures in ContainerPool
- Add error logging for WASM plugin close failures
- Fix WASM cache cleanup: plugin entries now deleted even if close() throws
- Add command validation in native and docker executors (reject empty arrays)

### Tests

- Add test for empty command array validation

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
