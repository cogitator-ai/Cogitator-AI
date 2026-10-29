# @cogitator-ai/memory

## 0.29.7

### Patch Changes

- Updated dependencies [[`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c), [`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c)]:
  - @cogitator-ai/types@0.89.0

## 0.29.6

### Patch Changes

- Updated dependencies [[`ac89cec`](https://github.com/cogitator-ai/Cogitator-AI/commit/ac89cec9ea8d288afd58f7dbbe1531f8425d757a)]:
  - @cogitator-ai/types@0.88.0

## 0.29.5

### Patch Changes

- Updated dependencies [[`e2f1c87`](https://github.com/cogitator-ai/Cogitator-AI/commit/e2f1c8793df4d1fdb06e9d8a5d0e8be984cbd2d2)]:
  - @cogitator-ai/types@0.87.0

## 0.29.4

### Patch Changes

- Updated dependencies [[`2bb4941`](https://github.com/cogitator-ai/Cogitator-AI/commit/2bb4941dc40889458575db0893766c233dabaaaf)]:
  - @cogitator-ai/types@0.86.0

## 0.29.3

### Patch Changes

- Updated dependencies [[`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a)]:
  - @cogitator-ai/types@0.85.0

## 0.29.2

### Patch Changes

- Updated dependencies [[`74439c2`](https://github.com/cogitator-ai/Cogitator-AI/commit/74439c22cce3f000a35a104392b6d290dbb3327d)]:
  - @cogitator-ai/types@0.84.0

## 0.29.1

### Patch Changes

- Updated dependencies [[`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445)]:
  - @cogitator-ai/types@0.83.0

## 0.29.0

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

## 0.28.0

### Minor Changes

- [#305](https://github.com/cogitator-ai/Cogitator-AI/pull/305) [`cb4a7fa`](https://github.com/cogitator-ai/Cogitator-AI/commit/cb4a7fa20594805d6bf150f680185cc07520fec0) - Durable agent runs that a crash or a deploy does not lose, queue jobs that go on from their last step, and streams a client resumes with `Last-Event-ID` in every server adapter.

  Everything is off by default: without `durable` a run keeps no checkpoint while it goes on, without `resumableStreams` an adapter streams and aborts a run on disconnect as before. No breaking changes. `ErrorCode` has new members (`RUN_LEASED`, `RUN_NOT_FOUND`, `RUN_SUSPENDED`), so a `switch` over every code with no `default` needs cases for them.

  Durable runs (core, types, config):

  - `CogitatorConfig.durable: true | { enabled?, store?, leaseMs?, owner? }`, `AgentConfig.durable` and `RunOptions.durable` (the run's wins, then the agent's). A durable run keeps a `RunCheckpoint` with `status: 'running'` after every model turn and every batch of tool calls: counters, usage and cost, the turn going on, permission mode and rules, budgets, hook and stop hook state, project instructions, the command, the messages queued on its handle, answered interrupts and delegated children. Each step writes what is new: the conversation's start once (`DurableRunRecord.base`), messages the thread's log holds as references to their entries (`RunCheckpoint.compact`), and between steps only small journal marks (`DurableRunMark`: a tool call started, returned, the queue changed). A run started from a tool call of another run is never durable on its own, its caller is.
  - `cog.recoverRuns({ agents, resume?, filter?, options? })` continues the runs a stopped process left running and returns a `RunHandle` for each (`RecoveredAgentRuns`: `resumed`, `skipped`, and `found` with `resume: false`). The conversation comes back from the checkpoint and the log, entries written after the last checkpoint are taken in (a logged model turn is not asked for again, a logged final answer ends the run), a tool call that returned keeps its result and never runs twice, one that was running gets `OUTCOME_UNKNOWN`, one that never started after a lost call gets `ABORTED_BEFORE_DISPATCH`, and queued messages are delivered. `cog.recoverRun(agent, runId, options)`, `cog.discardRun(runId)` (answers the open calls and forgets the run) and `cog.durableRuns(filter)` (with `held`) act on single runs.
  - Leases: a process holds each durable run it runs (`acquire`, `renew` at every step and a third of the way through `leaseMs`, default 60 000) as its `owner` and the instance of its `Cogitator` (`DurableRunHolder`), so neither two processes nor two live runtimes of one owner continue one run, and a runtime reserves a run before it takes its lease, so two recoveries of one run at once continue it once. Writes are fenced: `save`, `append` and `delete` succeed only for the holder of the lease. A process that lost its lease stops the run with `RUN_LEASED` before its next tool or write. A run aborted with a `CogitatorError` of code `RUN_SUSPENDED` keeps its checkpoint and lets its lease go, for another process to take at once. A run is taken from another holder only once its lease ran out: the default `owner` is unique to the runtime (host name, process id, random), and `takeoverOnRestart: true` takes back at once the runs of a restarted process with a stable owner it guarantees unique per live process (a pod name). Journal marks carry ids and a mark a retried write kept twice is read once, a retried Redis save of a base extension that already landed is taken as done, and a run handed over writes what was queued before it lets go. Every write of a durable run to its thread first confirms its lease, so a process that lost it never adds a stale answer, queued messages carry ids (two follow-ups with one text stay two), a follow-up's extra iterations survive a recovery, and a retried `discardRun()` answers the open calls once. A run takes its lease before it writes anything (a run id another run holds leaves the thread untouched), the answer entries of durable runs keep the run's usage (`metadata.runUsage`) so a recovery restores it, and forgetting or redacting entries of a thread drops its durable runs with its paused one, so forgotten text never comes back from a checkpoint. A recovery holds its lease while it waits for a run slot and drops itself when the checkpoint moved on meanwhile, a recovery that never starts lets the run go, a new thread the store creates belongs to the run's agent and user, and messages queued before a run's first checkpoint go with that checkpoint. A checkpoint is forgotten only for an end the run reached itself, never after an error of the store, a lost lease or a recovery that gave up, and a recovered run hears at its stop about the background agents it lost, also after a second stop of its process (they stay in its checkpoints until reported). Tool calls the run's budget charged are journaled (`DurableRunMark` of kind `charged`) and answers keep the budget state (`metadata.runBudget`), so a recovery charges what the lost step spent, and `discardRun()` lets its lease go and stops renewing it. Leases count epochs (`DurableRunLease.epoch`, `acquire()` answers the epoch or false): a takeover writes a fence entry, log entries of durable runs name their epoch (`metadata.durableEpoch`), and recovery, history and the context builder drop an older epoch's entry that landed after a newer one began (`withoutStaleDurableEntries` and `DURABLE_FENCE` in `@cogitator-ai/memory`). A tool starts once what its budget charged is written, a discard that lost its run writes nothing and fails with `RUN_LEASED`, and the Redis heartbeat renews the expiry of every key of the run, its thread index too. A run forgets its checkpoint only once it reached an end of its own (`finish()` of the keeper): a configuration error or a recovery that gave up keeps it. Fences are also kept in the thread's metadata (one `durableFence.<runId>` key per run, `durableFencesOf()`, so two runs fenced at once keep both), a new lease epoch is always above the epoch its thread fenced (`acquire({ above })`, so a run id used again stays visible), so a reader that only reads conversation entries still drops a late write, a recovered answer keeps its finish reason (`RunCheckpoint.finishReason`: `truncated`, `blocked`), and a background agent that ended before the run read it stays in checkpoints with how it ended. A tool whose run was aborted while its charge was being written does not start, a hand-over or a lost lease records no session spend (the recovery does, once), a follow-up replayed from the journal lets the model call the same tool again, a recovery whose lease could not be taken back stops renewing it, and a run that could not forget its checkpoint lets its lease go.
  - Store failures: a failed write is tried again (`storeRetries`, default 3, with a growing pause). A store that keeps failing suspends the run with `RUN_SUSPENDED` and its last checkpoint kept, never deleted, or with `onStoreError: 'continue'` the run goes on without checkpoints.
  - Checkpoints stay small: a checkpoint after every model turn (the final answer included), tool calls kept by their place in the messages (`compact.calls`), and without a memory log only the new messages added to the base (`DurableRunRecord.baseFrom`). Answers a recovery wrote for the calls of a lost step are found again in the log by a later recovery, never written twice. Background subagents a run had going (`RunCheckpoint.background`) are reported to the recovered run as failed with an unknown outcome in `task_output`, `send_message` and the stop notice. `resume()` refuses a checkpoint of a run left running (use `recoverRun()`). A queued message the run delivered is journaled with what it added (`DurableRunMark` of kind `delivered`), an answer whose stop had not settled runs its stop processing again on recovery (`RunCheckpoint.stopping`), the closing turn at `maxIterations` is kept (`RunCheckpoint.closingTurn`), and a process that lost its lease writes nothing more to the thread and runs no `afterRun` hooks. The config package reads `durable.onStoreError` and `durable.storeRetries`.
  - Stores implement `DurableRunStore`: `InMemoryDurableRunStore` (the default without memory), `ThreadDurableRunStore` (the default with a memory adapter, one `durableRuns` map in the run's thread metadata that a finished run leaves empty, one process at a time since a memory adapter cannot lock) and `RedisDurableRunStore` (atomic leases, each checkpoint with its base, journal and indexes in one script, runs indexed per thread, keys under `{cogitator}:durable-runs` that expire `ttl` after the last write, 7 days by default, any number of processes, `@cogitator-ai/redis` clients and ioredis).
  - `RunOptions.runId` names a run (`RUN_LEASED` when a durable run with that id is kept). Entries of durable runs carry `metadata.durableRun`. The config package reads `durable` (`DurableRunsConfigSchema`).

  Workers:

  - `WorkerConfig.durable` runs agent jobs as durable runs named after the job (`job:<jobId>`, `durableJobRunId()`): the attempt after a crash or a shutdown, on any worker, recovers the run and goes on from its last step instead of running the job again. The pool's own Cogitator keeps the runs in its Redis, a Cogitator you pass needs a shared store. Job ids a run id cannot hold (slashes, spaces, other scripts, more than 190 characters) are named by their hash (`job:sha256-<hex>`). On `stop()` and `forceStop()` the pool aborts durable runs with `RUN_SUSPENDED`, so they hand over at once, and a job BullMQ hands on while its run is still held waits for the lease to run out (`moveToDelayed`) instead of using up an attempt. `processAgentJob(payload, runtime, { durable: true })` for processors called directly.

  Resumable streams (server-shared, express, fastify, hono, koa, tetsu, next):

  - Every adapter takes `resumableStreams?: boolean | { store?, maxEvents?, retentionMs?, maxStreams?, detachedTimeoutMs? }`. With it on, every SSE event of `/agents/:name/stream` and `/agents/:name/resume/stream` carries an `id` (`<streamId>:<seq>`), a client that disconnects no longer stops the run, and the same route with `Last-Event-ID` (or `?lastEventId=`) replays what the client missed and follows the run to its end. Only the user who started a stream may reconnect (`404 STREAM_NOT_FOUND` otherwise, also for an unknown or expired stream), a reconnect behind the kept events gets an `error` event `STREAM_RESUME_GAP` telling the client to fetch the thread, and a run nobody follows for `detachedTimeoutMs` (5 minutes) is stopped and ends with `STREAM_ABORTED`. Events live in a pluggable `StreamReplayStore` (`InMemoryStreamReplayStore` by default, bounded by `maxEvents`, `retentionMs` and `maxStreams`), a shared store with pub/sub lets a reconnect land on any process.
  - server-shared: `ResumableStreams`, `StreamReplayStore`, `InMemoryStreamReplayStore`, event id helpers (`formatStreamEventId`, `parseStreamEventId`, `lastEventIdOf`), `encodeSSE(data, id?)`, OpenAPI docs of `Last-Event-ID` (`SwaggerConfig.resumableStreams`), and conformance cases for resumable streams with a reconnect step (`ConformanceCase.reconnect`, `conformanceReconnectRequest`, `parseSseFrames`). Stream writers of every adapter take an optional event id in `send(event, id?)`.
  - next: `createChatHandler` and `createResumeHandler({ stream: true })` take `resumableStreams` (a reconnect resends the request body, `beforeRun` identifies the caller). `useCogitatorChat` reconnects a stream that drops mid-run with `Last-Event-ID` and continues the message in place (`reconnect: { attempts, delayMs }`, on by default, only effective when the server sends ids, `false` turns it off), and its SSE parser reads `id:` lines per the SSE spec.
  - Cancel and caller binding: `DELETE /agents/:name/stream/:streamId` (Next: `DELETE` on the handler route with `?streamId=`) stops the run of a stream on whatever process runs it, which ends with `STREAM_CANCELLED`, and `useCogitatorChat` sends it on `stop()`, `reload()` and every interrupt. A stream is bound to the whole identity `auth` established (user id, roles, permissions, metadata), or to the key of the `owner` option, and reconnects and cancels also ask `authorizeThread` about the stream's thread (`403 THREAD_FORBIDDEN`). Prefer the `Last-Event-ID` header over `?lastEventId=`, which lands in URLs and logs.
  - A stream whose run goes on is never evicted: a new one past `maxStreams` is refused with `503 STREAM_LIMIT_REACHED`. The `until` option (and Fastify's `onClose`) stops the runs of resumable streams when the server shuts down. Followers detect lost events by sequence number (`STREAM_RESUME_GAP`), a slow reader holds at most `maxEvents` events and catches up from the store, the clients of the process that runs a stream get its last event even when the store fails, and `useCogitatorChat` reports a stream that keeps ending before `finish` as an error once its reconnects run out.
  - Next: a reconnect or cancel reads no body and runs neither `beforeRun` nor `deps`, the stream is bound to `resumableStreams.owner(req)`, required next to `beforeRun`. `StreamReplayStore.create` answers `false` when it has no room without evicting a running stream, and stores implement `cancel` and `onCancel`. Conformance: `runConformanceCase` and `sendConformanceRequest` drive a case and its follow-ups (`followUps`), with cases for live tail, disconnect, cancel, owner binding, `authorizeThread` and the stream limit.
  - A Next run whose thread `beforeRun` sets is bound to that thread for reconnects and cancels, a client that cancels the response body lets its stream go so the run can count as detached, Fastify stops resumable runs in `preClose` so closing no longer waits on clients that still read (Express, Hono and Koa: abort `until` before `server.close()`), and a stream the store created but could not open no longer holds a `maxStreams` slot.
  - A resumable stream hands an event to the clients of the run's process only once the store kept it, so a reconnect with any id a client got finds it, also on another process and with a slow store.
  - `useCogitatorChat` takes a stream as complete once `finish` or `error` arrived, so a connection that drops before `[DONE]` no longer reconnects or ends in an error.
  - Express, Fastify and Koa notice a client that left while the route was still awaiting (a slow stream store, the `deps` hook): its resumable stream lets go so the run counts as detached, and other streams and runs stop as they should.
  - The Express CORS middleware allows `Last-Event-ID` in preflights by default, so a client on another origin can reconnect to a resumable stream. `CORS_ALLOWED_HEADERS` from `@cogitator-ai/server-shared` lists every header a client of the API sends, for CORS middleware of your own.
  - With a shared stream store, a run counts its detached time from the last client that left on any instance (`detachedAt` of the store record, stamped with the new `now` clock), so a client that came and went on another instance no longer lets the run stop early.
  - `useCogitatorChat` cancels the run of a resumable stream it handed over with `interrupt` or `rollback` when the request that took over is refused, instead of only aborting its fetch.
  - WebSocket transports keep their own frame protocol and are not resumable: use SSE for runs a client must be able to rejoin.

### Patch Changes

- Updated dependencies [[`cb4a7fa`](https://github.com/cogitator-ai/Cogitator-AI/commit/cb4a7fa20594805d6bf150f680185cc07520fec0)]:
  - @cogitator-ai/types@0.81.0

## 0.27.1

### Patch Changes

- Updated dependencies [[`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4)]:
  - @cogitator-ai/types@0.80.0

## 0.27.0

### Minor Changes

- [#280](https://github.com/cogitator-ai/Cogitator-AI/pull/280) [`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Send Ollama custom headers from the CLI and the embedding service.

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/types@0.79.0

## 0.26.7

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0

## 0.26.6

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0

## 0.26.5

### Patch Changes

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/types@0.76.0

## 0.26.4

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0

## 0.26.3

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0

## 0.26.2

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0

## 0.26.1

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0

## 0.26.0

### Minor Changes

- [#288](https://github.com/cogitator-ai/Cogitator-AI/pull/288) [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b) - Fix extraction and hierarchical compaction of dense windows, which failed with "The extraction model did not answer with memory items after 3 tries" and "The summarizer did not answer with the atoms of a chapter after 3 tries".

  A window of a long list of facts can hold more items than one extraction answer has room for (8000 tokens), so the answer was cut inside its JSON array, and the extractor read no item from it and asked again the same way three times. `MemoryExtractor` now keeps the items a cut answer finished and asks the model to go on after the last one, up to `EXTRACTION_CONTINUATIONS` (4) times (`extractionContinuationPrompt`), so the window is read whole. `parseExtraction` finds the array past text and brackets around it, such as a message number the model mentions (`[3]`), keeps the finished items of a cut array and leaves out an element that is not JSON instead of the whole answer. A continuation that brings no array ends the window with the items read so far.

  Compaction chapters had the same faults: a chapter call asked for no token limit of its own, so it got the backend's default (4096 on Anthropic), and a dense chapter of 4000 tokens can need more. A chapter call now asks for up to 8000 tokens, like extraction, and `CompactionService.chapterAtoms` keeps the atoms a cut answer finished and asks the summarizer to go on after the last one, up to 4 times, the array of atoms is found past text and brackets around it, and an element that is not an atom (such as one of another kind) is left out instead of failing the whole answer. `parseBrief` reads its array the same way and keeps the cards of a cut answer, without a second call, since the brief runs before the turn within a time limit. Consolidation still takes only a whole answer on purpose: its decisions are made as a set.

  A continuation leaves out only what repeats an earlier answer exactly (the same words and quotes), so a value or a status said again from a later message stays the latest. The array search reads at most four times the length of the answer, however many brackets it holds, and an empty array before the real one no longer hides it.

- [#288](https://github.com/cogitator-ai/Cogitator-AI/pull/288) [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b) - Memory defaults chosen on the memory benchmarks, and a shadow mode for extraction.

  - Behavior change: `memory.contextBuilder` without a `strategy` now uses `hybrid` when `memory.embedding` is set, and `recent` otherwise as before. A runtime with embeddings and no strategy keeps the newest turns as history and also recalls the earlier turns and memory items that match the turn, which embeds every message of a thread once, in the background. On seven long-memory datasets `hybrid` averaged 44.9% against 18.0% for `recent`, as much as `relevant` at three quarters of its cost. A `strategy` you set is kept, so set `strategy: 'recent'` to keep the old behavior.
  - `memory.extraction.mode` (types, core, config): `apply` by default, or `shadow`, which writes every new item as `suggested`, so it reaches no context, no recall and no fact until it is reviewed (`MemoryItems.query` with `statuses: ['suggested']`) and activated (`MemoryItems.activate`). It is `MemoryItems({ shadow: true })` (memory), which also leaves the confidence of other opinions alone. Extraction stays off by default and the docs recommend starting with `shadow`. Compaction stays off by default too.
  - Scaffolded projects with a lasting store (`sqlite`, `postgres`, `redis`, `mongodb`) get long-term memory in `cogitator.yml`: the provider's embedding model in `memory.embedding` with the `hybrid` strategy (`recent` with Anthropic, which has no embedding model), and `memory.files` for the agents' notes. On Ollama the embedding model is pulled with the chat model. The `assistant` preset is among them. Only Postgres keeps the vectors: on SQLite, Redis and MongoDB the message index lives in the process, so after a restart (`cogitator dev` restarts on every change) each thread's messages are embedded again the first time it is used, one embedding per message. That cost is cents beside the gain of `hybrid`, so those templates keep it, and the generated AGENTS.md says so.

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/types@0.71.0

## 0.25.6

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0

## 0.25.5

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0

## 0.25.4

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0

## 0.25.3

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0

## 0.25.2

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0

## 0.25.1

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0

## 0.25.0

### Minor Changes

- [#269](https://github.com/cogitator-ai/Cogitator-AI/pull/269) [`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698) - Voice replies are spoken while the model generates them, and an interrupted reply leaves only what the user heard in memory

  `VoiceAgentRunner` gains an optional `stream(input, context)` that returns a `VoiceTurn`: an `AsyncIterable<string>` of text deltas that may return the answer as its return value, with an optional, idempotent `settle({ spoken, interrupted })`. `createCogitatorRunner` implements it with `stream: true` and `onToken`. Its stream ends with the final model turn, so the last sentence does not wait for what the run does afterwards, and text the model says before a tool call ends with a line break so it is spoken on its own while the tool runs. A `PipelineSession` with such a runner splits the deltas into sentences and synthesizes them in order through `tts.streamSynthesize`, so the first audio goes out before the answer is complete. The splitter, exported as `SentenceSplitter`, keeps abbreviations, initials after a capitalized word, decimals and list numbers at the start of a line inside their sentence, keeps markdown marks after a stop with it, splits at `?!`, ellipses before a new sentence, CJK full stops and line breaks, flushes a tail without punctuation at the end and cuts a piece longer than `maxSentenceLength` (default 250, at least 20) on whitespace. Sessions emit a new `agent_response_delta` event for each piece of spoken text, forwarded to `VoiceAgent` clients as `{ type: 'agent_response_delta', text }`. `VoicePipeline.process()` returns one buffer and keeps using `run()` with a single `synthesize()` call.

  When a streamed turn stops early (an interruption, a barge-in, closing the session, or a model or TTS error), the session settles it with the sentences whose audio was sent to the client in full. The server cannot know how much of that audio the client played. With `createCogitatorRunner` the thread then holds what was spoken: the answer's assistant message is replaced by its spoken part with `metadata.interrupted: true`, or removed when nothing was spoken, and a run stopped before it saved an answer gets its spoken part saved after its `interrupt` event. A run that fails after saving its answer has that answer replaced too, and its error is reported once the turn was spoken. Text said alongside tool calls stays as the run saved it, and a turn spoken in full leaves the thread exactly as before. The thread is only changed while the turn's last entry is still its active leaf: when another run or your code wrote to the thread meanwhile, it is left as it is, so no newer message is hidden. The runner fixes the thread as soon as the run saved its answer, without waiting for its `afterRun` hooks, settles the turns of one thread one after another and starts a run once the previous run of its thread saved its answer, waiting for the rest of that run at most `tailTimeout` ms (a new `createCogitatorRunner` option, default 10 000), the next streamed turn of a session starts once the previous one settled, and both that wait and `close()` are bounded by `settleTimeout` (default 10 000 ms).

  `bargeIn: true` on `VoicePipeline` or a pipeline-mode `VoiceAgent` lets VAD speech during a reply stop it and start listening, with streaming runners and plain ones. It is off by default, since without echo cancellation on the client the agent's own voice would interrupt it.

  A realtime `VoiceAgent` without `tools` now gives the model the agent's own tools through the runner's new `realtimeTools()`. `createCogitatorRunner` builds them with `createRealtimeTools` and the agent, so each call goes through `cogitator.invokeTool` with the gates a text run of the agent applies: approvals, the guardrails (built with the agent's model unless `guardrails.model` is set), the agent's `wrapToolCall` middleware, the sandbox and `tool.timeout`, with the session's thread id. Unlike a text run, a tool that needs approval is refused unless `agentTools.onApproval` or `guardrails.onToolApproval` approves it (the model reads that it needs approval), and a realtime session sets no `maxIterations`. A runtime without `invokeTool`, such as a custom `CogitatorLike`, gets no tools. `agentTools` passes options, and `agentTools: false` turns it off. Explicit `tools` still win, `tools: []` included. `createRealtimeTools` takes `agent`, a `userId` that can be a function of the call's context, and an `onApproval(request, context)` that also gets the call's session.

  Core: `RunOptions.onMemoryEntry` is called with each entry a run saves to its thread, also for a run that is aborted or fails, before its promise rejects (a failed run now waits for its pending memory writes before it rejects). A throwing or rejecting callback is logged. `invokeTool` takes `agent`: the guardrails are built with its model unless `guardrails.model` is set, as for a run of it, its middleware wraps the call after the Cogitator's, and its id and name name the call. `ToolApprovalRequest` gains optional `agentId`, `threadId` and `userId`, set for `invokeTool` calls.

  Types and memory: `historyMessage(entry)` and `INTERRUPTED_REPLY_NOTE`. An assistant entry with `metadata.interrupted: true` reaches the model with `[interrupted by the user]` after its text, both from plain history and from the context builder, so the model does not take a cut-off reply for a finished one.

  Migration:

  - A pipeline `VoiceAgent` or `PipelineSession` built with `createCogitatorRunner` now streams. TTS is called once per sentence instead of once per answer, and `agent_response` can arrive while the first sentences are already playing. It carries what `run()` returns, the final model turn, as before.
  - A middleware that rewrites a turn's text in `afterModel` without `holdsStream: true` is heard before its rewrite in a streamed voice turn. Set `holdsStream: true` on it to speak only the final text.
  - A realtime `VoiceAgent` built with `createCogitatorRunner` and no `tools` now exposes the agent's tools to the model. Pass `agentTools: false` to keep the old behavior, and `agentTools: { onApproval }` for tools that need approval.
  - `maxSentenceLength` below 20 is rejected.
  - `RealtimeToolsOptions` moved to the package's shared types and is exported from the same place as before.

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/types@0.64.0

## 0.24.5

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/types@0.63.0

## 0.24.4

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0

## 0.24.3

### Patch Changes

- [#251](https://github.com/cogitator-ai/Cogitator-AI/pull/251) [`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc) - Every server adapter keeps one contract: operator run limits, thread authorization, an anonymous policy, one error taxonomy with Retry-After, thread pages and request deps

  `limits: { swarmTimeout, workflowMaxIterations, workflowMaxConcurrency }` on Express, Fastify, Hono, Koa and Tetsu caps what a request may ask a run for. A request gets the smaller of what it asked and the cap, one that asks for nothing gets the cap, over HTTP, streams and WebSocket alike, and the OpenAPI document shows each cap as the default of the field it caps. Next serves no swarms or workflows, so it has no limits.

  `authorizeThread(auth, threadId)` is asked about every thread a request names (agent runs, streams and resumes, swarm runs, the thread routes, WebSocket runs, and the run events a WebSocket subscription receives) on top of the ownership check, and a refusal answers `403 THREAD_FORBIDDEN` before any run starts. On Next it is `authorizeThread(req, threadId)`, asked about the thread the run goes to. `anonymous: 'deny'` answers `401 UNAUTHORIZED` to a caller without a user id, also on paths the server does not know (Tetsu leaves unknown paths and methods to its app, which answers them before any hook), while health, readiness and the docs stay open. Under `'allow'` an unknown path answers `404 NOT_FOUND` in the envelope, and on Koa a wrong method on a known path now answers that `404` too instead of `405`, while `OPTIONS` on a path the router serves answers `204` with the methods it serves in `Allow`, so the router needs no `allowedMethods()`. The default `'allow'` keeps today's behaviour, and on Next the caller is the `userId` that `beforeRun` returns. On Koa the WebSocket server takes the router's `anonymous` unless its own options set one. Tetsu keeps answering `401` when `authenticate` returns `undefined`, as before.

  Errors follow one taxonomy from `@cogitator-ai/server-shared` (`describeHttpError`): a `CogitatorError` answers with its own status or the one of its code, a swarm that ran out of time with `504 RUN_TIMEOUT`, and any other error with `500 INTERNAL_ERROR` without its text, in JSON, stream events and WebSocket frames alike. Answers carry `Retry-After` in whole seconds, at most a day, when the provider said when to retry. Express, Fastify, Hono, Koa and Next answer in the `{ error: { message, code } }` envelope, and Tetsu in its framework's `{ status, message, error }` with the same statuses and codes. Express and Fastify now honour `CogitatorError.statusCode`, and a failed workflow answers with the status of the error that failed it.

  Breaking for `@cogitator-ai/next`: error answers move from the flat `{ error, code }` to the `{ error: { message, code } }` envelope of the other adapters. `useCogitatorChat` and `useCogitatorAgent` read both shapes, so update a client of your own that reads `error` as a string. A `beforeRun` error reaches the client with its message and `code` only when it sets a client error `status` (`400` to `499`) or is a `CogitatorError`, and any other hook error answers `401 Unauthorized` without its text.

  Breaking for `@cogitator-ai/tetsu` streams: an unexpected error in an SSE stream or WebSocket frame now carries `INTERNAL_ERROR`, as on every other adapter, instead of `INTERNAL_SERVER_ERROR`.

  `GET /threads/:id` takes `limit` (1 to 1000) and `cursor`: it answers the newest `limit` messages of what is left and a `nextCursor` for the page before them, until a page reaches the start of the thread. Entries that share one time are counted, so none is skipped or repeated across pages. Without `limit` it answers the whole thread as before, and `updatedAt` is the time of its newest entry when that is later than the thread record. A bad `limit` or `cursor` answers `400 INVALID_INPUT`, or `422 VALIDATION_FAILED` on Tetsu. Next serves no thread routes.

  `deps: (request) => deps` gives agent runs, streams and resumes their `deps` (`context.deps` of their tools) for the request, never read from the body. Over WebSocket, Fastify and Hono build them for every run from the upgrade request, Express and Koa from their own `websocket.deps(req)` hook that takes the raw upgrade request, and Tetsu once per connection at the handshake. On Next a `deps` that `beforeRun` returns wins over the hook.

  `@cogitator-ai/server-shared` exports `RunLimits`, `checkRunLimits`, `swarmTimeoutWithin`, `workflowOptionsWithin`, `AuthorizeThread`, `AnonymousPolicy`, `admitCaller`, `authorizeThreadAccess`, `threadForbidden`, `UNAUTHORIZED`, `describeHttpError`, `cogitatorErrorStatus`, `INTERNAL_ERROR`, `errorEnvelope`, `errorHeaders`, `retryAfterSeconds`, the types `ErrorEnvelope` and `HttpErrorDescription`, `parseThreadPageQuery`, `readThreadPage`, `MAX_THREAD_PAGE_LIMIT`, the types `ThreadPage` and `ThreadPageQuery`, and `SwaggerConfig.limits`. Its conformance cases now cover Retry-After, hidden internal errors, anonymous callers, `THREAD_FORBIDDEN` on runs, streams, resumes and the thread routes, thread pages and deps. `ConformanceRuntime` takes the case so it can fail runs and hold thread entries, and `ConformanceResponse` carries headers. The adapters export their guards (`createAnonymousGuard` on Express, `createAnonymousMiddleware` on Hono and Koa) and Fastify its request schema factories (`workflowRunRequestSchema`, `swarmRunRequestSchema`, `ThreadPageQuerySchema`, `ThreadResponseSchema`), and Tetsu `ThreadQuery` and `DepsBuilder`.

  `@cogitator-ai/memory`: the Redis adapter reads `getEntries` with `before` and `limit` backwards a page at a time from `before`, so reading a long thread one page after another no longer reads everything before each page. Entries of one time written before entries had a `seq` now keep one order (by id) in the Redis and Postgres adapters, whichever way they are read, the order their tree migration already chains them in. MongoDB and SQLite keep the order they were added in. `@cogitator-ai/test-utils` adds the `entry-limit-before` case to the memory adapter conformance cases.

## 0.24.2

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0

## 0.24.1

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0

## 0.24.0

### Minor Changes

- [#248](https://github.com/cogitator-ai/Cogitator-AI/pull/248) [`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3) - Memory files read only what stands. `MemoryFileAdapter.findFileHeads` gives the newest version of each scope and path a filter and a branch see, and `MemoryFiles` lists, views and indexes files through it, so a turn no longer reads the whole history of every file. Postgres and SQLite find the heads in SQL, InMemory, MongoDB and Redis in process, and MongoDB now asks only for batches holding a version of a scope the reader sees. A change that finds, once kept, a file of its own under another file or with files under it, which writers in two processes can make at the same time, is taken back, its own versions withdrawn (`withdrawFileVersions`, a new optional store method every built-in adapter has, `MemoryFileVersion.withdrawn`), and refused so the writer tries again. `fileHeads` finds heads in process for a store of your own, and the conformance kit checks `findFileHeads`.

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0

## 0.23.0

### Minor Changes

- [#247](https://github.com/cogitator-ai/Cogitator-AI/pull/247) [`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682) - Forgetting a conversation now forgets what memory made of it. Every summary, memory item, fact, graph node and edge, vector and memory file keeps the entries it stands on, and deleting, redacting or rewinding those entries follows that lineage into every store, so a user who asks to be forgotten is not remembered through a fact or a playbook rule written from what they said.

  - Core: `Cogitator.forget({ entryIds } | { threadId } | { userId }, { agents?, graph?, keepReplies? })` deletes entries, a thread, or every thread of a user (by its `metadata.userId`, deleted whole) with the messages the user wrote in threads of others and everything kept for the user, with all memory derived from them. `Cogitator.redactEntries(entryIds, { agents?, graph?, keepReplies?, reason? })` replaces what entries said with `[redacted]` while they keep their place in the thread, and takes away what was derived from them the same way. `Cogitator.rewind(threadId, toEntryId, { agents? })` rewinds a thread, and the memory items that stood only on the entries after `toEntryId` become `stale`. Each returns a `MemoryCascadeReport`. `MemoryCascadeCall` is the type of the options of `forget` and `redactEntries`, and `rewind` takes only `agents`.
  - Core: items, files, facts and the graph are kept by the memory id of an agent (its configured `id`, else its name), so every run now notes in the thread's metadata the memory id of its agent and of every agent it hands over to (`metadata.memoryAgentIds`), and the user it ran for (`metadata.memoryUserIds`). A cascade goes through the memory of the agents a thread names. A thread written before this release names only the agents that ran in it since, so pass `agents` (agents or their memory ids) for the ones before, and for a user without threads. The lists are read again just before each write, which narrows, but does not close, the window in which two runs writing at once keep only one name. Facts are reached when the memory adapter is a fact store, graph nodes and edges only with `graph` passed.
  - Core: all three methods throw `CogitatorError` (`VALIDATION_ERROR`) when no memory is configured or the agents to go through are not known (a thread that names none and no `agents`, or a user without threads), `redactEntries` also when the adapter cannot redact, and `rewind` also when the adapter has no branches. A store that fails part of the way throws its own error, and the call can be made again, as derived memory goes before the entries.
  - Core: `forget` and `redactEntries` drop the paused runs of the threads they touch (`threads` and `threadsChanged` in the report), also from an app's own `runCheckpoints` store, as their messages would bring back on resume what went.
  - Core: memory extraction and compaction after a run stop before their next model call once the run's branch is no longer the thread's active one, such as after a rewind or a checkout while they work, so nothing is learned or summarized from a branch the conversation left. Extraction also writes nothing a window's answer gave once the branch was left, and drops the items whose entries were forgotten or redacted while the model answered.
  - Memory: `MemoryExtractor.extract` takes `beforeWindow(own)`, which stops the extraction before a window's model call when it returns `false`, and `beforeWrite(items)`, which returns the items of a window to write. `CompactionService` refuses to write a summary whose entries were deleted or redacted while it was written.
  - Memory: `MemoryCascade` (`deleteEntries`, `redactEntries`, `deleteThread`, `deleteUser`, `rewind`) does the work over the stores it is given (`{ memory, items?, files?, graph?, facts?, embeddings? }`) for the agents in `{ agentIds, keepReplies? }`. With deleted or redacted entries go their copies in forks (a thread lists its forks in `metadata.memoryForks`, each copy names its original in `metadata.forkOf`, forks of forks followed), the compaction summaries that cover them (the entries before `firstKeptEntryId` on their branch, or, when that entry is gone, those at or before the last entry left out) or quote them in an atom, so the next compaction writes them again, legacy summaries kept as messages (`metadata.compactionSummary`, adapters without branches) whose atoms quote them, the memory items, facts and graph nodes and edges that stand only on them (those that stand on more lose the quotes of them, and the entities no item is about any more are deleted), the vectors of the entries, the summaries and the facts that go (deleted from `embeddings` by source, whether or not a message index listens), the memory file versions written at them, and every version of an observation or a playbook that names an item or a lesson that went. A memory file whose version in front a cascade redacted is then deleted, so its path leaves the listing once no version on any branch still holds its text and its history keeps the redacted versions. A playbook in front is first written again without the rules that stood on such a lesson, and an observation is written again by the next refresh. A cascade looks for derived memory again after the entries went, so an item written meanwhile goes too.
  - Memory: a user message takes its replies (the entries after it on every branch up to the next user message, events such as a model change or an approval among them), as an answer may say again what it said, unless `keepReplies`. Redacting deletes an event entry among the entries or their replies (`model_change`, `approval`, `interrupt`, `label`, `custom`, or a `compaction` among the ids) instead and lists it in `entries.deleted`. A rewind marks the items stale before it moves the thread, so one that failed can be made again (a rewind the store refuses leaves them as they were), and a thread that stands at `toEntryId` already is left as it is. `deleteThread` also purges the items and entities and redacts the memory file versions kept for the thread alone, and takes the copies of its entries in its forks. `deleteUser` deletes every thread of the user whole, the messages others wrote in them too, and the messages the user wrote in threads of others (those that list the user in `metadata.memoryUserIds`) with their replies, listing every thread to find them, purges the items and entities and redacts the memory file versions of the user's scope, and deletes the facts and graph nodes and edges whose `metadata.userId` is the user and the embeddings with that metadata (`deleteByFilter`). `MemoryCascadeReport` lists `threadsChanged`, the threads that lost or had redacted some of their entries.
  - Memory: every built-in adapter (in-memory, SQLite, Postgres, Redis, MongoDB) has `redactEntry(entryId, { at, reason? })`: the entry's text, the arguments of its tool calls and the results of its tools become `[redacted]`, its tool calls lose their replay state and argument error, a user message loses its sender `name`, its place, parent, role and call ids stay, `metadata.redacted` records when and why, an event entry such as a compaction is refused, and a missing entry gives `null`. Change listeners hear `{ type: 'entry-redacted', entryId, threadId }`, and the message index drops the entry's vectors. `forkThread` lists the fork in the origin's `metadata.memoryForks` and no longer copies the paused run of its origin. `redactedEntry`, `REDACTED_TEXT`, `FORKS_KEY` (`'memoryForks'`) and `MEMORY_USERS_KEY` (`'memoryUserIds'`) are exported. `MemoryItems.reviseEvidence(itemIds, keep)` keeps the evidence pieces `keep` takes and returns the ids it changed.
  - Types: `MemoryAdapter.redactEntry?`, `EntryRedaction` (`at`, `reason?`), and `entry-redacted` among the `MemoryChange` events, so an exhaustive `switch` over `MemoryChange` needs the new case.
  - Test utils: the memory adapter conformance suite checks `redactEntry` in the scenario `redacts-an-entry-in-place`, also that a redacted entry keeps its parent and that an event entry is refused.

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0

## 0.22.0

### Minor Changes

- [#246](https://github.com/cogitator-ai/Cogitator-AI/pull/246) [`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76) - Memory works between runs, not only while a run builds its context. A brief hands a turn a few cards of what memory holds for it, each quoting its source, observations keep what memory makes of each entity next to the facts, and a consolidation pass in the background marks repeats stale and folds lessons into a playbook a few edits at a time. Every piece asks a model and checks what it answers before anything is kept, and all of them are off unless set.

  - Core: `memory.brief` (`model`, `maxCards` from 1 to 4, `timeoutMs` 4000, `maxTokens` 600, `prompt`, a value outside these throwing when the runtime builds the brief). Before the first model call of a run a cheap model reads the 12 best sources memory finds for the input, earlier turns of the run's branch and the memory items the run sees, ranked as `hybrid` recall ranks them, and writes cards, each a `constraint`, `knowledge`, a `consequence` or an `open_thread` quoting its source. Only cards whose quote the source holds word for word, spacing and case aside, go into the turn's memory context, marked as a hint and never into the system message. A timeout, a failure, a run without memory or nothing found leaves the turn as it was. `memoryBriefMiddleware(config, deps)` is the middleware behind it.
  - Core: `memory.observations` (`model`, `maxEntities` 3, `minItems` 3, `prompt`). After a run, in the background, the observations whose facts changed are written again as memory files under `/memories/observations/`, each statement citing the items it stands on, and a turn whose input names an entity, or that recalls one of its items, gets up to three of them next to the facts. Observations reach a turn only with `memory.contextBuilder` set, and are written either way.
  - Core: `memory.consolidation` (`model`, `everyRuns` 20, `afterCompaction` true, `maxChanges` 10, `maxSubjects` 10, `playbook` `apply`, `shadow` or `false`, `showPlaybook` true, `prompt`, `afterConsolidate`). Every `everyRuns` runs of a thread, and after `memory.compaction` compacted it (a compaction that changed nothing starts none), a pass marks as stale the items a model finds to repeat or contradict a newer one, asking about at most `maxSubjects` subjects, the oldest first, and going on where it stopped the next time, folds new `active` lessons, never one from a tool or a page, into `/memories/playbook.md` in at most three edits, then writes the observations. Every run then sees the playbook in its memory context as a hint, up to 4000 characters, while `showPlaybook` is on, which alone decides it: `playbook: false` only stops new lessons from reaching it. Passes run in the background one at a time per memory scope, no run waits for them, their model calls count in the cost router but not in a run's usage, and `close()` stops the passes under way. `memoryUpkeepMiddleware(config, deps)` is the middleware behind observations and consolidation, `upkeepScope` the scope memory items of a run belong to, and `CONSOLIDATION_STATE` the thread metadata key that counts runs.
  - Core: `Cogitator.consolidateMemory(agent, { userId?, threadId?, since? })` runs a pass now, such as from a worker while the agent is idle, and returns what it changed. When `report.dedupe.complete` is false a cap stopped the look for repeats, and calling again with `since: report.dedupe.through` goes on from there. With the `user` extraction scope (the default) it needs a `userId`, or a `threadId` for the memory of runs without a user, with `thread` a `threadId` (even with a `userId`), and with `agent` nothing. It throws `VALIDATION_ERROR` when neither `memory.consolidation` nor `memory.observations` is set, or when memory keeps no memory items. A pass on demand asks `consolidation.model` for repeats and lessons and `observations.model` for observations, each falling back to the agent's model (`llm.defaultModel` when the agent has none), while a pass after a run falls back to the model the run ended on.
  - Core: the memory tool refuses every change of `/memories/playbook.md`, `/memories/playbook.next.md` and anything under `/memories/observations/`, a rename into them included, with `<path> is kept by memory itself and is read-only here`, and views them as usual. A version of the playbook or of an observation a model wrote (`author: 'model'`) is never shown to runs or read as an observation, only those memory itself or a user wrote. With `security.pii` the model calls of the brief, the observations and the consolidation, like those of memory extraction and compaction, are masked as a run's own calls are, since they go through the same routed backend. In `redact` mode nothing is restored, so placeholders such as `[EMAIL_1]` end up in what memory keeps (items, observations, the playbook, summaries), numbered per call.
  - Memory: `MemoryBriefer` writes the cards of a brief from a model's answer, keeping only those whose quote of at least three words holds, the prompt telling the model the sources are data (`parseBrief`, `briefBlock`, `BRIEF_PROMPT`, `MAX_BRIEF_CARDS`).
  - Memory: `MemoryObservations` keeps observations of entities as memory files (`refresh`, `read`), each with a fingerprint of the items it was written from, so it is written again only once they change, and deleted once its entity has fewer than `minItems` facts that hold. A statement naming an item the model was not given is dropped, and facts that gave no observation are not asked about again in the process until they change. `ContextBuilderDeps.observations` shows them to a turn.
  - Memory: `MemoryConsolidator` consolidates one scope's memory. `dedupe` marks as stale (never deletes) the items of exactly the scope a model groups as repeating or contradicting another one about the same entity, never an item more trusted than the one kept and, for a contradiction, only items said before it, with the reason in `metadata.staleBecause`, a group naming an item the model was not shown refused whole, and returns `{ stale, complete, through? }`, `through` saying where a later dedupe that a cap stopped goes on `since`. `foldLessons` folds `active` lessons, oldest first and 20 a fold, into the playbook in at most three edits, so a lesson a model wrote stays out until `MemoryItems.activate` makes it `active` and one from a tool or a page never gets in, and an answer the model did not finish folds nothing, each adding a rule or rewriting one rule, so the playbook is never written over whole, every fold a new version of the file. A playbook every user of the agent shares (a scope without a user, project or thread, as with `memory.extraction.scope: 'agent'`) takes only `system` lessons in `apply` mode, since one user's lesson would reach every other user, and `shadow` drafts the rest for review. Lessons are ordered and folded by when they were activated (`MemoryItems.activate` keeps `metadata.activatedAt`), else by when they were recorded, so a lesson activated after a fold is still folded. A fold builds on the newest version of the playbook memory or a person wrote, skipping one a model wrote, and `promotePlaybook` refuses a draft a model wrote. With `mode: 'shadow'` the edited playbook goes to `/memories/playbook.next.md`, and `promotePlaybook` makes it the playbook only when the playbook did not change since.
  - Memory: `MemoryFiles.put(access, path, text, expectedSha256?)` writes a whole file, created when it does not exist, failing when the file no longer stands as the caller read it. `MemoryItems.markStale(itemIds, because?, onlyFrom?)` returns the ids it marked (a report lists only those), keeps `because` in the items' `metadata.staleBecause`, and with `onlyFrom` leaves an item whose status is no longer one of those as it is. `MemoryFileAccess.reserved` lists paths no change may touch, and `MEMORY_RESERVED_PATHS` names the ones memory writes itself. `inert` is exported.
  - Config: `MemoryBriefConfigSchema`, `MemoryObservationsConfigSchema` and `MemoryConsolidationConfigSchema` validate `memory.brief`, `memory.observations` and `memory.consolidation`.
  - Types: `MemoryConsolidationReport.playbook` is `{ path, editCount, lessonIds }` and `MemoryConsolidationReport.dedupe` is `{ complete, through? }`. `MemoryBriefConfig`, `BriefCard`, `BriefCardKind`, `MemoryObservationsConfig`, `MemoryConsolidationConfig`, `MemoryConsolidationReport`, `StaleMark`, `MemoryConfig.brief`, `MemoryConfig.observations` and `MemoryConfig.consolidation`, `RunMiddlewareContext.memoryAgentId`, and `observations` among the sources of `ContextBuildError`.

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0

## 0.21.0

### Minor Changes

- [#244](https://github.com/cogitator-ai/Cogitator-AI/pull/244) [`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627) - Agents search their memory themselves and keep notes in memory files. The memory search tools find earlier turns and memory items with the same search the `hybrid` context recalls with, a citation lock keeps an answer to what the run opened, and `memory.files` gives every agent a `/memories` directory it edits with the commands of Anthropic's memory tool, native on Claude and a plain tool everywhere else.

  - Core: `createMemorySearchTools({ memory, agentId, items?, embedding?, messageIndex?, timeZone?, placeOf? })` makes `search_memory` (earlier turns of the branch the run stands on, the entries the run saved itself left out, and memory items in one ranked list, through `MemoryRetriever`, with dates in the given time zone), `open_turns` (turns whole with the turns around them) and `list_entities` (the people, places and things memory knows, with how many items are about each). Results carry references to cite, `[item:<id>]` for an item a search returned and `[turn:<id>]` for a turn `open_turns` opened. `Cogitator.memorySearchTools(memoryAgentId)` builds them over the runtime's store, memory items, embedding service and message index, and throws `VALIDATION_ERROR` without memory. `MEMORY_SEARCH_TOOLS` names them.
  - Core: `memoryCitations({ tools?, onUncited? })` is a run middleware that takes out of a final answer each `[turn:<id>]` or `[item:<id>]` the run's memory tools never handed out, and calls `onUncited` with them. References are read only from the `ref` fields of the tools' results, never from text quoted inside them, and an answer's references are read in lists, with spaces, in capitals and in fullwidth brackets. An answer without references is left as it is, what a run opened is read back from its tool results too, so a resumed run still knows it, and the middleware holds the stream.
  - Core: `recall` of `createMemoryTools` ranks memory items with `MemoryRetriever` when it is given the thread store (`memory`), by their words, the entities they name and the graph around them, instead of matching every word of the query.
  - Core: with `memory.files` every agent a Cogitator runs gets the `memory` tool (`memoryFileTool`, `MEMORY_FILE_TOOL`): `view`, `create`, `str_replace`, `insert`, `delete` and `rename` under `/memories`, with the answers and errors of Anthropic's memory tool, kept under the agent's memory id. The files the run sees are listed in its memory context, each with its size and first line, up to `indexChars`. A tool of the agent's own named `memory` takes its place, a store that keeps no memory files is warned about once, and unless `scope` is `agent` the tool refuses a run with neither a user nor a conversation.
  - Core: `ToolConfig.providerTypes` and `ToolSchema.providerTypes` name a tool's type in a provider's own catalog. The Anthropic backend sends such a tool as that type instead of its schema, so Claude 4 and later get the memory tool as `memory_20250818`, older Claude models get its schema, and every other backend sends the schema as before.
  - Memory: `MemoryFiles` reads and changes memory files as the tool does (`run`, `view`, `create`, `strReplace`, `insert`, `delete`, `rename`, `list`, `read`, `history`, `redact`, `index`). Every change is a version of its own, never overwritten. A run sees the files of its user, its thread and the agent, the narrowest scope winning, and in its own thread only the versions written on its branch. A change goes into the run's scope, or the scope with every limit of the version it changes (and of a moved file's source), and names that version (`previousId`). One change keeps at most 8 MiB. An edit of a file another writer changed since it was viewed fails, two writers never add the same version, a change of many files is added whole or not at all, `readOnly` refuses every change, paths outside `/memories`, control characters, names past 255 characters, a file under a file, NUL characters and files over 1 MiB (`MAX_FILE_BYTES`) are refused, an edit, deletion or rename of a file changed since the run viewed it fails, and `redact` replaces the content of a file's versions with `[redacted]`, following the file's own history across renames, never into another file that took an old path, and in every scope of the agent with `everyScope`, while its history stays. `MemoryFileAccess.observe` hears of the version each command showed or wrote, which the tool keeps for its edit lock. A refused command throws `MemoryFileError` with the message the model reads.
  - Memory: every built-in adapter keeps memory file versions (`MemoryFileAdapter`): InMemory in process, SQLite in a `memory_file_versions` table, Postgres in `<schema>.memory_file_versions`, MongoDB in `<prefix>file_batches` (the versions of one change in one document) and `<prefix>file_places` (a place a dead writer never published is taken again after a minute), and Redis as hashes never under the thread `ttl`. `isMemoryFileAdapter`, `memoryPath`, `MEMORY_ROOT`, `MAX_FILE_BYTES`, `REDACTED_CONTENT`, `sha256Of`, `matchesFileFilter`, `byFileVersion` and `fileKeyOf` are exported for stores of your own.
  - Memory: `MemoryRetriever`, `analyzeQuery`, `timeExpressionOf`, `MIN_COSINE`, `RELATIVE_COSINE` and their types (`Retrieval`, `RetrievalRequest`, `RetrievedEntry`, `RetrievedItem`, `QueryAnalysis`, `QueryType`) are exported, the search of `hybrid` recall as its own class.
  - Memory: the Postgres schema moves to version 4. The first `connect()` after upgrading creates the new `memory_file_versions` table, empty, and changes nothing else, so nothing is migrated.
  - Config: `memory.files` (`MemoryFilesConfigSchema`): `scope` (`user`, `agent` or `thread`), `readOnly` and `indexChars`, a whole number above 0.
  - Types: `MemoryFileVersion`, `MemoryFileFilter`, `MemoryFileAdapter`, `MemoryFileAuthor`, `MEMORY_FILE_CONFLICT`, `MemoryFilesConfig` and `MemoryConfig.files`, and `ProviderToolTypes` on `Tool`, `ToolConfig` and `ToolSchema`.
  - Test utils: `memoryFileAdapterConformanceCases` checks a store of memory files against the contract the built-in ones keep: versions read back field for field, a taken place refused with `MEMORY_FILE_CONFLICT`, also when writers race for it, a refused batch keeping nothing, the filters and their order, redaction, deletion and copies.

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0

## 0.20.0

### Minor Changes

- [#227](https://github.com/cogitator-ai/Cogitator-AI/pull/227) [`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Readiness checks and memory adapter health check contract ([#103](https://github.com/cogitator-ai/Cogitator-AI/issues/103)).

  - Add optional `healthCheck(): Promise<MemoryResult<void>>` to `MemoryAdapter` in `@cogitator-ai/types` and implement it for all five built-in memory adapters (in-memory, redis, postgres, sqlite, mongodb) using lightweight, non-mutating checks.
  - Add shared readiness check logic in `@cogitator-ai/server-shared` with a 3-second timeout per check. Adapters without `healthCheck()` report `unchecked` and fail open, and unconfigured memory does not fail readiness.
  - Update Express, Fastify, Hono, and Koa server adapters to check readiness against memory, returning HTTP 200 when ready and HTTP 503 on failure without exposing internal driver or network details.
  - Add `health-check` scenario to memory adapter conformance suite in `@cogitator-ai/test-utils`.
  - Update OpenAPI specification for `/ready` endpoint with `ReadinessResponse` schema.

- [#240](https://github.com/cogitator-ai/Cogitator-AI/pull/240) [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7) - The `hybrid` context strategy recalls what a turn needs from the whole thread and from memory items: the newest turns stay as history, where the prompt cache serves them, and a search of memory in channels brings older turns and items into the turn's memory context.

  - Memory: the `hybrid` strategy keeps the newest entries as history (`recent`, as the `recent` strategy does) and searches the older turns and the memory items the run's agent (under its memory id and its runtime id), user and thread see for the turn, one current state per slot as the facts choose it. What it finds goes into the `recall` partition (60% of the budget for `hybrid` unless the config sets a share, what it leaves unused going to the history), best first, under `Earlier in this conversation:` (each turn dated in the thread's time zone, with the turn next to it that makes it readable) and `From memory:` (each item with the interval it held when it no longer holds, or the date it is about, to the precision it was said with). An item the `facts` partition kept is not repeated, and `BuiltContext.recalled` (`{ entries, items }`) gives what was sent. An entry recalled this way is not in `dropped.entries`. `hybrid` needs a `currentInput` and searches without vectors when there is no `embeddingService`, and a turn that is small talk is not searched.
  - Memory: the search reads the turn without a model, as a `temporal`, `update`, `aggregate`, `preference` or `general` question with the time it names, and finds turns by their vectors (a cosine of 0.45 or more and 0.6 of the best), by BM25 over the thread, by the time the turn names and by the entities of memory it names, and items by BM25, by the vectors of their content (each item embedded once by the builder and kept, since items never change), by those entities, by the time they are about, by a personalized PageRank walk over the graph of items and entities, and turns through the evidence of the best items. Questions about time or many things search the past states of items too. The channels are fused by reciprocal rank with weights for the kind of question, reranked by the share of the input's words a hit holds, biased a little toward recent turns and toward items sent to a model more often, and laid out for diversity (MMR).
  - Memory: `ContextBuilderDeps.reranker` (any `Reranker`) reorders the best 30 hits of the search. A reranker that fails leaves the order as it was, with a `relevance` error.
  - Memory: `BuildContextOptions.asOf`, the moment the turn is read at (now by default): the time a turn names is resolved from it, and the facts and recalled items are read as of it. `ContextBuilderConfig.timeZone` (UTC by default, the constructor throws on a name that is not an IANA zone) and `BuildContextOptions.timeZone` (the thread's, ignored when not a valid zone) set the calendar of recalled dates and of the time a turn names.
  - Memory: `MemoryItems.noteRetrieved(itemIds, at?)` counts items as sent to a model once more (`timesRetrieved` one up, `lastRetrievedAt` set) in one step of the store, through `MemoryItemAdapter.countRetrieved`, which every built-in store has. A store without it has each item read again and written back under its agent's lock, as `purge` now runs too. Every built-in store keeps the two fields.
  - Memory: `MessageIndex` takes `vectorsKept`, about how many vectors it keeps, those of the threads used least lately dropped and indexed again when a build uses them. `InMemoryEmbeddingAdapter` indexes its embeddings by source and by thread, so replacing a source's vector and searching one thread no longer scan the whole store, and `MessageIndex` reads stored vectors in batches.
  - Core: with `relevant` or `hybrid` and `memory.embedding`, every memory gets a message index: in the embedding store (Postgres or `memory.qdrant`), else in process, the `memory` adapter always in process, and a lasting store without an embedding store keeps up to 50,000 vectors, of the threads used lately. `Cogitator.indexMemory(threadId)` embeds every entry of a thread the index has not reached, a page of 500 at a time, and returns once the vectors are stored, such as after an import (`MessageIndex.index`, which fails when the store refuses a vector). It does nothing without an index.
  - Core: `RunOptions.asOf` passes the moment of the turn to the context builder, and a run passes its thread's `metadata.timeZone`. The builder's `timeZone` defaults to `memory.extraction.timeZone`. `memory.reranker` reorders the hits of `hybrid` recall.
  - Core: a run counts the memory items it sent to the model, its facts and recalled items, once it finishes or pauses for approval, in the background, one count after another. A failure is logged, and `close()` waits for the counts.
  - Config: `memory.contextBuilder.timeZone` is validated as an IANA time zone.
  - Types: `MemoryItem.timesRetrieved` and `lastRetrievedAt` (not part of `NewMemoryItem`), the optional `MemoryItemAdapter.countRetrieved`, `BuiltContext.recalled`, `ContextBuilderConfig.timeZone`, `MemoryConfig.reranker` and `RunOptions.asOf`.
  - Test utils: the `item-round-trip` case of `memoryItemAdapterConformanceCases` checks that `timesRetrieved` and `lastRetrievedAt` come back, the latter as a date, and `count-retrieved` checks `countRetrieved` of a store that has it.
  - Cost: `relevant` and `hybrid` now embed every entry of a thread once, in the background, on every memory, not only the newest 200 entries a build scored. That is one embedding per message, plus one embedding of the input per turn.
  - Breaking: `hybrid` no longer mixes older entries into the history. They come in the turn's memory context instead, in the `recall` partition, and the history is the newest entries, as with `recent`.

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0

## 0.19.0

### Minor Changes

- [#229](https://github.com/cogitator-ai/Cogitator-AI/pull/229) [`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014) - What a conversation established is kept as memory items, extracted after each run, grounded in quotes, trusted by who said them and kept with when they held, and runs read them as their facts.

  - Types: `MemoryItem` (`kind` `fact`, `event`, `preference`, `instruction`, `opinion` or `lesson`, `status` `suggested`, `active`, `stale` or `superseded`, `trust` `user`, `system`, `model`, `tool` or `web`, a `scope` of `agentId` and optional `userId`, `projectId` and `threadId`, `evidence` and `verified`, `saidAt`, `sessionAt`, `about` as `{ text, start, end, precision }`, bitemporal `validFrom` and `validTo` for the items of a slot and `recordedAt` and `expiredAt`, `supersedes` and `supersededBy`), `NewMemoryItem`, `MemoryEntity`, `MemoryItemAdapter`, `MemoryItemFilter` (with storage-side scope filters `visibleTo` and `scope`), `MemoryEntityFilter`, `MemoryItemQuery` (`active` and `superseded` by default with the state that holds read from `validFrom` and `validTo`, `asOf` world time defaulting to `knownAt`, `knownAt` memory time defaulting to now, `includeClosed`, `text`, `limit`) and `MemoryExtractionConfig`, `MemoryConfig.extraction`. `RunEndEvent.memoryAgentId` (the id the agent's memory is kept under), `BuildContextOptions.memoryAgentId` and `SummarizeOptions.maxTokens`.
  - Memory: `MemoryItems` keeps the rules over any `MemoryItemAdapter`. Writes only add, and one agent's writes go one after another within a process, items of one millisecond recorded a millisecond apart. An item said again merges into the newest open one no other value followed since, else it is a new state, and on a merge the trust and `verified` come together from the better source (the more trusted one first, then the one whose quotes hold), so a `system` item stays `system` and a user's unverified claim stays the user's but `suggested`. Values of a slot compare by text (`sameValue`: spacing aside, case and signs count), content compares normalized. After every write of a state, the `active` and `superseded` items of its slot (its `subject` linked to an entity, and its `attribute`) and exact scope are laid out by time: each closed (`superseded`, `validTo`) when the next starts, the last open. So racing writers, a state told late (it fits between the ones around it) and a failed close converge, a state set to start later leaves the current one in place until it starts, and a state let go keeps its place, so the one before does not come back. `expire` and `purge` reopen nothing. `link` reuses an entity the writer's scope sees (its own or a broader one, such as the user's for a thread), so a slot is the same in a thread and in the user's memory, settles duplicates of racing writers on the first made and adds no aliases. An item becomes `active` on its own from `system`, or from `user` with quotes that hold at `activationConfidence` (default 0.7), everything else stays `suggested`, so what a model, a tool or a page wrote cannot plant itself. An opinion said again gains 0.1 only when the new statement has quotes that hold, and loses 0.2 when a less trusted source contradicts it. `query` (`asOf`, `knownAt`, `includeClosed`, `text`, recording time filtered only by an explicit `knownAt`), `history`, `activate`, `markStale`, `expire` (an item with a future `expiredAt` is found until then), `purge`, `link`, and `visibleIn`, `normalizeName`, `sameValue`, `slotOf`, `isMemoryItemAdapter`.
  - Memory: `resolveTime(expression, sessionAt, timeZone)` turns time words a model marked up (`date`, `relative`, `weekday`, `TimeExpression`) into an interval in a time zone, `end` exclusive, with its precision. `MemoryExtractor` reads entries in windows of `windowTokens` (default 4000), one call each with `EXTRACTION_PROMPT` and the session date (`sessionLine`), shows each message with its date, checks every quote against its entry, gives each item the trust of the least trusted entry among its quotes that hold (`parseExtraction`, `trustOfEntry(entry, userId)`, `web` for tools that fetch pages, `model` for another user's message), resolves relative dates from the date of the first message it quotes (its `saidAt` and `sessionAt`), and writes the items through `MemoryItems`. A `null` or blank field is read as absent, an item that does not fit is dropped, and only an answer with no JSON array fails (`ExtractionAnswerError`, `WindowError` from `extract` with the window's own entries). Each call asks for up to 8000 tokens, and `extract` takes `onWindow` and `skip` to keep its place and go on without a window. `isTimeZone` tells an IANA time zone.
  - Memory: every built-in adapter stores memory items: `InMemoryAdapter`, `SQLiteAdapter` (`memory_items`, `memory_entities`, `memory_entity_names`), `PostgresAdapter` (`memory_items`, `memory_entities`), `RedisAdapter` (never under the thread `ttl`) and `MongoDBAdapter` (`<prefix>items`, `<prefix>entities`). SQLite and Postgres keep the scope in `user_id`, `project_id` and `thread_id` columns and MongoDB at the top of the document, so `findItems` filters by scope in the store. With `includeFacts`, `ContextBuilder` reads the items the run's agent, user and thread see that hold now as its facts (`ContextBuilderDeps.memoryItems`), in place of `FactAdapter`: one state per slot (the one that started last, the narrowest scope on a tie), instructions and preferences first, newest first, an item that superseded another as `(previously: X)` only when the run sees that value and memory did not let it go.
  - Memory: `CoreFactsStore` keeps its API over memory items, each key the slot `core:<key>` of `system` items in a new optional `scope` (`{ agentId: 'core' }` by default): `set` supersedes the current value, `delete` lets it go and keeps the history. `PostgresAdapter`'s `FactAdapter` keeps its API over items too, each fact in its own slot `fact:<id>`: `updateFact` with new content supersedes the current item and keeps the old one as history, `deleteFact` deletes the fact with its history.
  - Core: `memory.extraction` extracts memory items after a run on the thread's active branch (a run whose leaf other runs appended after included, runs of one thread one after another), from the entries since the last extraction (the cursor in the thread's `metadata.memoryExtraction`, `EXTRACTION_CURSOR`) or for a first extraction the run's own, by `extraction.model` (the model the run ended on by default). The thread keeps its place after every window, a cursor on an abandoned branch is replaced by the run's branch point, and a window the model could not answer three extractions in a row is left out (counted in the cursor's `failures` and `failedThrough`), never one a provider, storage or abort failure stopped. A first extraction that fails stores where it started (`through` the branch point, `null` for the thread's start), so the next one takes those entries too. Items are kept under the agent's memory id, its configured id, else its name (`memoryAgentId(agent)`, exported), and belong to the run's own user (never the thread's owner) by default (`scope` `user`, `agent` or `thread`), to the thread for a run without a user, relative dates are resolved in the thread's `metadata.timeZone` when it is a valid IANA zone, else `timeZone`, else UTC, the calls are counted in the run's costs and `usage`, `afterExtract(items)` gets what was written, and an extraction that fails is logged while the run keeps its result, the thread left alone for a minute, doubled after each failure in a row up to an hour. It is the built-in middleware `cogitator:memory-extraction` (`memoryExtractionMiddleware`), whose `afterRun` runs before `cogitator:memory-compaction`. A Cogitator gives the context builder memory items for every store that keeps them, so `includeFacts` works on every built-in store, `memory` included. User messages a run with a user saves carry `metadata.userId`. `CompactionRun` is exported, and the runtime's summarizers pass `maxTokens`.
  - Core: `createMemoryTools` takes `items` (memory items `remember` writes to the user's scope, or the thread's for a run without a user, `recall` searches the user's and the thread's, and `forget` lets go only the run's own that hold the query as whole words, past and suggested states included) and `memory` (the thread store). `remember` takes a `quote`, and with `memory` it keeps a fact as the user's (graph `source: 'user'`, an item trusted as `user`, a core fact) only when the quote is in one of the run user's own messages among the 200 newest entries of the thread's active branch, else as a suggestion that never becomes a core fact. Its item is trusted as `user` whenever its graph node is the user's, and stays `suggested` without a quote that holds. `forget` says it forgets: graph facts are deleted, items expire.
  - Config: `MemoryExtractionConfigSchema` validates `memory.extraction`.
  - Channels: `RuntimeBuilder` gives the memory tools the memory store and memory items, so the assistant's `remember` checks quotes, and the assistant's agent id is its `name`.
  - Test utils: `memoryItemAdapterConformanceCases` checks a `MemoryItemAdapter` against the contract the built-in stores keep, scope filters (`find-visible-to`, `find-scope`) included.
  - Breaking: Postgres schema version 3. The first `connect()` after upgrading moves every row of `facts` into a memory item and renames the table `facts_legacy`. Upgrade every process that shares the database at once.
  - Breaking: `CoreFactsStore` keeps its facts in memory item tables. A database with the old `core_facts` and `core_facts_history` tables is moved on `initialize()`, and the tables are renamed `core_facts_legacy` and `core_facts_history_legacy`. Setting the value a key already holds no longer adds a history entry.
  - Breaking: `remember` given `memory` no longer trusts a fact whose quote is missing or not found in the run user's own messages on the thread's active branch: it is kept as a suggestion (graph `source: 'inferred'`, confidence 0.6) and is not saved as a core fact.
  - Breaking: the agent `RuntimeBuilder` builds has its `name` as its id instead of a generated one.
  - Breaking: a `FactAdapter` fact with empty evidence comes back without the `evidence` field.
  - Breaking: `RunEndEvent` has a required `memoryAgentId`, so code that builds one must pass it.
  - Breaking: a Cogitator keeps an agent's memory items under its configured `id`, else its `name`, so an agent without an id keeps them under its name, and agents of one name without an id share them.

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0

## 0.18.0

### Minor Changes

- [#228](https://github.com/cogitator-ai/Cogitator-AI/pull/228) [`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03) - A thread can be compacted into a tree of grounded atoms that is never summarized again and does not lose what is still open, and a Cogitator compacts a run's thread after the run.

  - `CompactionStrategy` gains `hierarchical`. The entries new since the last compaction, up to the kept tail, are read in chapters of about `chapterTokens` tokens (default 4000), each opening with the end of the one before, one at a time (`chapterConcurrency` reads more at once), and the summarizer lists the atoms of each, told the items still open before it so it can close them (`CompactionAtom`: `kind` `fact`, `task`, `decision`, `constraint`, `error`, `file` or `thread`, `status` `open` or `closed`, `text`, `evidence`, `verified`). Every quote is checked against its entry, an answer that is not a valid array is asked for again up to three tries, a constraint or a decision only tool outputs show is not verified, and files tool calls worked on, failed tool calls (known by their tool and files, or arguments when they name no files, and closed by a later call of the same tool on them that succeeds) and task lines (`TODO:`, `- [ ]`, closed by `- [x]`) are taken from the entries with no model. The transcript indents further lines of an entry and cuts one at about `chapterTokens`, and a part to compact under a tenth of the kept tail is left for later. Chapters beyond `chaptersPerArc` (default 4) fold into arcs and arcs beyond `arcsPerSaga` (default 4) into the saga, which keeps every open item and the newest 200 facts and files (`SAGA_ATOMS`), with no model, and an open item is closed only by an atom whose evidence holds. A control item is closed or opened again only by an atom whose evidence holds, and `messageThreshold` counts only the entries written since the last summary. The summary is written only when every open item of the one before is still there or was closed, else `compact()` throws and the thread stays as it was. The whole tree is one `compaction` entry, `CompactionEvent.levels` (`CompactionLevels` of `CompactionNode`s), and its message is the handoff, laid out as open tasks, constraints, decisions, unresolved errors, open questions, files, facts and done, in the same order every time so it stays in the prompt cache. `CompactionService.chapterAtoms(window, config, { own, open })` returns the checked atoms of one window. On an adapter without branches the levels are kept in the summary entry's metadata (`compactionLevels`).
  - `CompactionConfig.keepRecentTokens` keeps the newest tokens of the conversation verbatim for the `hierarchical` strategy, as whole turns that open with a user message, so a tool call keeps its result.
  - `memory.compaction` (`MemoryCompactionConfig`) compacts a run's thread `hierarchical`ly after the run once the conversation of its branch passes `at` (default 0.8) of the window of the model the run ended on, keeping `keepRecentTokens` (default the less of 20000 and a quarter of the window, unless only `keepRecent` is set). `beforeCompact({ threadId, tokens, threshold })` can return `false` to skip it or `{ instructions }` to add to the summarizer's prompt, and `afterCompact(result)` gets the `CompactionResult`. A thread that outgrows its window again within two turns of its last compaction is not compacted again, with a warning to clear tool outputs (`context.clearToolOutputs`) instead, a run on another branch than the active one is left alone, and a compaction that fails is logged while the run keeps its result, and the thread is left alone for a minute, doubled after each failure in a row up to an hour. The summarizer's calls are counted in the run's costs and in the `usage` it returns, and they stop with the run's signal. `compact()` refuses `chapterTokens`, `chapterConcurrency`, `chaptersPerArc` and `arcsPerSaga` that are not whole numbers above 0 (`checkCompactionSettings`). It is the built-in middleware `cogitator:memory-compaction` (`memoryCompactionMiddleware`), and `MemoryCompactionConfigSchema` validates it in `@cogitator-ai/config`.
  - Run middleware gets an `afterRun({ result, model }, context)` hook (`RunEndEvent`), called once a run finished and its writes settled, before `run()` returns. It is not called for a run that failed or paused, and an error it throws is logged without failing the run, the next hook still running.
  - Core: `anthropicCompactionSummarizer({ model, client?, apiKey?, maxTokens? })` is a `SummarizeFn` that has Anthropic's compaction on request (`ANTHROPIC_COMPACTION_BETA`, `compact-2026-09-04`) write the answer, with the prompt as its instructions. The answer is parsed and checked like any other, and the signed block is not kept, so the conversation goes on with Cogitator's own summary on every model.
  - Channels: the gateway's summarizer asks the model and prompt each call names, falling back to `summaryModel` and `summaryPrompt`, then to the agent's model. `Gateway.compactAll()` compacts every thread served since the start and the thread of every stored session (unless `session.threadKey` is set), one at a time past those that fail, and `/compact all` with `RuntimeBuilder` calls it instead of compacting a thread named `all`.
  - Breaking: `RuntimeBuilder` (`cogitator up`) compacts chat threads with the `hierarchical` strategy, keeping about 4000 tokens (`keepRecentTokens`) of the newest turns verbatim, instead of the `summary` strategy that kept the 10 newest messages. A thread compacted before is read on: its old summary becomes one closed, unverified fact of the first chapter.

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0

## 0.17.0

### Minor Changes

- [#226](https://github.com/cogitator-ai/Cogitator-AI/pull/226) [`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077) - A context is assembled by partitions and ordered for the prompt cache, and old tool outputs can be cleared before anything is summarized.

  - `ContextAssembler` shares a token budget among the partitions of a context (`ContextPartition`): `system`, `pinned`, `index`, `summaries`, `facts`, `recall`, `brief`, `recent` and `final`. Each has a `ContextPartitionBudget` (`share`, `required`). By default (`DEFAULT_PARTITIONS`) `system`, `pinned`, `index`, `summaries`, `brief` and `final` are required, `facts` takes 15%, `recall` 35% and `recent` the rest. Required partitions are fitted first, the others split what they leave by their shares, and what the shares cannot place goes to the partitions still short of room in fill order, `recent` last. The shares of the partitions that are not required add up to 1 at most, or the constructor throws. A text block is left out as a duplicate when a block a more lasting partition kept holds all of it, word for word. `fitInOrder` is the default fit.
  - `ContextBuilder` builds on it. Its config takes `partitions`, merged over the defaults, and `build()` takes `pinned`, `index`, `brief` and `reserveTokens`. It counts `currentInput` in the budget as the `final` partition. `BuiltContext` gains `memoryContext` (the brief, facts, search results and graph context as one text) and `partitions` (tokens per partition), and `DroppedContext.blocks` lists every left out block (`DroppedBlock`) with its partition, tokens, source and `DroppedReason`: `budget`, `duplicate`, `not-selected` or `oversized`. `formatTurnContext(blocks)` builds the turn context, a `<memory_context>` block, from texts of your own, `extendTurnContext(text, block)` adds a block to the one in front of an input, and `withoutTurnContext(text)` gives the input back without it.
  - `messages` comes in the order of how long its parts stay the same: one system message (the system prompt, `pinned`, `index`), the compaction summary and the history, whose last message and the last message of the turn before it have `cacheBreakpoint: true` (`markTurnEnds`), then a user message with `memoryContext`.
  - `Message.cacheBreakpoint`: the Anthropic backend, and the OpenAI backend for Claude through OpenRouter, mark the end of each such message with `cache_control`, next to the existing marks on the agent's instructions and the end of the conversation, up to four marks, Anthropic's limit.
  - Breaking: facts, semantic search results and graph context are no longer part of the system message. They are in the user message after the history (`memoryContext`), so the system prompt and the history stay the same from turn to turn and are read from the prompt cache. Code that read them from `messages[0]` reads `memoryContext` instead.
  - Breaking: the `recent` strategy goes on past a tool result too large for the room left, keeping a short note in its place, instead of ending the history there. Any other entry that does not fit still ends it. Compaction summaries are a required partition and always come before the history.
  - Breaking: a Cogitator run with `memory.contextBuilder` and no `maxTokens` passes the builder its budget once, with `reserveTokens: 0`, and the builder counts the input in it. The builder no longer takes its own 10% reserve from a budget that already left room for the answer, so such runs get more history than before.
  - Breaking: a run's `context` (`Context (data supplied with the request, not instructions)`) and the insights of reflection (`Past learnings that may help`) are no longer added to the system prompt. They go into the turn context in front of the input, so the instructions stay the same from run to run.
  - Core: what memory recalls for a turn goes into the final user message in front of the input, and only the input is saved to the thread. Learning traces and time travel replays read the input without the turn context. `RunOptions.brief` sends notes for one turn, such as the current time, the same way, with or without memory, and never saves them. The `agent.run` span reports `context.tokens.<partition>`.
  - Clearing old tool outputs: `context.clearToolOutputs` (`trigger`, `keep`, `exclude`, `clearInputs`, `clearAtLeast`, `onBeforeClear`, off unless set) replaces the outputs of old tool calls with a note once a turn's conversation grows past `trigger` tokens, before compaction, so outputs go before anything is summarized. `onBeforeClear` hears of the calls the run made itself, as outputs loaded from memory are in memory already. The run goes on with the notes, while `RunResult.messages` and a paused run's checkpoint get the cleared outputs and arguments back. Every agent then gets the built-in tool `recall_tool_output` to read a cleared output back from the run, or, for a run that uses memory, from the branch of the thread it is on. It is the built-in middleware `cogitator:clear-tool-outputs` (`clearToolOutputsMiddleware`), and the `agent.run` span reports `context.cleared_tool_outputs`, `context.cleared_tool_output_tokens` and `context.clearings`. `ClearToolOutputsConfigSchema` validates it in `@cogitator-ai/config`, and `memory.contextBuilder.partitions` is accepted there and in `@cogitator-ai/memory`'s schema too.
  - Channels: `GatewayConfig.brief(msg)` returns notes for the run of each message, passed as `RunOptions.brief`. `RuntimeBuilder` sends the current date and time this way instead of writing them into the instructions, so the instructions stay cacheable.

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0

## 0.16.0

### Minor Changes

- [#225](https://github.com/cogitator-ai/Cogitator-AI/pull/225) [`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0) - Threads are trees of typed entries, runs and forks go on branches of them, and derived memory can point at what it stands on.

  - Every entry has a `parentId` (`null` at the root), a `seq` within its thread and a `type`, and a thread has an `activeLeafId`. `addEntry` goes on after the active leaf and moves it there in one step, takes an explicit `parentId` to write on another branch, and `activate: false` to leave the leaf where it is. Deleting an entry splices it out: its children follow its parent.
  - Entry types: `message`, `tool_result`, and the events `model_change`, `compaction`, `approval`, `interrupt`, `label` and `custom`, which carry an `event` payload. `getEntries` and `getPath` return only `message` and `tool_result` unless `types` asks for more (or `'all'`), so readers that know nothing of events keep seeing the conversation.
  - `getPath({ threadId, leafId?, limit?, before?, types? })` reads one branch from the root to its leaf, the newest `limit` entries and pages before an entry, without reading the whole thread. `rewind(threadId, toEntryId)` moves the leaf back along its branch and deletes nothing, `checkout(threadId, entryId)` makes any branch active, and `forkThread(threadId, atEntryId, newThreadId?)` copies a branch into a new thread (`metadata.forkOf` on the copies, `metadata.forkedFrom` on the thread). Every built-in adapter implements them, adapters of your own get them by extending the new `BranchingMemoryAdapter` and implementing `setActiveLeaf`, which must refuse an entry that is not in the thread.
  - Entries written before this version are chained by time when first met: Postgres moves its schema to version 2 on `connect()`, SQLite migrates by `user_version`, Redis and MongoDB chain a thread the first time it is read or written. Upgrade every process that shares a store together, as an older process appends without a parent.
  - `ContextBuilder` and the runtime read the active branch instead of the whole thread.
  - Compaction deletes nothing on adapters with branches: it adds a `compaction` entry at the end of the active branch that names the first kept entry (`CompactionEvent`) and holds the summary. `readCompactedHistory(memory, { threadId })` reads the conversation of a branch as that summary, the kept entries and everything after them, in pages back only to the compaction's start (`compactedHistory(path)` does the same for a path already read), and `ContextBuilder` and the runtime read history this way. Other branches and evidence keep the summarized entries, and `getEntries` still returns them. `sliding-window` leaves entries out the same way. A compaction whose active branch moved to another branch while the summary was written fails instead of writing a summary of the wrong conversation. Adapters without `getPath` compact as before.
  - Breaking: Redis keeps memory with no expiry by default (`ttl: 0`), where it used to expire after 24 hours. Pass `ttl` to keep the old behaviour. The in-process `memory` adapter counts `maxEntries` per thread, not across all threads, and evicts entries of inactive branches first.
  - Runs on branches: `RunOptions.branch: { fromEntryId, activate? }` reads history along the branch that ends at `fromEntryId` (`null` for none) and chains the run's entries after it, and `RunResult.memory` says where the run wrote (`threadId`, `branchPoint`, `leafId`). The runtime records `model_change` when it falls back to another model, `approval` when a run pauses and `interrupt` when one is aborted, and a paused run resumes on its branch. A run with `activate: false` does not take the thread's place for a paused run: it is resumed with its checkpoint, and never abandons the paused run of the conversation.
  - Time travel: checkpoints keep where their run wrote, and live replays and forks go on a branch of the original thread from where the run started, without moving its active leaf. Forks of one run no longer share a `replay_<runId>` thread and see each other's entries. A replay goes on a thread of its own when the checkpoint has no place in memory, its branch point is gone, the conversation before the run was edited, or the thread belongs to a user other than the new `ReplayOptions.userId` / `ForkOptions.userId`.
  - Lineage: `Evidence { entryId?, toolCallId?, fileRange?, quote }` and an optional `evidence` on facts, graph nodes and edges and insights. Every built-in fact and graph store keeps it (a new `evidence` column in Postgres and SQLite, added on connect, and a JSON property in Neo4j), updates take it and `mergeNodes` keeps the evidence of merged nodes. `verifyEvidence` checks that a quote appears in its entry or tool result word for word, `verifyEvidenceInMemory` checks a list against stored entries, and `evidenceOnPath` keeps derived items whose evidence lies on a branch.
  - Studio: a Tree panel next to the chat (`T`) shows every branch of a thread in memory, with forks, events and the run that wrote each entry.
  - `@cogitator-ai/test-utils`: conformance cases for trees, branches, paths, rewind and checkout, forks, entry types, splicing deletes, new roots, deleting a branch point, checkout of a deleted entry and concurrent appends.
  - MongoDB writes to a thread's tree under a short per-thread lease on the thread document, so concurrent processes cannot leave an entry under a deleted parent, and reads paths without loading whole ancestor lists into one document. Redis scripts name their keys, so they route correctly in cluster mode. SQLite keeps an explicit `seq` instead of `rowid`.

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0

## 0.15.0

### Minor Changes

- [#224](https://github.com/cogitator-ai/Cogitator-AI/pull/224) [`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d) - Every message and document is embedded once.

  - `MessageIndex` keeps a vector per history entry in an embedding store (`sourceType: 'message'`). Attached to an adapter it embeds new user and assistant entries in the background, in batches, and deletes vectors with their entries and threads. `ContextBuilder` takes it as `messageIndex`: `relevant` and `hybrid` then embed only the input, read kept vectors for the newest entries and find older ones of the thread with a search of the store, so recall is no longer limited to the newest 200 entries. The `Cogitator` runtime sets one up for `relevant` and `hybrid` when `memory.embedding` and an embedding store are configured (the in-process `memory` adapter keeps vectors in process as before), and `close()` waits for its work. History written before the index is indexed in the background the first time a thread is built.
  - `MemoryAdapter.onChange(listener)` reports `entry-added`, `entry-deleted`, `thread-cleared` and `thread-deleted` once stored. Every built-in adapter implements it through the new `ChangeReportingMemoryAdapter` base, which adapters of your own can extend. Redis reports threads and entries it expired once a later write or read finds them gone, and its thread index now outlives threads by seven lifetimes for that.
  - Message vectors are marked `metadata.index: 'messages'` and carry the thread's `agentId` and `userId`, so user filters on a shared store leave out other users' messages.
  - `EmbeddingAdapter.getBySources(ids)` reads embeddings with their vectors by source, `replaceBySource(embedding)` stores one as the only embedding of its source atomically (so indexes of several processes leave one vector per message), and `SearchFilter.sourceTypes` takes a list of source types. Every built-in store implements all three, stores of your own keep working without them. Semantic context now searches only facts and documents: embeddings stored as `sourceType: 'message'` no longer show up in it.
  - With `relevant` or `hybrid`, the runtime now writes message vectors into `memory.qdrant` (and the Postgres store), so a read-only Qdrant key needs write access.
  - RAG: `ingest()` skips a source whose documents, chunker and embedding model did not change, and reports them as `unchanged`. A changed source is written as a new generation before the previous one is deleted, so it is never missing from queries, and its unchanged documents keep their vectors. The first chunk of each document is written last, so an ingest that stopped is finished by the next one. Chunkers get an optional `fingerprint`, which the built-in ones have and a source needs to be skipped. A local keyword index is filled from the store for skipped sources. Chunks carry `ragContentHash`, `ragGeneration` and `ragSourceDocuments`. Chunks stored by earlier versions are replaced once as before.
  - Postgres: vectors of 2001 to 4000 dimensions get an HNSW index on their `halfvec` cast (pgvector 0.7+) instead of none, in the memory store and both knowledge graph adapters. The memory schema version is recorded in `<schema>.cogitator_schema_migrations`, and `connect()` changes tables only when it is older or they are gone. Processes connecting at once take turns under a lock on the schema instead of failing on the same `CREATE`, in one transaction, so it also holds behind a pooler in transaction mode. A table of 2001 to 4000 dimensions from before gets its index on the first connect, which on a large table takes a while: build it ahead with `CREATE INDEX CONCURRENTLY idx_embeddings_vector ON <schema>.embeddings USING hnsw ((vector::halfvec(<n>)) halfvec_cosine_ops)`. New indexes on `embeddings(source_id)` and `metadata->>'threadId'`. Qdrant gets payload indexes on `sourceId`, `sourceType` and `metadata.threadId`.
  - `@cogitator-ai/test-utils`: conformance cases `reports-changes` and `get-by-sources`, and source type lists in `filters`.

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0

## 0.14.0

### Minor Changes

- [#223](https://github.com/cogitator-ai/Cogitator-AI/pull/223) [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913) - Memory adapters share one contract, checked by a conformance suite, and threads can be listed.

  - `MemoryAdapter.listThreads(options)` pages through threads by update time, filtered by agent, metadata values (compared by type) and update time, with an opaque cursor. Every built-in adapter implements it in the database: Redis keeps an index of threads by update time and adds threads written by earlier versions to it the first time threads are listed. Adapters of your own need to implement it.
  - Every adapter now keeps the same contract: `addEntry` into a thread that does not exist fails (InMemory, Redis and MongoDB used to store an orphan entry), `updateThread` is atomic under concurrent calls (SQLite, Redis and MongoDB could lose an update), entries with one `createdAt` come back in the order they were added, a negative or fractional `getEntries` limit fails, `createThread` with an empty id fails, a field that was never set comes back absent instead of `null` (Postgres), and InMemory returns copies instead of the objects it stores.
  - `SessionManager.list()` finds sessions with `listThreads` and no longer keeps an index thread. `indexRefreshInterval` is deprecated and ignored.
  - `@cogitator-ai/test-utils` ships `memoryAdapterConformanceCases` and `embeddingAdapterConformanceCases`, framework-agnostic suites that check an adapter or embedding store against this contract. `MockMemoryAdapter` implements `listThreads`.
  - `RedisClient` gains `eval(script, numKeys, ...args)`, run on prefixed keys.

  Upgrading a database that already holds data:

  - Postgres builds its new indexes on `threads` (agent and update time, update time alone, a GIN index on `metadata`) when the adapter connects, which blocks writes to `threads` while each one builds. On a large table create them first with `CREATE INDEX CONCURRENTLY` under the same names (`idx_threads_agent_updated`, `idx_threads_updated`, `idx_threads_metadata`) so connecting finds them in place. The new `entries.seq` column is added without rewriting the table: entries written before it keep their order by `createdAt`.
  - MongoDB filters on metadata keys that contain a dot with `$getField`, which needs MongoDB 5.0 or later.
  - Redis lists threads through an index it fills the first time threads are listed, and again when the index is gone.

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/redis@0.6.0

## 0.13.3

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/types@0.48.0

## 0.13.2

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/types@0.47.0

## 0.13.1

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/types@0.46.0

## 0.13.0

### Minor Changes

- [#210](https://github.com/cogitator-ai/Cogitator-AI/pull/210) [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b) - A run's history is sized to the model it runs on. With `memory.contextBuilder` set and no `maxTokens`, the runtime used to keep every run within 4000 tokens of history, whatever the model. The budget is now the context window of the model the run starts on (from the model registry, then the model family, else 8192 tokens), minus room for the answer (the agent's `maxTokens`, else 15% of the window, at most half of it), the tool schemas and the input, and below the point where the context manager would compress, when it is on. A model on Ollama gets at most the 4096 tokens Ollama serves by default, except on Ollama Cloud (`https://ollama.com` as `llm.providers.ollama.baseUrl`, or a model tagged `cloud`). The builder keeps `reserveTokens` (10% of the budget by default) on top as slack, a run that leaves no room for history logs a warning, and an explicit `maxTokens` still wins.

  `ContextBuilder.build()` takes `maxTokens` per call, so one builder serves models of different sizes, and `ContextBuilderConfig.maxTokens` is optional: a build without a budget from either side throws, and a budget that is not a positive number throws too, `memory.contextBuilder.maxTokens: 0` included. `BuiltContext.dropped` (`DroppedContext`) lists what was left out: the history entries, facts, search results and graph nodes, with their token count. With the `relevant` and `hybrid` strategies the entries include those the selection passed over. `ContextBuilderConfigSchema` accepts a config without `maxTokens`, and `modelContextWindow(model)` from `@cogitator-ai/core` gives the window the runtime uses.

  **Migration:** runs with `memory.contextBuilder` and no `maxTokens` now send much more history on models with large windows, and every turn costs more on long threads. Set `memory.contextBuilder.maxTokens` to keep a cap, `4000` restores the previous behavior. If your Ollama server runs with a larger context (`OLLAMA_CONTEXT_LENGTH`), set `maxTokens` to use it. Code that builds `BuiltContext` objects of its own, such as test doubles, needs a `dropped` field.

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/types@0.45.0

## 0.12.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0

## 0.12.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/types@0.43.0

## 0.12.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0

## 0.12.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/redis@0.5.3
  - @cogitator-ai/types@0.41.1

## 0.12.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0

## 0.12.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/types@0.40.0

## 0.12.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/types@0.39.0

## 0.12.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0

## 0.12.1

### Patch Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - - memory: the SQLite adapter and the core facts store create the directory of their database file.
  - channels: the file-tool path guard now comes from `@cogitator-ai/core`.
  - workflows: `functionNode` takes the output type of its function, so `stateMapper` is typed by it.
  - workflows: the file run, approval, checkpoint and dead-letter stores write atomically, so a process killed mid-write leaves the previous state, which `recoverRuns()` picks up, instead of an empty file that lost the run.
  - next: `setThreadId(undefined)` starts a new thread.
- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0

## 0.12.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Compaction no longer reorders a thread that is written while the summary is produced. Before, the kept entries were deleted and added again after the summary with new timestamps, so a reply saved during summarization (two quick messages on a channel) ended up before its own question in every later turn. The summary is now dated just before the first kept entry and kept entries are left untouched, with their ids. `addEntry` accepts an optional `createdAt` (the new `NewMemoryEntry` type) for this, honoured by every built-in adapter, and compactions of one thread in a process run one after another.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `CompactionConfig.threshold` means tokens everywhere. The Gateway compared it with the number of messages while `CompactionService` compared it with tokens, so `threshold: 8000` from the memory docs waited for 8000 messages in a channel. The new `messageThreshold` counts messages, and a thread is compacted once either limit is reached (`threshold` is now optional, at least one is required). Gateway configs that meant messages should switch to `messageThreshold`. The `memory.compaction.threshold` of an assistant YAML config still counts messages, and `cogitator init` generates `messageThreshold`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `ContextBuilder` never drops the system prompt anymore. Before, instructions larger than the budget (about 15k characters with the runtime's default 4000 tokens) were silently left out, so the run went to the model without a system prompt and lost `RunOptions.context` and reflection insights with it. The prompt is now always kept and counted, history gets what it leaves, and `BuiltContext.warnings` explains when nothing else fits. In runs, the agent's instructions always come first, `includeSystemPrompt: false` is ignored with a warning, and the warning about an oversized prompt is logged.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A part of the context that fails to load no longer fails the run or vanishes silently. `ContextBuilder.build()` leaves out the history, facts, semantic search, knowledge graph or relevance scoring that failed and lists it in the new `BuiltContext.errors` (`{ source, error }`). Runs pass each of them to `onMemoryError` with the `'load'` operation and log a warning, so an embedding API answering 429 with `includeSemanticContext` no longer fails every run, and a brief database outage no longer makes the agent answer as if the conversation never happened. The runtime also warns at connect when `includeFacts`, `includeSemanticContext` or `includeGraphContext` cannot add anything with the configured memory.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Token counts include tool calls and images. `countMessageTokens` counts the names and JSON arguments of an assistant message's `toolCalls` and estimates images (85 tokens for `detail: 'low'`, 1600 otherwise), and the new `countEntryTokens` recounts stored entries, so `ContextBuilder` keeps to its budget when history holds large tool arguments saved with an old count. `countToolCallsTokens` is exported too.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` checks the vector size of an existing `embeddings` table on `connect()`. An adapter without a configured size adopts it, and one configured for another size (after switching the embedding model) reports the mismatch through `vectorStatus()` and a clear failure from `addEmbedding` and `search` instead of a Postgres error on each search. The size can now be set with `dimensions` in `PostgresAdapterConfig` and `memory.postgres.dimensions`, as well as `setVectorDimensions()`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` connects to Postgres without pgvector. Before, the `CREATE TABLE ... vector(N)` that followed a failed `CREATE EXTENSION` failed `connect()`, so memory was off entirely even for users who only need threads. Threads, entries and facts now work on any Postgres, embedding operations return a failed result naming the reason, and the new `vectorStatus()` tells whether vectors are usable. The runtime does not use such a store for semantic context and logs why.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Ingesting a source again replaces it instead of duplicating every chunk. Before, `rag_ingest` on the same README or a cron over an edited folder grew the store with each run, stale text kept being found and `topK` filled up with copies, and there was no way to delete a document. `RAGPipeline.ingest()` now deletes the chunks it stored for each loaded source once the new ones are embedded, `removeSource(source)` deletes a source, loaders derive document ids from the source (and row, item or page) and chunkers derive chunk ids from the document and position, so ids stay the same across re-ingests. Embedding stores gain `deleteByFilter()` and a `metadata` search filter (in-memory, Postgres and Qdrant), an optional `EmbeddingAdapter` method that a custom store without it skips with a warning.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `SessionManager.list()` no longer comes back empty after a quiet day on Redis. The session index thread was only written when a session was created or deleted, so it expired with the adapter TTL while sessions stayed active, and the next session rebuilt it from itself alone. Using a session now puts it back into the index if needed and rewrites the index at most once per `indexRefreshInterval` (a new option, one minute by default).

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The `relevant` and `hybrid` context strategies embed each history entry once instead of on every turn. Vectors are cached per builder by entry id, and only the newest 200 entries are scored, so a long thread no longer sends its whole history to the embedding API with each message.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A memory adapter that fails to connect no longer keeps the process alive. `RedisAdapter` closed nothing when its first ping failed, so ioredis kept reconnecting and logging `Unhandled error event` after `cogitator.close()`. Redis now closes its client, Postgres ends its pool and SQLite closes its file when `connect()` fails, the runtime disconnects any adapter that failed, and the Redis error names the connection problem (`connect ECONNREFUSED ...`) instead of the retry limit.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - RAG searches only its own documents. Retrievers searched the whole embedding store, so a store shared with agent memory (a Postgres memory store holding message and fact embeddings with `metadata.userId`) could return another user's private memory through `rag_search`. `RAGPipeline.query()` now always searches `sourceType: 'document'`, and the new `namespace` config keeps several pipelines apart in one store (queries, re-ingest and removal stay inside it). `retrieval.filter` and the `filter` query option narrow a search further, every built-in retriever passes the filter on, and `HybridSearch` applies it to its local keyword index too.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `RedisAdapter.getEntries({ limit })` reads only the newest `limit` entries instead of fetching and parsing the whole thread, and still fills the limit from older entries when the newest have expired.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/redis@0.5.2

## 0.11.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0

## 0.11.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0

## 0.11.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2

## 0.11.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/redis@0.5.1
  - @cogitator-ai/types@0.33.1

## 0.11.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0

## 0.11.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0

## 0.11.2

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 0.11.1

### Patch Changes

- [`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7) - Fixes in `MongoDBAdapter`, found by running it against a real MongoDB server for the first time:

  - Fields left `undefined` are no longer stored as `null`. The driver serializes `undefined` as BSON null by default, so an entry saved without tool calls came back with `toolCalls: null`, `toolResults: null` and `metadata: null`, a message without a name came back with `name: null`, and a thread metadata key set to `undefined` was stored as `null`. Every other store leaves those fields out. The adapter now opens its client with `ignoreUndefined`, and entries an earlier version stored with those nulls read back without them, while a tool result that really is `null` stays `null`.
  - A failed `connect()` leaves the adapter disconnected. It kept the half-open client, so the next `connect()` reported success while every call failed with `Not connected`. The failed client is now closed and the next `connect()` tries again, concurrent `connect()` calls share one attempt, and `disconnect()` waits for a pending one.

- [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6) - The SQLite (`SQLiteAdapter`, `SQLiteGraphAdapter`, `CoreFactsStore`) and MongoDB adapters are now type checked against the real `better-sqlite3` and `mongodb` drivers instead of hand-written declarations of them. Those declarations took precedence over the drivers' own types, which is how a Qdrant client method that no longer existed went unnoticed. A driver release that drops or changes a method the adapters call now fails the build instead of failing at runtime. Checking the adapters against `better-sqlite3` 13 and `mongodb` 7 found no mismatch, so behaviour is unchanged.

- [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36) - Fixes in the memory stores, found by running them against real Postgres, Qdrant and OpenRouter:

  - `QdrantAdapter.search()` works again. It called `client.search()`, which `@qdrant/js-client-rest` 1.19 (the version the package asks for) no longer has, so every search failed with `this.client.search is not a function`. It now uses `client.query()`, and deletes wait until Qdrant has applied them, so a search right after a delete no longer finds the deleted points.
  - `PostgresAdapter.addEntry()` stores entries with `toolCalls` or `toolResults`. node-pg sent those arrays as Postgres array literals, and Postgres rejected them with `invalid input syntax for type json`, so every tool exchange of an agent was lost. All `jsonb` columns are now written as JSON text.
  - pgvector search finds every row. `connect()` built an `ivfflat` index on the empty table, and for small limits Postgres used it and missed most rows (`search({ limit: 3 })` returned 0 or 1 of 6 rows). The adapter now builds an HNSW index, which needs no training data, and replaces an existing `ivfflat` index on the first `connect()` after upgrading. On a large table that rebuild takes a while, the adapters docs show how to build the index ahead of the deploy. Searches also raise `hnsw.ef_search` to the requested limit and use iterative scans on pgvector 0.8+, so a limit above 40 or a filter no longer cuts results short, and equally similar rows come back ordered by id. `PostgresGraphAdapter` builds its node embedding index with HNSW too.
  - The `recent` context strategy keeps an unbroken run of the newest messages. It skipped a message that did not fit the budget and kept older ones, so the model could see an answer without the question it answered. It now stops at the first message that does not fit.
  - `createEmbeddingAdapter()` returns a `ConnectableEmbeddingAdapter`, an `EmbeddingAdapter` with `connect()` and `disconnect()`, so the adapter can be connected without a cast.
  - `OpenAIEmbeddingService` sends `dimensions` for gateway model ids such as `openai/text-embedding-3-small` (OpenRouter) and knows their native size. It reported 512 while the gateway returned 1536-dimensional vectors, so vector columns and collections were created with the wrong size. A response whose vectors do not match a configured `dimensions` now throws instead of reaching the store.

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 0.11.0

### Minor Changes

- a3c2ee1: `CompactionConfig.summaryModel` and `summaryPrompt` were ignored by `CompactionService`. The summarizer now receives them as a second `options` argument (`{ model, prompt }`, type `SummarizeOptions`). The Ollama embedding config schema now keeps `dimensions` and the Google one keeps `baseUrl`, matching the TypeScript types.
- bb17767: `LLMEntityExtractor` now accepts a Cogitator `LLMBackend` directly together with a `model` (`new LLMEntityExtractor(backend, { model })`), so no hand-written adapter is needed. Hand-written `LLMBackendMinimal` adapters keep working and receive the configured `model` when one is set.

### Patch Changes

- e7925d5: `createThread` on an existing thread id in the Postgres and SQLite adapters returned the current time as `createdAt`. It now returns the stored thread, so `createdAt` keeps the original creation time.
- e7925d5: PostgresAdapter (getThread, updateThread, getEntries, getEntry, getFacts, updateFact, disconnect), PostgresGraphAdapter and SQLiteGraphAdapter threw on database errors. They now return a failed `MemoryResult` like the rest of the adapter contract, and graph traversal, path finding and node merging report a failed lookup instead of returning partial results.
- 4a2925f: QdrantAdapter stored points under `emb_<id>` ids, which a real Qdrant server rejects because point ids must be unsigned integers or UUIDs. Each embedding is now stored under a deterministic UUID derived from its id, the public `emb_` id is kept in the payload and returned from search, and `deleteEmbedding` removes the matching point.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [7083ee5]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/redis@0.5.0

## 0.10.0

### Minor Changes

- 333e4ad: `unwrap(result)` turns a `MemoryResult` into its data, or throws an `Error` with the adapter's message when the call failed: `const thread = unwrap(await memory.createThread('agent-1'))`.

### Patch Changes

- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 0.9.1

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 0.9.0

### Minor Changes

- ed996c4: One agent can serve many users without them seeing each other's conversations or memory.

  - **Threads have owners.** The run that creates a thread records its `userId` (`thread.metadata.userId`). A run that passes a `threadId` continues it only for its owner and otherwise fails with the new `THREAD_ACCESS_DENIED` (403) before any history is loaded; a thread that cannot be read fails with `MEMORY_READ_FAILED` instead of being recreated without its owner. `RunOptions.threadAccess: 'shared'` opts out for threads your server derives itself (channels uses it, so group chats keep working). `assertThreadAccess`, `ensureThreadAccess`, `threadOwner` and `threadMetadata` are exported for your own endpoints.
  - **Memory is scoped by user.** `ContextBuilder.build({ userId })` leaves out facts, embeddings and knowledge graph nodes whose `metadata.userId` belongs to someone else; memory without an owner stays shared. The vector search filters in the adapter (`filter.userId` on the in-memory, Postgres and Qdrant adapters), so other users' memories cannot crowd out the user's own. Agent runs build the context for their `userId`, and the runtime now hands the context builder the memory adapter's facts and embeddings and the `memory.embedding` service, so `includeFacts`, `includeSemanticContext` and the `relevant`/`hybrid` strategies work in runs.
  - **Swarms and worker jobs** carry `userId` (`SwarmRunOptions.userId`, `addAgentJob(..., { userId })`) to every agent run.
  - **Server adapters** scope `/threads/:id` (read, append, clear) to the authenticated user and pass it to agent, stream, WebSocket and swarm runs. hono and koa now pass `auth`'s `userId` to runs at all (HTTP and WebSocket); next answers a run's `CogitatorError` with its status and `code` instead of 500, and chat streams cancel the run on client disconnect even after the Request object is no longer referenced. The shared OpenAPI spec lists the 403 of `/threads/:id` and agent runs.

  **Behaviour change:** threads created before, or by runs without a `userId`, have no owner and are open only to callers without one. Hand such a thread to a user by setting `metadata.userId` with `updateThread`.

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 0.8.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 0.8.0

### Minor Changes

- Optional dependencies move to ioredis 6, mongodb 7 and better-sqlite3 13; peer ranges keep the previous majors.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/redis@0.4.0
  - @cogitator-ai/types@0.24.0

## 0.7.0

### Minor Changes

- createThread on an existing id wiped history in the in-memory adapter and failed in SQLite and MongoDB; it is now a non-destructive upsert everywhere. Entries saved in the same millisecond now keep insertion order, using per-thread strictly increasing timestamps plus rowid ordering in SQLite. Cross-agent leakage is fixed: ContextBuilder no longer injects embeddings scoped to other agents, and the in-memory, Postgres and Qdrant embedding stores now filter consistently by metadata.agentId and metadata.threadId. The 'relevant' strategy, which used to throw 'not implemented', now works. Hybrid no longer wastes 30% of the budget and keeps chronological order. Compaction puts the summary before the kept messages and includes tool calls. SessionManager.list() works without userId through an index thread, delete() updates the index, and compact() delegates to an optional CompactionService. Redis adapter: cluster hash-tag prefix, TTL refresh on the thread key, stale index pruning, and errors returned as results. Postgres search returns failures instead of throwing, and MongoDB gets a compound index. CoreFactsStore writes are transactional, embedding fetch retries network errors and honours Retry-After, and graph LIKE now escapes wildcards. README (including snippets that did not compile) and the memory docs were updated.

  **Breaking changes**
  - createThread with an existing thread id now upserts metadata instead of resetting (in-memory) or failing (SQLite/MongoDB)
  - Semantic context no longer includes embeddings whose metadata.agentId belongs to another agent
  - Qdrant filters use metadata.threadId/metadata.agentId payload keys
  - SessionManager constructor accepts an options object { compaction }; compact() throws without it

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/redis@0.3.0
  - @cogitator-ai/types@0.23.0

## 0.6.22

### Patch Changes

- Comprehensive audit: ~560 bugs fixed across 16 packages

  Second-pass audit of all major packages with deep source review,
  automated fixes, and test updates. Key security fixes include SSRF
  protection (rag, a2a), sandbox escape prevention via worker_threads
  (self-modifying), broken MD5/Ed25519 crypto (wasm-tools), prototype
  chain bypass (server adapters), and MCP input schema validation.
  - memory: 58 fixes (adapters try/catch, embedding retry/timeout, knowledge graph UNION ALL, BM25 inverted index)
  - workflows: ~100 fixes (concurrency enforcement, cancel/abort wiring, cron double-fire race, setTimeout overflow)
  - swarms: ~70 fixes (Redis atomic writes via Lua, pipeline goto guard, approval Promise hang, delegation race)
  - rag: 31 fixes (SSRF protection, PDF splitPages rewrite, recursive chunker offsets, MMR lambda wiring)
  - a2a: 24 fixes (busy-loop fix, HMAC nested fields, SSRF IPv6 bypass, auth enforcement, Redis atomic update)
  - voice: 45 fixes (VAD race serialization, Deepgram timeout, TTS safe body access, SileroVAD dispose)
  - browser: 41 fixes (stealth flags controllable, smartSelect crash, path traversal, screenshot dimensions)
  - neuro-symbolic: 58 fixes (semicolon lexer, PRNG OOB, Ed25519 curve math, extractJSON string-aware, plan repair)
  - self-modifying: 63 fixes (worker_threads sandbox, safety constraints enforced, dead triggers wired, shouldAdopt logic)
  - wasm-tools: 27 fixes (MD5 BigInt padding, CSPRNG keygen, plugin leak, extism API fix, serialization queue)
  - mcp: 17 fixes (per-request transport, Zod raw shape inputSchema, body size limit, callTool all content blocks)
  - server adapters: 26 fixes (Object.hasOwn prototype bypass, error masking, abort signal, CORS credentials)
  - types: allowReverseTraversal, baseUrl, dimensions fields added
  - CI: retired models updated, http.test.ts mocked, TEST_MODEL upgraded to gpt-oss:20b

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 0.6.21

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 0.6.20

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 0.6.19

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 0.6.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 0.6.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/redis@0.2.24

## 0.6.14

### Patch Changes

- fix(memory): audit — 42 bugs fixed, +122 tests, v0.6.14
  - Fix SQL injection via schema name in Postgres and knowledge graph adapters
  - Fix Qdrant deleteEmbedding (wrong filter), metadata collision, search reconstruction
  - Fix Postgres keywordSearch params corruption, getEntries limit subquery, ILIKE injection
  - Fix Redis zrangebyscore exclusive bounds inconsistency
  - Fix BM25 duplicate query term scoring
  - Fix context builder facts/semantic context dropped without system prompt
  - Fix knowledge graph traversal paths, bidirectional edge support, merge self-references
  - Fix embedding services: add dimensions config to Google/OpenAI API requests
  - Add missing Zod schemas (SQLite, MongoDB, Qdrant configs)
  - Add EmbeddingProvider 'google' to types, OpenAIEmbeddingConfig dimensions field
  - Add createEmbeddingAdapter factory, export missing adapter config types
  - Fix dependencies: add missing optional/peer deps, move @types to devDeps
  - Add SQLite PRAGMA foreign_keys enforcement
  - Remove dead code (indexedIds, unused schema types)
  - Add 122 new tests (BM25, RRF, schema validation)

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/redis@0.2.23

## 0.6.13

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/redis@0.2.22

## 0.6.11

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/redis@0.2.20

## 0.6.10

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/redis@0.2.19

## 0.6.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/redis@0.2.18

## 0.6.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/redis@0.2.17

## 0.6.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/redis@0.2.16

## 0.6.6

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/redis@0.2.15

## 0.6.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/redis@0.2.14

## 0.6.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/redis@0.2.13

## 0.6.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/redis@0.2.12

## 0.6.2

### Patch Changes

- docs: sync package READMEs with main documentation

## 0.6.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/redis@0.2.11

## 0.6.0

### Minor Changes

- feat(memory): implement hybrid search with BM25 + vector fusion

  Add comprehensive hybrid search capability combining keyword search (BM25) with semantic vector search using Reciprocal Rank Fusion (RRF):
  - BM25Index class with inverted index for fast keyword search
  - Tokenizer with stopword filtering and text normalization
  - RRF algorithm for combining ranked results from different sources
  - HybridSearch class with three search strategies: vector, keyword, hybrid
  - PostgreSQL adapter extended with tsvector/tsquery full-text search
  - InMemoryEmbeddingAdapter for testing without database dependency
  - New types: SearchStrategy, SearchOptions, SearchResult, HybridSearchConfig

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/redis@0.2.10

## 0.5.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/redis@0.2.9

## 0.5.1

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/redis@0.2.8

## 0.5.0

### Minor Changes

- Phase 5: Memory adapters and observability integrations

  Memory Adapters:
  - SQLite adapter with WAL mode for zero-config local development
  - MongoDB adapter for flexible document storage
  - Qdrant vector adapter for semantic similarity search

  Observability:
  - Langfuse exporter for LLM-native observability
  - OpenTelemetry OTLP exporter for universal tracing

  All adapters use dynamic imports - install only what you need.

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/redis@0.2.7

## 0.4.3

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/redis@0.2.6

## 0.4.2

### Patch Changes

- 218d91f: feat: add vision / multi-modal support

  Message content now supports images in addition to text:
  - `MessageContent` = `string | ContentPart[]`
  - `ContentPart` can be `text`, `image_url`, or `image_base64`

  All LLM backends updated to handle multi-modal content:
  - **OpenAI**: `image_url` parts with detail level support
  - **Anthropic**: `image` source with URL or base64
  - **Google Gemini**: `inlineData` and `fileData` parts
  - **Ollama**: `images` array with base64 data

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/redis@0.2.5

## 0.4.1

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/redis@0.2.4

## 0.4.0

### Minor Changes

- f874e69: ### Memory improvements
  - Add optional `threadId` parameter to `createThread()` in MemoryAdapter interface for proper thread linking
  - Add Google embedding service using `text-embedding-004` model (768 dimensions)
  - Implement hybrid context strategy (30% semantic + 70% recent messages)
  - Fix foreign key constraint violation when saving entries before thread creation

  ### Swarms improvements
  - Add `saveHistory` option to `SwarmRunOptions` to control memory saving per run
  - Fix negotiation strategy import conflict (renamed file to avoid directory resolution issue)
  - Fix coordinator to properly register pipeline stages and handle missing negotiation section

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/redis@0.2.3

## 0.3.1

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/redis@0.2.2

## 0.3.0

### Minor Changes

- feat: add Knowledge Graph Memory and Prompt Auto-Optimization

  **Knowledge Graph Memory:**
  - PostgresGraphAdapter for entity-relationship storage with pgvector
  - Multi-hop graph traversal with BFS/DFS algorithms
  - Shortest path finding between nodes
  - Semantic node search with embeddings
  - LLMEntityExtractor for extracting entities/relations from text
  - GraphInferenceEngine for rule-based relationship inference
  - GraphContextBuilder for graph-aware context building

  **Prompt Auto-Optimization:**
  - PostgresTraceStore for persistent trace and prompt storage
  - PromptLogger wrapper for capturing all LLM prompts
  - ABTestingFramework with Welch's t-test statistical analysis
  - PromptMonitor for real-time performance monitoring with degradation detection
  - RollbackManager for instruction version control
  - AutoOptimizer for automated optimization pipeline with A/B testing

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/redis@0.2.1

## 0.2.0

### Minor Changes

- Add Redis adapter tests (connect, cluster mode, thread/entry CRUD)
- Add Postgres adapter tests (thread/entry/fact/embedding operations)
- Add embedding service tests (OpenAI, Ollama, factory)
- Fix context builder strategies: `relevant` and `hybrid` now throw explicit errors (not yet implemented)

### Breaking Changes

- Context builder `relevant` and `hybrid` strategies now throw errors instead of silently using `recent` strategy

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/redis@0.1.1
