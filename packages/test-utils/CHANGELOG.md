# @cogitator-ai/test-utils

## 0.14.3

### Patch Changes

- Updated dependencies [[`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a)]:
  - @cogitator-ai/types@0.85.0

## 0.14.2

### Patch Changes

- Updated dependencies [[`74439c2`](https://github.com/cogitator-ai/Cogitator-AI/commit/74439c22cce3f000a35a104392b6d290dbb3327d)]:
  - @cogitator-ai/types@0.84.0

## 0.14.1

### Patch Changes

- Updated dependencies [[`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445)]:
  - @cogitator-ai/types@0.83.0

## 0.14.0

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

## 0.13.6

### Patch Changes

- Updated dependencies [[`cb4a7fa`](https://github.com/cogitator-ai/Cogitator-AI/commit/cb4a7fa20594805d6bf150f680185cc07520fec0)]:
  - @cogitator-ai/types@0.81.0

## 0.13.5

### Patch Changes

- Updated dependencies [[`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4)]:
  - @cogitator-ai/types@0.80.0

## 0.13.4

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/types@0.79.0

## 0.13.3

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0

## 0.13.2

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0

## 0.13.1

### Patch Changes

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/types@0.76.0

## 0.13.0

### Minor Changes

- [#294](https://github.com/cogitator-ai/Cogitator-AI/pull/294) [`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941) - Run safe tool calls together and keep writes of one file apart, give the application a richer tool result than the model reads, see tool calls while the model writes them, and give each stage of a run its own deadline.

  Breaking:

  - `parallelToolCalls: true` no longer runs every call of a step at once with `Promise.all`. Only calls that are concurrency-safe run together, in a pool of `maxParallelToolCalls` (10 by default), and a call that is not safe waits for every call before it, runs alone, then the rest go on. A tool that declares nothing is not safe, so a step of such tools now runs one call after another. To keep calls running side by side, mark their tools `isConcurrencySafe: true`, or `annotations: { readOnlyHint: true }` as MCP describes a read-only tool. Without `parallelToolCalls` nothing changes: every call runs after the one before it.
  - A Docker-sandboxed call that runs out of time now fails with `errorCode: 'TOOL_TIMEOUT'` and the error `Tool "<name>" timed out in the Docker sandbox after <n>ms`, as a WASM one already did, instead of returning `{ stdout, stderr, exitCode, timedOut: true, ... }` as its result. Code that read `result.timedOut` checks `errorCode === 'TOOL_TIMEOUT'` instead.

  New:

  - `tool({ isConcurrencySafe })` takes `true`, `false` or a check of the call's arguments (one that throws says no), and defaults to `annotations.readOnlyHint`, so MCP tools a server marks read-only are safe. Results reach the model in call order however the calls ran. After a call that asks a question (`context.interrupt()`) no further call of the step starts, the others run once the answer came. An abort answers the calls it kept from starting with `Aborted before dispatch`, and steering messages land after the whole step. A call scheduled as safe is checked again with the arguments a `wrapToolCall` middleware left: when they are not safe, it waits for the running calls of the step and runs alone, the calls after it wait (`StepGate`). A paused run keeps `parallelToolCalls`, `maxParallelToolCalls` and its own `timeouts` in `checkpoint.toolExecution` (optional, the checkpoint stays `version: 1`), and `resume()` reuses them unless its options set them, a kept `timeouts.totalMs` arming the deadline again unless the resume passes `timeouts.totalMs` or `timeout`.
  - `tool({ lockKeys: (args, context) => keys })` names what a call changes. Calls whose keys meet never run at the same time, in this run or any other run of the process, and go one after another in the order they asked, without ever waiting on each other. A safe tool with lock keys writes different files together and one file in order. `fileLockKey(path)` is `file:` and the file's real path, symlinks followed, also for a file not created yet. A lock key function that throws fails its call with `Could not tell what the call changes`, and a call whose run aborts while it waits gives up its place. Keys are let go only once the tool's own promise settles, also after `TOOL_TIMEOUT` or an abort: the run gets the timeout at once, the file stays locked until the tool really stops. Keys are re-entrant along the call lineage, so a nested run or `invokeTool()` started from a tool takes a key that tool holds without waiting. Time waiting for a key or for the step does not count toward `toolMs` or the tool's `timeout`, the run's `totalMs` still runs.
  - Built-in tools say how they run: `read_file`, `list_files`, `glob` and `grep` of `workspaceTools()` and `file_read`, `file_list` and `file_exists` are concurrency-safe, `write_file`, `edit_file`, `file_write` and `file_delete` lock the real path of the file they change. An absolute path inside the workspace root gets the same key as the relative one. `restrictFileTools()` keeps these fields, the lock keys getting the path it resolved.
  - `toolOutput({ content, details?, presentation? })` splits a result by reader: the model reads `content` (any JSON value or a `toolContent()` result), `onToolResult` gets `details` and `presentation` too (`ToolResult.details`, `ToolResult.presentation`), and memory keeps them in the metadata of the call's `tool_result` entry (`metadata.details`, `metadata.presentation`) while its `toolResults` keep only what the model read. `cog.invokeTool()` splits the result the same way, and so do the boundaries outside a run: `toAISDKTool()` of `@cogitator-ai/ai-sdk` without an invoker returns the whole `toolOutput()` result to the AI SDK application while its `toModelOutput` (`experimental_toToolResultContent` on ai@4) gives the model only `content`, and the OpenAI and Gemini realtime sessions of `@cogitator-ai/voice` send the model only `content` of a `RealtimeTool` that returns one. `toolOutputContent(value)` reads what a model sees of any result.
  - `tool({ presentation })` tells a client how to show a call without the tool's code, `{ label, icon?, detail? }` or a function of the arguments, used when the result carries none, failed calls too. The workspace tools present themselves as Read file, Write file, Edit file, List files, Find files, Search files and Run command, with the path, pattern or command as the detail.
  - `context.update({ content?, details?, presentation? })` reports what a running tool has so far: `onToolUpdate` of the run (with `callId` and `name`) and `onUpdate` of `invokeTool()` get it, nothing of it reaches the model or memory, and an update after the tool returned or after its run was aborted is dropped. Two calls that hold keys and, through tools they run, wait for each other's fail fast: the call that would close the circle gets `errorCode: 'TOOL_LOCK_CYCLE'` (new `ErrorCode.TOOL_LOCK_CYCLE`, 409, `LockCycleError` and `LockOwner` exported from core). A call's arguments are read by its schema once, for the safety check, the lock keys, the presentation and the tool, which all get the value the schema made, typed as its output (`ToolCallCheck<TParams>`, `ToolPresenter<TParams>`). A key is taken again without waiting only while the call that holds it still does, and a call aborted while it works out its keys never runs. A tool's `outputSchema` describes the `content` of a `toolOutput()` result (`ToolOutputContent<TResult>`), so an MCP server checks and sends `content` as `structuredContent`, while `execute` keeps the type it returns. The schema no longer widens the result type `execute` returns: a tool whose schema is wider than what its `execute` is inferred to return (a `z.record()` schema for an object literal) annotates the return type of `execute`.
  - Tool calls stream while the model writes them. The OpenAI-compatible backends (Azure OpenAI, OpenRouter and other servers through them), OpenAI Responses, Anthropic and Bedrock stream a call's id and name, then the pieces of its JSON arguments, in `ChatStreamChunk.delta.toolInput`, and an `end` part once the call is complete: Anthropic at `content_block_stop`, Responses at `function_call_arguments.done`, Bedrock at `contentBlockStop`, OpenAI-compatible servers when the next call starts and the previous one's arguments already read as a complete JSON object, else at a finish that may run tools (not at the token limit), so a call whose pieces a server mixes with another's loses none of them. The OpenAI-compatible backends keep the first non-empty id and name of a call. Gemini and Ollama get whole calls, each reported at once when it arrives. Streamed runs report them to `onToolInputStart`, `onToolInputDelta`, `onToolInputAvailable` and `onToolInputAbandoned`, and to the tool's own `onInputStart`, `onInputDelta`, `onInputAvailable` and `onInputAbandoned` hooks, named as in the AI SDK. Available fires as soon as a call is complete, and a call that never had argument text (an empty Anthropic input) gets its arguments as one delta, `{}`, before it. Every call `onToolInputStart` reported ends in `onToolCall` or in abandoned, with `reason: 'incomplete'` when its arguments never came complete (a turn cut at the token limit, failed or aborted) or `'discarded'` when the turn kept no such call (an `afterModel` middleware dropped it or gave it another tool, a turn that may not call tools, a turn cut at the token limit after the call was complete). Callbacks and hooks that throw are logged, the turn goes on. The hooks are read for each model turn, so after a handoff the tools of the new agent get them. A run whose middleware holds the stream (output guardrails) gets no input events, and a run streamed only for tool input keeps structured output repair, which is skipped only when text streamed to `onToken` or `onReasoning`.
  - `timeouts: { totalMs, stepMs, chunkMs, toolMs }` on `RunOptions` and `AgentConfig`, the run's fields over the agent's field by field, all off unless set. `totalMs` bounds the whole run (`RUN_TIMEOUT`, over `timeout`), `stepMs` one model call with its retries and fallback models (the new `RUN_STEP_TIMEOUT`, 504), `chunkMs` a streamed call without a chunk for that long (the new `RUN_CHUNK_TIMEOUT`, 504, not retried), and `toolMs` the calls of tools without a `timeout` of their own: such a call fails with `Tool "<name>" timed out after <n>ms` and `errorCode: 'TOOL_TIMEOUT'`, the model reads why and the run goes on. `ToolResult.errorCode` is new, and spans record it as `error.type`. The agent's `timeouts` travel in `serialize()` and the agent wire format. Unlike `llm.retry.requestTimeout`, which retries one attempt, a stage timeout ends the run.
  - `@cogitator-ai/core` exports `toolOutput`, `isToolOutputResult`, `isConcurrencySafe`, `scheduleToolCalls`, `DEFAULT_MAX_PARALLEL_TOOL_CALLS`, `KeyedLock`, `StepGate`, `toolLocks`, `fileLockKey` and `toolOutputContent`. `@cogitator-ai/types` adds `ToolOutputResult`, `ToolPresentation`, `ToolProgress`, `ToolUpdate`, `ToolInputStart`, `ToolInputDelta`, `ToolInputAvailable`, `ToolInputAbandoned`, `ToolInputStreamPart` (with `start`, `delta` and `end` parts), `RunCheckpoint.toolExecution`, `RunTimeouts`, `isToolOutputResult()` and `toolOutputContent()`.
  - The streaming protocol of the server adapters gets a `tool-update` event (`toolCallId`, `content?`, `details?`, `presentation?`) between a call's `tool-call-end` and its `tool-result`, and `tool-result` carries `details` and `presentation`. In a streamed run `tool-call-start`, `tool-call-delta` and `tool-call-end` now follow the model as it writes the call, the end coming as soon as the call is complete so calls do not interleave unless the provider mixes their pieces, and a run whose stream is held back sends the three at once right before the call runs, as before. A call that will never run gets a `tool-result` with the new `dropped: true` and `reason` (`'incomplete'` or `'discarded'`), after a `tool-call-end` with the new `dropped: true` when its end had not gone out, and the stream session drops, when it completes or fails, every call it announced that never came to run (calls that run or wait for approval are kept). A dropped call a middleware then gives another tool under the same id is announced again with a new `tool-call-start`, and a streamed call that runs with other arguments (an `afterModel` middleware changed them under the same id and name) gets a `tool-update` with the new `arguments` right after its end, which `useCogitatorChat` puts in place of the streamed ones before it reports the call to `onToolCall` again. A client that does not know `dropped` sees such a call as a call with an empty result. `@cogitator-ai/server-shared` adds `createToolUpdateEvent()`, `createToolDroppedEvent()`, the `dropped` argument of `createToolCallEndEvent()`, `ToolUpdateEvent`, `ToolUpdateEventSchema`, `ToolPresentationSchema` and the `dropped` and `reason` fields of `ToolCallEndEventSchema` and `ToolResultEventSchema`, and the OpenAPI document lists them. The Next.js and Tetsu stream handlers pass the new callbacks through, `onToolInputAbandoned` included. `useCogitatorChat` of `@cogitator-ai/next` never adds a dropped call to a message, removes a call whose result says `dropped` and calls the new `onToolCallDropped(toolCallId)` (`onToolCall` may have reported it before), and its `onToolResult` carries `details` and `presentation`.
  - `MockLLMBackend` of `@cogitator-ai/test-utils` takes `toolInput` in its stream chunks, so custom code that reads tool input is testable without a model.
  - Cogitator Studio shows a tool call by its presentation label and detail, its latest progress while it runs, and its details in a block of their own.

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0

## 0.12.13

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0

## 0.12.12

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0

## 0.12.11

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0

## 0.12.10

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/types@0.71.0

## 0.12.9

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0

## 0.12.8

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0

## 0.12.7

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0

## 0.12.6

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0

## 0.12.5

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0

## 0.12.4

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0

## 0.12.3

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/types@0.64.0

## 0.12.2

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/types@0.63.0

## 0.12.1

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0

## 0.12.0

### Minor Changes

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

## 0.11.2

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0

## 0.11.1

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0

## 0.11.0

### Minor Changes

- [#248](https://github.com/cogitator-ai/Cogitator-AI/pull/248) [`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3) - Memory files read only what stands. `MemoryFileAdapter.findFileHeads` gives the newest version of each scope and path a filter and a branch see, and `MemoryFiles` lists, views and indexes files through it, so a turn no longer reads the whole history of every file. Postgres and SQLite find the heads in SQL, InMemory, MongoDB and Redis in process, and MongoDB now asks only for batches holding a version of a scope the reader sees. A change that finds, once kept, a file of its own under another file or with files under it, which writers in two processes can make at the same time, is taken back, its own versions withdrawn (`withdrawFileVersions`, a new optional store method every built-in adapter has, `MemoryFileVersion.withdrawn`), and refused so the writer tries again. `fileHeads` finds heads in process for a store of your own, and the conformance kit checks `findFileHeads`.

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0

## 0.10.0

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

## 0.9.1

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0

## 0.9.0

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

## 0.8.0

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

## 0.7.0

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

## 0.6.2

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0

## 0.6.0

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

## 0.5.0

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

## 0.4.0

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

## 0.3.7

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/types@0.48.0

## 0.3.6

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/types@0.47.0

## 0.3.5

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/types@0.46.0

## 0.3.4

### Patch Changes

- [#209](https://github.com/cogitator-ai/Cogitator-AI/pull/209) [`bb83bdc`](https://github.com/cogitator-ai/Cogitator-AI/commit/bb83bdc6a5bfe5ec6985cd03385f0571a32218b7) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Add documentation and usage examples in README.md

## 0.3.3

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/types@0.45.0

## 0.3.2

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/types@0.43.0

## 0.3.0

### Minor Changes

- [#202](https://github.com/cogitator-ai/Cogitator-AI/pull/202) [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd) - A conformance kit for LLM backends. `backendConformanceCases(target)` runs one set of scenarios through a backend's real SDK against a fake provider that answers in that provider's wire format: an answer, tool calls with a tool stop and with a plain stop, a tool call cut at the token limit, a content filter, an error inside a stream, an abort, and rate limit, quota, authentication, overload, server and context overflow errors. The cases do not depend on a test runner, each `run()` throws an `AssertionError` when the backend breaks the contract.

  `startFakeProvider` serves HTTP/1.1 or HTTP/2 without TLS, and wires are included for OpenAI Chat Completions and Responses, Anthropic, Gemini, Ollama and Bedrock Converse, so a backend of your own for an OpenAI-compatible server can be checked with `openAIChatWire`.

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0

## 0.2.20

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/types@0.41.1

## 0.2.19

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0

## 0.2.18

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/types@0.40.0

## 0.2.17

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/types@0.39.0

## 0.2.16

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0

## 0.2.15

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0

## 0.2.14

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0

## 0.2.13

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0

## 0.2.12

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0

## 0.2.11

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2

## 0.2.10

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/types@0.33.1

## 0.2.9

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0

## 0.2.8

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0

## 0.2.7

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 0.2.6

### Patch Changes

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 0.2.5

### Patch Changes

- bbe49d6: `MockLLMBackend` records each request as it was sent. The runtime keeps appending to the same messages array, so every recorded call used to show the final conversation.
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

## 0.2.4

### Patch Changes

- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 0.2.3

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 0.2.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 0.2.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 0.2.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 0.1.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

## 0.1.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 0.1.9

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 0.1.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 0.1.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 0.1.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 0.1.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 0.1.4

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 0.1.2

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 0.1.1

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1
