# @cogitator-ai/worker

## 0.13.4

### Patch Changes

- Updated dependencies [[`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a)]:
  - @cogitator-ai/types@0.85.0
  - @cogitator-ai/core@0.74.0
  - @cogitator-ai/swarms@0.15.7
  - @cogitator-ai/workflows@0.15.1

## 0.13.3

### Patch Changes

- Updated dependencies [[`74439c2`](https://github.com/cogitator-ai/Cogitator-AI/commit/74439c22cce3f000a35a104392b6d290dbb3327d)]:
  - @cogitator-ai/types@0.84.0
  - @cogitator-ai/core@0.73.0
  - @cogitator-ai/workflows@0.15.0
  - @cogitator-ai/swarms@0.15.6

## 0.13.2

### Patch Changes

- Updated dependencies [[`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445)]:
  - @cogitator-ai/types@0.83.0
  - @cogitator-ai/core@0.72.0
  - @cogitator-ai/swarms@0.15.5
  - @cogitator-ai/workflows@0.14.24

## 0.13.1

### Patch Changes

- Updated dependencies [[`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6)]:
  - @cogitator-ai/types@0.82.0
  - @cogitator-ai/core@0.71.0
  - @cogitator-ai/swarms@0.15.4
  - @cogitator-ai/workflows@0.14.23

## 0.13.0

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
  - @cogitator-ai/core@0.70.0
  - @cogitator-ai/swarms@0.15.3
  - @cogitator-ai/workflows@0.14.22

## 0.12.6

### Patch Changes

- Updated dependencies [[`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4)]:
  - @cogitator-ai/types@0.80.0
  - @cogitator-ai/core@0.69.0
  - @cogitator-ai/swarms@0.15.2
  - @cogitator-ai/workflows@0.14.21

## 0.12.5

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/types@0.79.0
  - @cogitator-ai/core@0.68.1
  - @cogitator-ai/swarms@0.15.1
  - @cogitator-ai/workflows@0.14.20

## 0.12.4

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0
  - @cogitator-ai/core@0.68.0
  - @cogitator-ai/swarms@0.15.0
  - @cogitator-ai/workflows@0.14.19

## 0.12.3

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0
  - @cogitator-ai/core@0.67.0
  - @cogitator-ai/swarms@0.14.18
  - @cogitator-ai/workflows@0.14.18

## 0.12.2

### Patch Changes

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/types@0.76.0
  - @cogitator-ai/core@0.66.0
  - @cogitator-ai/swarms@0.14.17
  - @cogitator-ai/workflows@0.14.17

## 0.12.1

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0
  - @cogitator-ai/core@0.65.0
  - @cogitator-ai/swarms@0.14.16
  - @cogitator-ai/workflows@0.14.16

## 0.12.0

### Minor Changes

- [#293](https://github.com/cogitator-ai/Cogitator-AI/pull/293) [`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8) - Steer a run while it goes on, choose what a second message does to a busy thread, pause a run on a question a tool asks, and cancel a run without losing what it showed or did.

  Behavior changes, none of which needs a code change:

  - An aborted run (its `signal`, its timeout, `handle.abort()` or a newer run that interrupts it) now leaves more in its thread: the text it already streamed as an assistant message with `metadata.interrupted: true`, the results of tool calls that finished before the abort, and `Aborted before dispatch` for the calls it never started. Before, it left only its `interrupt` entry. A tool that ignores the signal still runs on, its late result is never written.
  - History read from memory now answers a tool call left without a result (a crash, an abort while the tool ran) with `The run stopped before this tool call returned: outcome unknown, verify before retrying`, instead of dropping the call from the assistant message. The model learns the call may have run. The log is not rewritten. Code that sends `history` of its own is not affected.
  - A paused run's `output` is the text of its last assistant message. For a pause on approvals this is what it always was.

  New:

  - `cog.start(agent, options)` returns a `RunHandle`: `steer(message)` adds a user message after the current step's tool calls (none is skipped) and wakes an agent about to stop, `followUp(message)` runs once the agent would stop (with a fresh `maxIterations`), `inject(message)` adds context to the next model call without waking the agent (one left at the end is saved to the thread), `abort(reason?)` stops the run and returns what it did not deliver, and `result` is what `run()` returns. `queue: { steering, followUp }` takes queued messages `'one-at-a-time'` (default) or `'all'` at once. Delivered messages are saved as `message` entries with `metadata.queued`, so a later run reads them as history, and a run that pauses returns the rest in `result.undelivered`. `run()` is unchanged.
  - `multitaskStrategy` (`RunOptions`, or `CogitatorConfig` for every run) says what a run does when another run of the runtime goes on in its thread, with the names of LangGraph's `multitask_strategy`: `enqueue` waits, `reject` fails with `THREAD_BUSY` (409), `interrupt` aborts the running one (it fails with `RUN_INTERRUPTED`, 409), `rollback` interrupts it and runs on a branch from where it started, so the thread goes on as if it never happened. Unset, runs of one thread go on side by side as before. A run started from a tool call of the run going on is never held back, other runs of the same trace follow the strategy.
  - Tools pause a run to ask a person with `context.interrupt({ reason, message, responseSchema, expiresAt })`. The run returns `status: 'paused'` with the question in `result.interrupts` (`id`, `kind: 'input'`, `reason`, `message`, `responseSchema` as JSON Schema, `expiresAt`, `toolCallId`, `toolName`), and `cog.resume(agent, thread, { responses: { [id]: answer } })` checks the answer against the schema and runs the tool again, where `interrupt()` returns it, parsed by a Zod schema. A wrong answer fails the resume with `INTERRUPT_ANSWER_INVALID` (400, `details.interruptId`), one after `expiresAt` with `INTERRUPT_EXPIRED` (410), and the run still waits. Finished calls of the same step keep their results. The pause and the resume are logged as `interrupt` entries (`status: 'paused' | 'resumed'`).
  - The run result wire format (`toAgentWireRunResult`) keeps `interrupts`, and `AgentRunPausedError` says when a workflow node or a swarm turn paused on questions instead of approvals.
  - Tool calls of a step run one after another, and the step stops at the first question: the calls after it run once the answer came. With `parallelToolCalls: true` the other calls run before the answer. Calls that finished keep their results, the checkpoint lists them in `turn.completed`, and a handoff among them hands over once the resumed step is done. A resume that leaves a question unanswered pauses on it again as it was asked, its tool not run again and its `expiresAt` unchanged. Answers are checked with the tool's Zod schema (refinements included) while the process that asked keeps it, else with the stored JSON Schema of the schema's input side.
  - A run with a `multitaskStrategy` is refused with `THREAD_ACCESS_DENIED` before it touches another user's run going on in the thread. A follow-up or steering message starts a new task, so its first tool call is never taken for a duplicate. `handle.abort()` is final: what it returns was never delivered or saved, also when it comes after the last model turn.
  - Queued messages pass the run's `beforeRun` input checks (PII in `block` mode, prompt injection, input guardrails, your own hooks) before they reach the model or the thread, injected messages saved at the end too. A refused message is dropped and listed in `handle.refused` with its error (`onRefusedMessage` in the options of `start()`), the run goes on.
  - A question that expired without an answer no longer holds the run: a resume answers its tool call with `Nobody answered "<message>" before it expired`, so other questions of the step can be answered alone. Calls of a step that never ran get "Not started" when the user moves on. A run whose signal aborted already, and a run of another user on a thread whose run has not written anything yet, change nothing on the thread.
  - `saveInterruptedReply: false` keeps an aborted run from saving its streamed text, and the voice runner uses it, so an interrupted voice turn keeps only what the caller heard, as before.
  - Resume a checkpoint with the same or a newer version: from this release the turn of a pause on a question lists all its calls, the finished ones in `turn.completed`, and an older version would run those again. The checkpoint stays `version: 1`.
  - `multitaskStrategy` is part of the config schema, so `defineConfig()` and `cogitator.yml` keep it.
  - Approvals are interrupts of `kind: 'approval'` keyed by tool call id: `result.interrupts` lists them, and `responses` decides them as `decisions` does. `decisions`, `defaultDecision` and `pendingApprovals` work as before. `RunCheckpoint` stays `version: 1` with optional `interrupts` and `iterationLimit`, older checkpoints resume as they did.
  - `@cogitator-ai/core` exports `ABORTED_BEFORE_DISPATCH`, `OUTCOME_UNKNOWN`, `repairUnansweredToolCalls()`, `APPROVAL_RESPONSE_SCHEMA` and `isToolInterrupt()` (rethrow it from a `wrapToolCall` middleware that catches tool errors). `@cogitator-ai/types` adds `RunHandle`, `StartOptions`, `QueuedRunMessage`, `MultitaskStrategy`, `RunInterrupt`, `InterruptRequest`, `ToolContext.interrupt` and the error codes `THREAD_BUSY`, `RUN_INTERRUPTED` and `INTERRUPT_EXPIRED`.
  - Server adapters (Express, Fastify, Hono, Koa, Tetsu, Next.js) take `multitaskStrategy` in run, stream and WebSocket run requests and `responses` in resume requests. A paused run that waits on questions of its tools carries them in `interrupts` of the JSON answer, the `finish` event and the WebSocket `complete` event, and its stream sends the new `interrupt-required` event instead of `approval-required`. `@cogitator-ai/server-shared` adds `runRequestRunOptions()`, `MULTITASK_STRATEGIES`, `createInterruptRequiredEvent()`, `toPendingInterrupts()`, `PendingInterrupt` and their schemas, and the OpenAPI document lists the new fields. `useCogitatorChat` keeps `pendingInterrupts`, calls `onInterruptRequired`, and resumes with `resume({ responses })`. With `multitaskStrategy: 'enqueue'` or `'reject'` it no longer aborts the request in flight when a new message is sent, and a refused message shows as an error without touching the running answer. Swarm routes ignore `multitaskStrategy` in every adapter. A stream refused or interrupted this way answers `200` with an `error` event carrying the code, the JSON routes `409` (`410` for `INTERRUPT_EXPIRED`).
  - The Gateway's `queueMode` takes the run strategies too: `enqueue` (the same as `sequential`), `reject` (a message for a busy thread runs nothing, reaches the new `message:rejected` hook, is never handed back to its channel, and makes `injectMessage` reject) and `rollback` (as `interrupt`, then the new message is answered on a branch from where the stopped answer started). Every gateway run names the strategy its queue mode stands for, so the runtime's `multitaskStrategy` never contradicts the queue (`parallel` names none). `sequential`, `parallel`, `interrupt` and `collect` work as before. Cogitator Studio labels pauses on questions and their answers in the thread tree.
  - Pauses on questions of tools never resume without answers anywhere. `pendingQuestions(result)` lists them, and `AgentRunPausedError` carries them in `interrupts`. A workflow `agentNode` fails with it, also with an approval store or `approvals: false`, where it used to resume without an answer forever. Swarm turns and queued workflow jobs fail the same way, and `JobQueue.resumeAgentJob` takes `responses`. The Gateway asks the question in the chat and takes the user's next message as the answer, and the voice runner says it and takes the caller's next turn. A2A tasks wait in `input-required` with an `interrupt-request` part and take the answer back (`A2AClient.answerQuestions()`). MCP servers ask through elicitation. The OpenAI-compatible APIs, Studio and delegated `agentAsTool` runs end with an error that names the questions, and the AI SDK provider warns with them (`providerMetadata.cogitator.pendingQuestions`).
  - `parseAnswer(text, schema)` and `answerFormat(schema)` (`@cogitator-ai/types`) read a typed or spoken answer by the question's schema and say what an answer looks like. `cog.pausedRun(threadId)` lists what a thread waits on, `cog.cancelPause(threadId, { userId, reason })` ends a pause with declined results. The Gateway shows the format with the question, tells a wrong answer in plain words, cancels a question with a cancel word (`approvals.cancelWords`, `cancel` by default) or after `approvals.maxAnswerAttempts` wrong answers (3), ends an expired one, and picks up a question waiting across a restart. The voice runner reads spoken answers the same way. A2A tasks keep their paused run by task, so a new task in the same context no longer answers the wrong run (the older task ends `canceled`), an expired question fails its task and lifts the pause, and text answers are read by the schema. MCP elicitation carries the schema's limits, asks again on a refused answer (3 times at most) and waits `elicitationTimeoutMs` (10 minutes by default) instead of 60 seconds.

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0
  - @cogitator-ai/core@0.64.0
  - @cogitator-ai/workflows@0.14.15
  - @cogitator-ai/swarms@0.14.15

## 0.11.14

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/core@0.63.1
  - @cogitator-ai/swarms@0.14.14
  - @cogitator-ai/workflows@0.14.14

## 0.11.13

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/core@0.63.0
  - @cogitator-ai/swarms@0.14.13
  - @cogitator-ai/workflows@0.14.13

## 0.11.12

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/swarms@0.14.12
  - @cogitator-ai/workflows@0.14.12

## 0.11.11

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/swarms@0.14.11
  - @cogitator-ai/workflows@0.14.11

## 0.11.10

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - @cogitator-ai/swarms@0.14.10
  - @cogitator-ai/workflows@0.14.10

## 0.11.9

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/swarms@0.14.9
  - @cogitator-ai/workflows@0.14.9

## 0.11.8

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/swarms@0.14.8
  - @cogitator-ai/workflows@0.14.8

## 0.11.7

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/swarms@0.14.7
  - @cogitator-ai/workflows@0.14.7

## 0.11.6

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/swarms@0.14.6
  - @cogitator-ai/workflows@0.14.6

## 0.11.5

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/swarms@0.14.5
  - @cogitator-ai/workflows@0.14.5

## 0.11.4

### Patch Changes

- Updated dependencies [[`dd055e4`](https://github.com/cogitator-ai/Cogitator-AI/commit/dd055e4dd0d1a4ddd4d255bc04117458b03cefd7)]:
  - @cogitator-ai/swarms@0.14.4

## 0.11.3

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/swarms@0.14.3
  - @cogitator-ai/workflows@0.14.4

## 0.11.2

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/swarms@0.14.2
  - @cogitator-ai/workflows@0.14.3

## 0.11.1

### Patch Changes

- Updated dependencies []:
  - @cogitator-ai/core@0.56.4
  - @cogitator-ai/swarms@0.14.1
  - @cogitator-ai/workflows@0.14.2

## 0.11.0

### Minor Changes

- [#250](https://github.com/cogitator-ai/Cogitator-AI/pull/250) [`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34) - Distributed swarms take a Redis url, TLS and Redis Cluster, and their job queue no longer loses a turn when a worker dies or a result when the coordinator reconnects

  `DistributedSwarmConfig.redis`, `DistributedSwarmWorkerConfig.redis` and `QueueConfig.redis` share `RedisConnectionConfig` from `@cogitator-ai/types` (`url`, `host`, `port`, `username`, `password`, `db`, `tls`, `cluster.nodes`), with `keyPrefix` on top for swarms. The `url` is read first (`rediss://` turns on TLS) and the explicit fields win over it. With `cluster` the coordinator, its message bus, blackboard and events, and the workers connect to a Redis Cluster.

  Breaking: the keys carry Redis Cluster hash tags with literal braces, so each group sits in one slot. The queue moved from `<prefix>:jobs:<queue>` to `<prefix>:jobs:{<queue>}` and the swarm state from `<prefix>:<swarmId>:...` to `<prefix>:{<swarmId>}:...`. A coordinator and a worker on different versions do not see the same queue, so upgrade coordinators and workers together.

  `DistributedSwarmWorker` moves a turn with `BLMOVE` from the queue to its own list `<queue key>:processing:<workerId>`, which needs Redis 6.2 or newer, and takes it off once the turn is done. It keeps a heartbeat key `<queue key>:heartbeat:<workerId>` (expiring after three `heartbeatInterval`s, 5000 ms by default) and is listed in the set `<queue key>:workers`. On start and on every beat, a worker moves the turns of workers whose heartbeat is gone back to the head of the queue, drops those workers from the set and reports `onJobsRecovered(workerId, count)`. A worker also hands back a turn on its own list that it does not run at two beats in a row, such as one a `BLMOVE` moved while a dropped connection lost its reply. A worker silent for three intervals counts as gone, so a turn on a stalled worker can run twice. `stop()` hands back what is left on its list, leaves the set and deletes its heartbeat, and `getWorkerId()` gives the worker's id.

  The worker keeps each result under the job's `stateKeys.result` (`<prefix>:{<swarmId>}:result:<jobId>`) for `resultTtl` ms, which the coordinator sets to the larger of `timeout` and `cleanupAfter`, and then publishes it. The coordinator reads the stored result when a turn times out, when either of its connections reconnects and every few seconds, so a result published while it reconnected, or while a cluster moved its subscriber, is not lost. A result the worker cannot keep is still published. A worker skips a job whose result is already there, such as one a dead worker answered before it took the turn off its list, and the coordinator deletes the stored result before it re-dispatches a retry. `processSwarmAgentJob` keeps the result the same way when its publisher has `set`, `JobQueue.addSwarmAgentJob` names the swarm keys under the swarm's hash tag with a result key by default and takes a `resultTtl`, and `SwarmResultPublisher` is now an alias of `SwarmResultClient` (`publish`, optional `set`).

  `@cogitator-ai/swarms` exports `swarmQueueKeys`, `deliverSwarmJobResult`, `DEFAULT_SWARM_RESULT_TTL`, `resolveRedisOptions`, `clusterNodeOptions`, `createSwarmRedis`, `duplicateSwarmRedis`, `scanSwarmKeys` and `closeSwarmRedis`, with the types `SwarmQueueKeys`, `SwarmResultClient`, `RedisConnectionOptions` and `SwarmRedis`. `RedisMessageBus`, `RedisBlackboard` and `RedisSwarmEventEmitter` take an ioredis `Redis` or `Cluster`. `@cogitator-ai/worker` still exports `resolveRedisOptions`, now from `@cogitator-ai/swarms`.

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/swarms@0.14.0
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/workflows@0.14.1

## 0.10.0

### Minor Changes

- [#249](https://github.com/cogitator-ai/Cogitator-AI/pull/249) [`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52) - Workflow jobs in the worker run on the workflow executor with checkpointed retries, jobs take an id for safe re-adds, and workflow and swarm jobs report usage

  Workflow jobs run on the `WorkflowExecutor` of `@cogitator-ai/workflows`, now a dependency of the worker, with the same `SerializedWorkflow` graphs and node semantics (agent, transform, condition and parallel nodes, a graph with many roots starting at all of them). Nodes run in rounds, each running at once every node whose nodes before it all settled. A failing node aborts the agent runs next to it and the job fails once they settled.

  A workflow job keeps one checkpoint, saved over after every node under the job's id and `runId`, in `WorkerRuntime.checkpoints`, which `WorkerPool` defaults to a `RedisCheckpointStore` in its Redis under `<queue prefix>:<queue name>:workflow-checkpoints`, kept `checkpointTtl` seconds after the last save (7 days by default). A job BullMQ retries goes on from it instead of running its finished agent nodes again. The checkpoint is deleted once the run finished, and once no attempt follows a failure (the last attempt, a cancelled job, a paused agent run), while a job a shutdown stopped keeps it for the worker that takes the job up. `processWorkflowJob` called on its own runs without checkpoints unless `runtime.checkpoints` is given, and then takes `execution.willRetry(error)`. The run keeps its bookkeeping in state keys starting with `__cogitator:`, left out of the output, and input keys, node ids and output keys with that prefix are refused.

  `addAgentJob`, `resumeAgentJob`, `addWorkflowJob`, `addSwarmJob` and `addSwarmAgentJob` take a `jobId`: adding a job whose id the queue holds already returns that job instead of adding a second one, also when two adds race, so producers can retry an add. An id the queue removed adds a new job. An empty id, one with `:`, an integer, a name of the queue's own BullMQ keys and an id the queue holds as another kind of job are refused.

  `NodeContext.idempotencyKey` (`workflow:<workflowId>:node:<name>:visit:<n>`) stays the same when a node is retried or its run resumed and changes when the workflow comes back to the node, for external APIs that take an idempotency key.

  `WorkflowJobResult` and `SwarmJobResult` now always carry `usage` (`JobUsage`: tokens, cost and agent runs, by agent for swarms), so code that builds these results itself has to set it. The metrics count `cogitator_job_tokens_total`, `cogitator_job_input_tokens_total`, `cogitator_job_output_tokens_total` and `cogitator_job_cost_usd_total` of completed jobs by type (`MetricsCollector.recordUsage`).

  `RedisCheckpointStore` takes a `ttl` in seconds, for clients with `expire` and `zrangebyscore`. `WorkflowScheduler.runParallelWithCallback` waits for the tasks in flight before it rejects with the first failure, as `runParallel` does, so a per-node checkpointed run no longer fails while nodes next to the failing one still run.

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/workflows@0.14.0
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/swarms@0.13.12
  - @cogitator-ai/core@0.56.2

## 0.9.24

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/swarms@0.13.11

## 0.9.23

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/swarms@0.13.10

## 0.9.22

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/swarms@0.13.9

## 0.9.21

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/swarms@0.13.8

## 0.9.20

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/swarms@0.13.7

## 0.9.19

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/swarms@0.13.6

## 0.9.18

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/swarms@0.13.5

## 0.9.17

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/swarms@0.13.4

## 0.9.16

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/swarms@0.13.3

## 0.9.15

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/swarms@0.13.2

## 0.9.14

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/core@0.47.0
  - @cogitator-ai/swarms@0.13.1

## 0.9.13

### Patch Changes

- [#220](https://github.com/cogitator-ai/Cogitator-AI/pull/220) [`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43) - Telemetry follows the OpenTelemetry GenAI semantic conventions, and runs that belong together share one trace.

  - Spans carry `gen_ai.*` attributes next to the existing `llm.*`, `tool.*` and `run.*` ones: `invoke_agent` on `agent.run`, `chat` on model calls (provider, request parameters, response id, finish reasons, token usage with cache reads, cache writes and reasoning), `execute_tool` on tool calls. `GEN_AI` names them all.
  - Streamed model calls record `gen_ai.response.time_to_first_chunk`.
  - Trace and span ids are W3C ids (32 and 16 hex characters) instead of `trace_…` and `span_…`. Code that parsed the old prefixes needs to treat ids as opaque strings. `agent.run` is now an `internal` span instead of `server`.
  - `RunOptions.trace` puts a run under a given parent, with `parseTraceparent` and `formatTraceparent` for W3C headers. A run started inside a tool of another run joins that run's trace under the tool's span, and `withTraceContext` does the same for any code.
  - `registerTelemetry(observer)` watches every runtime of the process, and `cogitator.recordSpan()` reports spans of your own orchestration to a runtime's observers.
  - `telemetry: { captureContent: true }` in the config, or `captureContent: true` on an observer, records system instructions, input and output messages, tool definitions, and tool arguments and results on the spans in the convention's JSON shapes. Observers that did not ask for content never receive it.
  - The OTLP exporter sends the convention's span names (`chat gpt-5.5`, `execute_tool search`, `invoke_agent researcher`) and array attributes, and keeps the Cogitator name as `cogitator.span_name`.
  - Workflows put agent runs under their node span, or under a `workflow.run` (`invoke_workflow`) span reported to the runtime's observers when no workflow tracer is on. Workflows running at once on one tracer no longer nest into each other. The `LLM_*` span attribute constants of workflows are deprecated in favour of `GEN_AI`.
  - Swarms report a `swarm.run` (`invoke_workflow`) span and run their agents under it, distributed swarms on their workers too.
  - A paused run reports its `agent.run` span with status `unset`, and a resumed run continues its trace. Time travel and learning traces are stored under the run id, since runs can now share a trace id: `timeTravel.compare()` and `getCheckpoints()` take a run id, and still take a trace id that belongs to one recorded run.
  - A workflow tracer given a `traceparent` with sampling flags `00` (through `setContextFromHeaders`) now leaves the workflow unsampled, as the caller asked, and the trace a workflow runs in takes precedence over a header the tracer kept from an earlier request.
  - The studio's trace inspector shows the instructions, prompt and response of every model call.

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/swarms@0.13.0

## 0.9.12

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/swarms@0.12.12

## 0.9.11

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/swarms@0.12.11

## 0.9.10

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/swarms@0.12.10

## 0.9.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/swarms@0.12.9

## 0.9.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/swarms@0.12.8

## 0.9.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/swarms@0.12.7

## 0.9.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/swarms@0.12.6
  - @cogitator-ai/types@0.41.1

## 0.9.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/swarms@0.12.5

## 0.9.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/swarms@0.12.4

## 0.9.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/swarms@0.12.3

## 0.9.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/swarms@0.12.2

## 0.9.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/swarms@0.12.1

## 0.9.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Agents travel to other processes in one complete wire format. `toAgentWire(agent)` and `fromAgentWire(payload, { cogitator, tools })` in `@cogitator-ai/core` carry every `AgentConfig` field (stop sequences, timeout, handoff graphs, the response schema as JSON Schema and the rest) and route the model exactly as the sender would, and `toAgentWireRunResult` / `fromAgentWireRunResult` carry a run's outcome with its cost, duration and the `truncated`, `blocked` and `iterationLimitReached` flags. Worker agent, workflow and swarm jobs (`serializeAgent`, `SerializedAgent`) and distributed swarm turns now use them, which fixes several silent losses:

  - an agent with an explicit `provider` (`{ model: 'openai/gpt-5', provider: 'openrouter' }`) ran on a different provider after `serializeAgent`
  - `timeout`, `stopSequences` and `handoffs` were dropped by `serializeAgent`, so a long job failed at 120 s and a triage agent answered itself
  - agent nodes of worker workflow jobs dropped `responseFormat`, `topP` and `reasoning`, and now write the structured answer of a JSON schema agent to the state
  - distributed swarm turns dropped `responseFormat`, `reasoning`, `topP` and `onIterationLimit`, and reported cost 0 without `truncated`, so `resources.costLimit` never stopped a swarm and the debate retry of a reasoning-starved turn never ran

  A config with a key the receiving side does not know is now refused instead of run without that setting.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Cancellation now reaches the agent runs of swarms and queued jobs.

  - `SwarmRunOptions.signal` cancels a swarm run and aborts its agent turns in flight. `swarmNode`, `conditionalSwarmNode` and `parallelSwarmsNode` pass the workflow run's signal, so a node timeout, pause or cancel stops the swarm (it ran to the end before), and a retry of the node no longer fails with "Swarm is already running"
  - `WorkerPool` hands the abort signal BullMQ gives each job to its agent runs, workflow nodes and swarm turns. `pool.cancelJob(jobId)` stops a running job, and `stop()` aborts the jobs still running when its timeout runs out instead of letting them run on without a lock while another worker picks them up. The processors take `{ signal }` as a third argument
  - Distributed swarm turns that the swarm gave up on no longer run later: every retry of a turn reuses its job id and payload, a timed-out copy still queued is removed before the next push, and an aborted, timed-out or closed turn is taken off the queue and added to a cancelled set that `DistributedSwarmWorker` checks before and while it runs a turn (`cancelCheckInterval`, `onJobCancelled`)

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - An agent run that pauses for tool approvals no longer passes for a finished run in queues, workflows and swarms.

  - Worker agent jobs complete with `status: 'paused'`, the waiting calls and the checkpoint, and `JobQueue.resumeAgentJob(agentConfig, pausedResult, { decisions })` continues the run on any worker. Workflow and swarm jobs whose agent pauses fail without retries with an `AgentRunPausedError` instead of handing the model's text before the tool call to the next node.
  - `agentNode` asks for the waiting calls through the workflow's human-in-the-loop approval store (the `approvalStore` execute option, shaped by the new `approvals` option) and resumes the run once they are answered. Without a store, or with `approvals: false`, the node fails with an `AgentRunPausedError` that carries the checkpoint, and the executor does not retry it.
  - A swarm turn that pauses, local or distributed, fails with an `AgentRunPausedError` instead of answering with the pre-tool text. It is not retried, skipped or failed over and does not trip the circuit breaker.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Swarm topologies do what they say. The `collaborative` topology of worker swarm jobs ran only the first agent (it mapped to round-robin): now every agent contributes in each of `maxRounds` rounds (default 3), seeing the task and all contributions so far, and the `coordinator`, when given, combines them into the answer. The job reports every contribution in `agentOutputs` and the rounds it ran. Distributed swarms now refuse the hierarchical and negotiation strategies, whose delegation and offer tools only exist in-process, instead of letting the supervisor answer by itself. The JSDoc of `JobQueue.addSwarmAgentJob` no longer claims that distributed swarms use it: their turns go to `DistributedSwarmWorker`.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/swarms@0.12.0

## 0.8.10

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/swarms@0.11.1

## 0.8.9

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/swarms@0.11.0
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0

## 0.8.8

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/swarms@0.10.8

## 0.8.7

### Patch Changes

- Updated dependencies []:
  - @cogitator-ai/swarms@0.10.7

## 0.8.6

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4
  - @cogitator-ai/swarms@0.10.6

## 0.8.5

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3
  - @cogitator-ai/swarms@0.10.5

## 0.8.4

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/swarms@0.10.4
  - @cogitator-ai/types@0.33.1

## 0.8.3

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1
  - @cogitator-ai/swarms@0.10.3

## 0.8.2

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/swarms@0.10.2

## 0.8.1

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0
  - @cogitator-ai/swarms@0.10.1

## 0.8.0

### Minor Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Queued agents now do everything an in-process agent does with its answer and its bill. A job result carries `structured` (the validated answer of a JSON schema agent), the reasoning summary and `usage` with the run's cost, so a producer no longer parses JSON from `output` or prices tokens itself. `serializeAgent(agent)` builds a job from an existing agent, turning its Zod response schema into JSON Schema that the worker turns back into a schema, and carries its reasoning effort and `topP`. The redis config takes a `url` (`redis://`, or `rediss://` for TLS) with a username and a database, and explicit fields override it. Cluster nodes get the same username, password and TLS. `tokenUsage` stays for compatibility and is deprecated.

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/swarms@0.10.0
  - @cogitator-ai/types@0.31.0

## 0.7.3

### Patch Changes

- [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe) - Serialized agents now route like the same agent in-process. The worker only recognised built-in providers as a model prefix, so `model: 'openrouter/deepseek/deepseek-v4-pro'` with `provider: 'openai'` ran as `openai/openrouter/...` on the OpenAI backend (failing with "OpenAI API key is required") instead of on the worker's `openrouter` backend, and plugin providers were lost the same way. A model whose prefix names a built-in provider, a backend in the worker Cogitator's `llm.backends` or a registered plugin now runs there unchanged, and `provider` is prepended only to a model whose prefix names none. `SerializedAgent.provider` accepts any provider name (`LLMBackendProvider`), custom backends and plugins included, and is optional: without it such a model runs on the worker's `llm.defaultProvider`. A `provider` the worker cannot route to now fails the job with a clear error instead of silently running on the default provider.

  `JobQueue.getMetrics()` now counts jobs added with a `priority`. BullMQ keeps them in its `prioritized` state, which `waiting`, `depth` and the `cogitator_queue_depth` metric left out, so a queue of prioritized jobs looked empty to an autoscaler. They now count in `waiting` and `depth`. `getJobState()` returns the new `JobState` type, which lists `'prioritized'` and `'waiting-children'` next to the states documented before.

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/swarms@0.9.3

## 0.7.2

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2
  - @cogitator-ai/swarms@0.9.2

## 0.7.1

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1
  - @cogitator-ai/swarms@0.9.1

## 0.7.0

### Minor Changes

- c8648b0: The completed and failed job counts come from the jobs BullMQ keeps in Redis, which `removeOnComplete`/`removeOnFail` cap, so they drop as old jobs are trimmed, yet they were exported as counters (`cogitator_queue_completed_total`, `cogitator_queue_failed_total`), which broke `rate()` and `increase()`. They are now gauges named `cogitator_queue_completed` and `cogitator_queue_failed`. For a real failure counter, `WorkerPool` records jobs that failed their last attempt in `pool.metrics` (`MetricsCollector.recordFailure`), exported as `cogitator_jobs_failed_total{type}`.

### Patch Changes

- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [b8c9eca]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [d35ef2a]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [0e17a89]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/swarms@0.9.0

## 0.6.2

### Patch Changes

- Updated dependencies [e211b6a]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/types@0.28.0
  - @cogitator-ai/swarms@0.8.2

## 0.6.1

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/swarms@0.8.1

## 0.6.0

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
  - @cogitator-ai/core@0.23.0
  - @cogitator-ai/swarms@0.8.0

## 0.5.2

### Patch Changes

- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/swarms@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1
  - @cogitator-ai/swarms@0.6.1

## 0.5.0

### Minor Changes

- BullMQ 6; ioredis is a required peer (BullMQ no longer depends on it).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/swarms@0.6.0
  - @cogitator-ai/types@0.24.0

## 0.4.1

### Patch Changes

- @cogitator-ai/swarms@0.5.1

## 0.4.0

### Minor Changes

- Distributed swarm results never reached the coordinator: they had no jobId and nothing consumed the job list. A new DistributedSwarmWorker fixes this and is verified end to end with Redis and Ollama. Model strings were double-prefixed ('openai/openai/gpt-4'). Serialized tools were replaced by stubs that returned fake success; they are now resolved from the worker's tools registry and fail fast when missing. 4 of 5 swarm topologies always threw; the new buildSwarmConfig maps all of them. Workflow jobs threw 'not implemented' and now run on a validated DAG interpreter with agent, transform, condition and parallel nodes. WorkerConfig accepts a shared cogitator and tools runtime instead of creating a bare Cogitator per job. Redis cluster now uses a real ioredis Cluster instead of the first node only. Blocking connections set maxRetriesPerRequest: null. A forced stop closes everything, and the publisher is configured once instead of per job from env. getWorkersCount, job-duration metrics and Prometheus label escaping now work, and tool outputs are recovered. Payload types are aliased from swarms. README, docs and examples/infrastructure/03-worker-queue.ts were updated and verified.

  **Breaking changes**
  - processSwarmAgentJob(payload, { publisher, isFinalAttempt? }) now requires a publisher instead of building an env-based Redis client
  - Agents that reference tools need implementations registered in the worker `tools` option (stubs were removed)
  - SerializedAgent.provider widened to LLMProvider; maxIterations added
  - Workflow jobs now execute instead of throwing
  - Swarm agent job payload/result types now alias the @cogitator-ai/swarms contract

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/swarms@0.5.0
  - @cogitator-ai/types@0.23.0

## 0.3.20

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/swarms@0.4.20
  - @cogitator-ai/types@0.22.3

## 0.3.19

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/swarms@0.4.19

## 0.3.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/swarms@0.4.18

## 0.3.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/swarms@0.4.17

## 0.3.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7
  - @cogitator-ai/swarms@0.4.16

## 0.3.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6
  - @cogitator-ai/swarms@0.4.15

## 0.3.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5
  - @cogitator-ai/swarms@0.4.14
  - @cogitator-ai/workflows@0.5.10

## 0.3.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/swarms@0.4.13

## 0.3.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/redis@0.2.24
  - @cogitator-ai/core@0.18.4
  - @cogitator-ai/swarms@0.4.12
  - @cogitator-ai/workflows@0.5.9

## 0.3.11

### Patch Changes

- @cogitator-ai/core@0.18.3
- @cogitator-ai/swarms@0.4.11
- @cogitator-ai/workflows@0.5.8

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
  - @cogitator-ai/redis@0.2.23
  - @cogitator-ai/swarms@0.4.10
  - @cogitator-ai/workflows@0.5.7

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1
  - @cogitator-ai/swarms@0.4.9
  - @cogitator-ai/workflows@0.5.6

## 0.3.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/swarms@0.4.8
  - @cogitator-ai/workflows@0.5.5
  - @cogitator-ai/redis@0.2.22

## 0.3.6

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/redis@0.2.20
  - @cogitator-ai/swarms@0.4.6
  - @cogitator-ai/workflows@0.5.3

## 0.3.5

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/swarms@0.4.5
  - @cogitator-ai/workflows@0.5.2
  - @cogitator-ai/redis@0.2.19

## 0.3.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2
  - @cogitator-ai/swarms@0.4.4
  - @cogitator-ai/workflows@0.5.1

## 0.3.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.5.0
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/swarms@0.4.3
  - @cogitator-ai/core@0.17.1
  - @cogitator-ai/redis@0.2.18

## 0.3.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/swarms@0.4.2
  - @cogitator-ai/workflows@0.4.7
  - @cogitator-ai/redis@0.2.17

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/swarms@0.4.1
  - @cogitator-ai/workflows@0.4.6
  - @cogitator-ai/redis@0.2.16

## 0.3.0

### Minor Changes

- feat: distributed swarm execution via Redis

### Patch Changes

- Updated dependencies
  - @cogitator-ai/swarms@0.4.0

## 0.2.20

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/swarms@0.3.20
  - @cogitator-ai/workflows@0.4.5
  - @cogitator-ai/redis@0.2.15

## 0.2.19

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/swarms@0.3.19
  - @cogitator-ai/workflows@0.4.4
  - @cogitator-ai/redis@0.2.14

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/swarms@0.3.18
  - @cogitator-ai/workflows@0.4.3
  - @cogitator-ai/redis@0.2.13

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/swarms@0.3.17
  - @cogitator-ai/workflows@0.4.2
  - @cogitator-ai/redis@0.2.12

## 0.2.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.4.1
  - @cogitator-ai/core@0.11.5
  - @cogitator-ai/swarms@0.3.16

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/workflows@0.4.0
  - @cogitator-ai/core@0.11.4
  - @cogitator-ai/redis@0.2.11
  - @cogitator-ai/swarms@0.3.15

## 0.2.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/core@0.11.3
  - @cogitator-ai/redis@0.2.10
  - @cogitator-ai/swarms@0.3.14
  - @cogitator-ai/workflows@0.3.1

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.3.0
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/swarms@0.3.13
  - @cogitator-ai/core@0.11.2
  - @cogitator-ai/redis@0.2.9

## 0.2.12

### Patch Changes

- Updated dependencies [fec45e0]
  - @cogitator-ai/swarms@0.3.12

## 0.2.11

### Patch Changes

- @cogitator-ai/core@0.11.1
- @cogitator-ai/swarms@0.3.11
- @cogitator-ai/workflows@0.2.11

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0
  - @cogitator-ai/swarms@0.3.10
  - @cogitator-ai/workflows@0.2.10

## 0.2.9

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/swarms@0.3.9
  - @cogitator-ai/workflows@0.2.9
  - @cogitator-ai/redis@0.2.8

## 0.2.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/core@0.9.0
  - @cogitator-ai/redis@0.2.7
  - @cogitator-ai/swarms@0.3.8
  - @cogitator-ai/workflows@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/swarms@0.3.7
  - @cogitator-ai/workflows@0.2.7
  - @cogitator-ai/redis@0.2.6

## 0.2.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/swarms@0.3.6
  - @cogitator-ai/workflows@0.2.6
  - @cogitator-ai/redis@0.2.5

## 0.2.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1
  - @cogitator-ai/swarms@0.3.5
  - @cogitator-ai/workflows@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/swarms@0.3.4
  - @cogitator-ai/workflows@0.2.4
  - @cogitator-ai/redis@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/swarms@0.3.3
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/workflows@0.2.3
  - @cogitator-ai/redis@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/swarms@0.3.2
  - @cogitator-ai/workflows@0.2.2
  - @cogitator-ai/redis@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/core@0.3.0
  - @cogitator-ai/redis@0.2.1
  - @cogitator-ai/swarms@0.3.1
  - @cogitator-ai/workflows@0.2.1

## 0.2.0

### Minor Changes

- **Documentation**: Complete README rewrite to match actual API
  - Fixed Redis configuration examples (host/port instead of url)
  - Fixed addAgentJob/addWorkflowJob/addSwarmJob signatures
  - Fixed MetricsCollector usage examples
  - Added Redis cluster configuration examples

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/swarms@0.2.0
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/core@0.1.1
  - @cogitator-ai/redis@0.1.1
  - @cogitator-ai/workflows@0.1.1
