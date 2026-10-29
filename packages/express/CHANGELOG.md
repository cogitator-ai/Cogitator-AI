# @cogitator-ai/express

## 0.16.1

### Patch Changes

- Updated dependencies [[`4483b63`](https://github.com/cogitator-ai/Cogitator-AI/commit/4483b63469c0c43b3a5f496186f56be0e512edfa)]:
  - @cogitator-ai/core@0.78.1

## 0.16.0

### Minor Changes

- [#319](https://github.com/cogitator-ai/Cogitator-AI/pull/319) [`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c) - AG-UI 1.0 on every server adapter, and three new kinds of stream events: data parts, run state and step resets.

  AG-UI:

  - Every adapter serves `POST /agents/:name/agui`: it takes an AG-UI `RunAgentInput` and streams the run as AG-UI events, so CopilotKit or an `@ag-ui/client` `HttpAgent` runs a Cogitator agent as it is. Next.js gets the same as `createAGUIHandler(cogitator, agent)`. The AG-UI thread is the run's memory thread, the last message (the user's) is the new turn, `state` is the run's state and `context` its brief. Auth, `authorizeThread`, `anonymous` and `deps` apply as on the other routes.
  - Text, reasoning, tool calls and results map one to one. Tool progress and data parts become activities (`ACTIVITY_SNAPSHOT`, then `ACTIVITY_DELTA` patches), state changes `STATE_DELTA`, foreground subagents and agents used as tools AG-UI subagents, workflow nodes steps.
  - A paused run ends with `RUN_FINISHED` and outcome `interrupt`, one `Interrupt` per approval or question, and the next request answers them all at once with `resume` entries. A cancelled question ends the paused run with outcome `cancelled`, as does a run a hook or middleware stopped (`stopped`, kept in the metadata).
  - `@cogitator-ai/server-shared/agui` holds it: `toAGUI()` and `AGUITranslator` turn our stream events into AG-UI events, `streamAGUIRun()` runs or resumes an agent for a request, `runAGUIConformance()` checks an adapter's route. The translation is tested with the AG-UI client's own event verifier, and `HttpAgent` against the routes. `@ag-ui/core` 1.0.3 is a new dependency of `@cogitator-ai/server-shared`.
  - Not yet: frontend tools, `MESSAGES_SNAPSHOT`, encrypted reasoning and the binary transport.

  Stream events:

  - `data`: a tool sends its client structured data with `context.data({ name, data, id?, transient? })`, which returns the part's id. A later part with the same id replaces it in place, a transient one is never kept with the message. The run reports them to `onData`, and a delegated run passes them to its stream.
  - `state-snapshot` and `state-delta`: `RunOptions.state` is the state a run starts from, a tool reads and replaces it with `context.state`, the run reports each change to `onState`, and the stream sends a snapshot first and JSON Patches (RFC 6902) after. `createJsonPatch` and `applyJsonPatch` come from `@cogitator-ai/server-shared/json-patch`, a subpath a browser bundle can import.
  - `reset-step`: with `onStepReset` on a run, a model that fails mid-answer now moves to the next of the agent's `fallbackModels` instead of failing the run, and a streamed answer that came out empty is asked again, both telling the callback to take back what the step streamed. `AgentStreamSession` sets it with `resetSteps: true` and sends `reset-step` with the step's parts and tool calls. It is off by default, since a client that does not know `reset-step` would show the failed step's text before the new one: the handlers of `@cogitator-ai/next` (for `useCogitatorChat`) and the app-server turn it on, the `/stream` routes of the HTTP adapters keep failing such a run as before.
  - `useCogitatorChat` keeps data parts in `message.data` (transient ones only reach `onData`), the state in `state` (and `onStateChange`), and takes a reset step out of the message.

  All of it is additive: a stream only carries the new events when a tool sends data or state, or a fallback model takes over mid-answer. A client that validates events with an older `StreamEventSchema` refuses the new types, so update it along with the server. The app-server's generated client knows the new events.

### Patch Changes

- Updated dependencies [[`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c), [`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c)]:
  - @cogitator-ai/server-shared@0.17.0
  - @cogitator-ai/types@0.89.0
  - @cogitator-ai/core@0.78.0

## 0.15.4

### Patch Changes

- Updated dependencies [[`ac89cec`](https://github.com/cogitator-ai/Cogitator-AI/commit/ac89cec9ea8d288afd58f7dbbe1531f8425d757a)]:
  - @cogitator-ai/core@0.77.0
  - @cogitator-ai/types@0.88.0
  - @cogitator-ai/server-shared@0.16.2

## 0.15.3

### Patch Changes

- Updated dependencies [[`e2f1c87`](https://github.com/cogitator-ai/Cogitator-AI/commit/e2f1c8793df4d1fdb06e9d8a5d0e8be984cbd2d2)]:
  - @cogitator-ai/types@0.87.0
  - @cogitator-ai/core@0.76.0
  - @cogitator-ai/server-shared@0.16.1

## 0.15.2

### Patch Changes

- Updated dependencies [[`2bb4941`](https://github.com/cogitator-ai/Cogitator-AI/commit/2bb4941dc40889458575db0893766c233dabaaaf)]:
  - @cogitator-ai/server-shared@0.16.0
  - @cogitator-ai/core@0.75.0
  - @cogitator-ai/types@0.86.0

## 0.15.1

### Patch Changes

- Updated dependencies [[`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a)]:
  - @cogitator-ai/types@0.85.0
  - @cogitator-ai/core@0.74.0
  - @cogitator-ai/server-shared@0.15.1

## 0.15.0

### Minor Changes

- [#310](https://github.com/cogitator-ai/Cogitator-AI/pull/310) [`74439c2`](https://github.com/cogitator-ai/Cogitator-AI/commit/74439c22cce3f000a35a104392b6d290dbb3327d) - Triggers, routines and the inbox, experimental: a saved task on an agent or a workflow starts itself on a cron schedule, an API call or a webhook of GitHub, email or Slack, and what it comes to lands in an inbox. Every scheduler of the runtime now runs on one core.

  Every new entry point carries the `experimental_` prefix and is listed in `docs/EXPERIMENTAL_API.md`. Without `experimental_triggers` a runtime has no trigger manager and behaves as before.

  One scheduler core (types, core, channels, workflows):

  - `experimental_createCronEngine` over `cron-parser` (5 or 6 fields, `@daily` and the other presets, IANA time zones, the skipped hour of daylight saving fired at the first minute after it, the repeated hour once) and `planOccurrences` for catch-up (`latest`, `none`, `all`, with a window). `cron-parser` is an optional peer of the core, loaded on first use, `experimental_loadCronEngine()`: a trigger manager or scheduler without cron expressions never loads it.
  - `experimental_TimerClaims` and `experimental_TimerPoller`: the one claim, renew and release logic over the `TimerStore` contract, and `experimental_Scheduler` on top of it (cron, one-shot and interval entries, retries, `update` or `append` rescheduling, pause, resume, run now).
  - `getNextCronMs` and `HeartbeatScheduler` of channels, and the cron helpers, `TimerManager`, `JobScheduler` and `CronTriggerExecutor` of workflows are clients of it, with their public API and the workflow presets kept. `InMemoryTimerStore` and `FileTimerStore` moved to the core (workflows exports the same classes), and `FileTimerStore` now sees what other processes wrote and locks its file while it writes.
  - `TimerEntry` gained `trigger`, `catchUp`, `catchUpWindowMs` and `lastOccurrence`.

  Triggers and routines (types, core, config):

  - `CogitatorConfig.experimental_triggers` and `cog.experimental_triggers` (`experimental_TriggerManager`): routines (`prompt`, a target agent or workflow, `session`, `overlap` `skip`, `queue`, `parallel` or `replace`, `maxConcurrent`, `catchUp`, `owner`, `notify`) and their triggers: `cron` (with `timezone`), `api` (a bearer token the manager issues and keeps as its SHA-256, `issueToken`, `rotateToken`, or one from the environment), `webhook` (HMAC over the raw body), `github` (`X-Hub-Signature-256`, events and field filters, `ping`), `email` (Mailgun signature, Postmark and SendGrid secret) and `slack` (signature, URL verification, bot messages ignored). `maxPerHour` per trigger.
  - The routine's prompt is the task, what the event carries follows it in a `<trigger-payload untrusted="true">` block the payload cannot close, and the event is kept with the input in the session log as `metadata.trigger` (`RunOptions.inputMetadata`).
  - A firing starts one run: deliveries are deduplicated by their id in the routine store with a TTL (a GitHub delivery by a digest of its signed body, since its headers are not signed), each Mailgun signature starts one run at most, the run id is made from the trigger and the occurrence (`trg_<routine>.<trigger>.<occurrence>`, unique per trigger) and claimed, and with `durable` a second start finds the run held. Two runtimes sharing their stores start each cron occurrence once. Durable runs of routines and agent tasks a stopped process left are continued on `start()`, and every half lease after it while their lease still runs, from the runs the store keeps going on rather than the history.
  - Routine stores (routines made at run time, trigger state changed in one atomic `patchTriggerState` step, history, runs going on, claims): `experimental_InMemoryRoutineStore`, `experimental_FileRoutineStore`, `experimental_RedisRoutineStore`, `experimental_PostgresRoutineStore` (which sweeps expired claims). Saved routines name their target and take secrets as `{ env }`, and so do routines a config file or an isolated plugin sends as JSON. `experimental_fileTriggerStores()` puts routines, schedules and the inbox in `.cogitator/triggers` for a runtime and the CLI to share.
  - The inbox: `experimental_Inbox` over `experimental_InMemoryInboxStore`, `experimental_FileInboxStore`, `experimental_RedisInboxStore` or `experimental_PostgresInboxStore`, items of kind `result`, `approval`, `question` and `failure`, sinks (`experimental_webhookSink`, signed), live changes with `subscribe()`. Runs waiting for a person are answered with `respond()`, the answer claimed once in the store (`InboxItem.answeredAt`, `claimAnswer`), so archiving an item does not answer it and two answers resume a run once. An answer resumes only the run its item waits on (another run of the thread that paused since is left alone), and an answer whose run could not be taken up (an answer its question's schema refuses among them) is given back. An item a run ends with has an id made from the run, and one the inbox store could not take waits in the run's record (`ActiveRoutineRun.pendingItems`) and is written again until it is in. The inbox pages by time and id (`InboxFilter.beforeId`), the Redis inbox reads a page of an index per user and status. The `Notification` hooks hear `routine_result` and `routine_failed`.
  - Agents schedule themselves: `triggers.schedulerTools(agent)` gives an agent `schedule_task`, `list_tasks` and `cancel_task` whose tasks the manager runs on it in the thread they were given in, the description read back as data. An occurrence is skipped while the last run of its task goes on, a one-shot task is held (not fired) while its run goes on, without holding up the poll, and a run that failed makes it due again after a backoff, up to the scheduler's retries, and a task that waits for approval or an answer comes to the inbox for `respond()`.
  - Plugins register routines and triggers with `registerRoutine` and `registerTrigger`, also from an isolated process, given the permission `Routine` in their manifest, without `userId`, `owner` or a thread of their own, on agents and workflows `experimental_triggers.pluginTargets` lists. A routine's run holds a lease on the plugins.
  - New error codes `TRIGGER_NOT_FOUND` (404) and `INBOX_ITEM_ANSWERED` (409). The config package reads `experimental_triggers` from files (`TriggersConfigSchema`), the routine schemas are in types (`RoutineSchema`, `TriggerSpecSchema`).

  Channels: `experimental_channelSink` tells a routine's owner in their chat, `experimental_emailTriggerParser` reads mail for email triggers as the email channel does. The heartbeat keeps its fixed delay on the scheduler core: the next time of a repeating task counts from the end of its run (`SchedulerOptions.nextFire` is called after the occurrences fired). The heartbeat's task text is wrapped as untrusted data the agent wrote earlier, and `verifyGitHubSignature`, `verifyMailgunSignature` and `secretsEqual` are the core's.

  Workflows: `experimental_routineWorkflow` runs a workflow as a routine's target from `{ input, trigger }` (the wrapped prompt and what the manager vouches for, not the raw event), its human approvals in the inbox (one item per request, the assignee's, closed by a timeout or an escalation, `experimental_approvalItemId`) and answered through the trigger manager, nodes that finally fail in the inbox (`experimental_inboxNotifier`, `experimental_inboxDeadLetterQueue`). `DefaultTriggerManager.start()` brings back the triggers of its store, and `register()` of a trigger it brought back (same workflow, type and config) takes that one over instead of adding a duplicate, so a program that registers its triggers on every boot keeps one of each (functions of the config, such as an event trigger's `filter`, count by identity, and only the config's own `enabled` is left out of the comparison), and does not start it again, so `runImmediately` fires once per start. `JobScheduler` refuses an invalid cron expression or time zone and reports runs it could not schedule (`onError`).

  Server adapters: with `triggers` (the runtime's trigger manager) express, fastify, hono, koa, tetsu and next serve `POST /triggers/:id/fire` and `POST /triggers/:id/webhook` (the raw body handed over untouched, before the adapter's auth, up to 10 MiB) and `GET /inbox` and `PATCH /inbox/:id` (the caller's own items, `401` for a caller without a user id unless the adapter is set to `anonymous: 'allow'` explicitly, pages by `before` and `beforeId`). Next gets `createTriggerHandler` and `createInboxHandler`. Shared handlers, OpenAPI paths and a conformance suite live in server-shared.

  Studio: Inbox (live, read, archive, approve, reject, answer questions and workflow requests in the form their type asks for, also through `POST /approvals/:id`) and Schedules (start, stop, run now, pause, resume, history). The Plugins page lists the routines a plugin registered.

  CLI: `cogitator schedule list | add | rm | run | pause | resume`, `cogitator inbox [--unread] | show | read | unread | archive` and `cogitator trigger fire | token`.

  Breaking changes and migration:

  - `schedule_task` (`createSchedulerTools`) checks a cron expression with the cron engine instead of a 5-field pattern: `@daily`, 6 fields and a new `timezone` parameter are taken, and the first run of a cron task is the expression's first occurrence instead of one minute after it was scheduled. A runtime that uses it without channels or workflows needs `cron-parser` installed (`npm install cron-parser`) or a `cron` engine passed in, a cron task fails with `CONFIGURATION_ERROR` otherwise. `list_tasks` and `cancel_task` leave the schedules of routines in the same store alone. The answer of `schedule_task` may also carry `timezone`.
  - `schedule_task` schedules a task for the user of the run that called it (else `defaultUserId`): a `userId` argument other than the run's fails the tool instead of scheduling for that user. At most `maxTasks` tasks wait at once, 20 unless set (`Infinity` for no limit), and a cron task runs at most once a minute (read from its computed occurrences, presets such as `@secondly` included).
  - The message `HeartbeatScheduler` sends for a task no longer starts with `[SCHEDULED TASK]`: the description comes in a `<trigger-payload source="agent" untrusted="true">` block, and `raw.trigger` carries the event. Code that read the old text reads `raw.taskId` or `raw.trigger.text`.
  - `RunNotification.type` has two more values, `routine_result` and `routine_failed`: an exhaustive `switch` over it needs the new cases.
  - `PluginContributions` has `routines` and `PluginContext` has `registerRoutine` and `registerTrigger`: a hand-written object of either type adds them.
  - `DefaultTriggerManager.start()` returns a promise that resolves once the triggers of its store are back. Code that calls it without `await` still works.
  - `JobScheduler.registerCronJob()` and `scheduleRun()` with an invalid cron expression or time zone throw `VALIDATION_ERROR`, and a cron job whose run could not be scheduled is reported to `onError` (else logged) instead of being dropped silently.
  - `CronTriggerExecutor` keeps the latest 100 missed occurrences when more were missed, instead of the oldest.
  - `FileTimerStore` writes `timers.json` with mode 0600 under a lock file next to it.

### Patch Changes

- Updated dependencies [[`74439c2`](https://github.com/cogitator-ai/Cogitator-AI/commit/74439c22cce3f000a35a104392b6d290dbb3327d)]:
  - @cogitator-ai/types@0.84.0
  - @cogitator-ai/core@0.73.0
  - @cogitator-ai/server-shared@0.15.0

## 0.14.2

### Patch Changes

- Updated dependencies [[`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445)]:
  - @cogitator-ai/types@0.83.0
  - @cogitator-ai/core@0.72.0
  - @cogitator-ai/server-shared@0.14.2

## 0.14.1

### Patch Changes

- Updated dependencies [[`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6)]:
  - @cogitator-ai/types@0.82.0
  - @cogitator-ai/core@0.71.0
  - @cogitator-ai/server-shared@0.14.1

## 0.14.0

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
  - @cogitator-ai/server-shared@0.14.0

## 0.13.6

### Patch Changes

- Updated dependencies [[`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4)]:
  - @cogitator-ai/types@0.80.0
  - @cogitator-ai/core@0.69.0
  - @cogitator-ai/server-shared@0.13.3

## 0.13.5

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/types@0.79.0
  - @cogitator-ai/core@0.68.1
  - @cogitator-ai/server-shared@0.13.2

## 0.13.4

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0
  - @cogitator-ai/core@0.68.0
  - @cogitator-ai/server-shared@0.13.1

## 0.13.3

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0
  - @cogitator-ai/core@0.67.0
  - @cogitator-ai/server-shared@0.13.0

## 0.13.2

### Patch Changes

- [#295](https://github.com/cogitator-ai/Cogitator-AI/pull/295) [`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b) - Decide tool calls by rules before anyone is asked, run agents in permission modes from plan to bypass, keep an audit log of every decision, and give sessions budgets that pause a run instead of failing it.

  Nothing in a run changes until you set `permissions` (on the runtime, an agent or a run) or `budget`: a call asks exactly when its tool needs approval, as before, no decision is logged, and an approval's `updatedArguments` is ignored with a warning. The few changes outside runs are listed under Breaking.

  Breaking:

  - `InterruptKind` is now `'approval' | 'input' | 'plan' | 'budget'`, and the `kind` of `PendingInterrupt` on the wire (`interrupt-required`, the JSON answer of a paused run) can be `plan` or `budget`. A client or a `switch` over the kind that knew only `approval` and `input` handles the new kinds or ignores them: they come only from runs that use plan mode or budgets.
  - The `allowed-tools` of a `SKILL.md` is split at commas too, and never inside parentheses, so `Bash(git status *), Read` reads as two rules. Before, `Read, Grep` read as `Read,` and `Grep`.
  - `read_file`, `list_files`, `glob` and `grep` of `workspaceTools()` now declare `annotations: { readOnlyHint: true }`, which an MCP server exporting them advertises.
  - `serveAgents()` and `agentTools()` of `@cogitator-ai/mcp` register `<agent>_resume` for every agent, not only for agents with a tool that needs approval: rules of the runtime can make any call ask. A client listing the tools sees one more per agent.
  - `RunHandle.permissionMode` and `setPermissionMode()` are optional in the interface, so code that builds its own `RunHandle` keeps compiling. `cogitator.start()` returns a handle that has both.

  New:

  - Permission rules in the grammar of Claude Code's `permissions` settings, `allow`, `ask` and `deny` lists of `Tool` or `Tool(specifier)`: `Bash(git push *)` (and `Bash(git push:*)`), `Edit(src/**)`, `Read(//etc/**)`, `Read(~/.ssh/**)`, `mcp__github__*`, `WebFetch(domain:example.com)`, `Agent(Explore)`, `send_email(to:*@example.com)` in deny and ask rules, globs of tool names in deny and ask rules. Claude Code's names map onto Cogitator's tools by what they touch, a tool's own name works as it is, and the names without a counterpart (`MultiEdit`, `NotebookRead`...) match nothing with a warning. The docs list the differences from Claude Code.
  - Command lines are tokenized as a POSIX shell reads them (quotes, escapes, line continuations, redirections glued to words) and rules match each command's argument vector. An allow needs every command of the line fully understood (no substitutions, expansions, here-documents, subshells, control flow, programs that run other code, `git` global options or `find -exec`), covered by an allow rule, without unsafe variables (`exec`'s `env` too), with its working directory and the files it writes inside the workspace. A deny or ask rule matches every command the line may run, wrappers (`sudo`, `env`, `nice`, `timeout`, `xargs`, `exec`...) taken off, programs by base name, `sh -c` and `eval` read again and `git` without its global options. Globs and brace expansion, interpreters given code (`python3 -c`, `node -e`, `awk`...), `busybox`, `xargs` and anything left open are not understood, ANSI-C strings are decoded and program names compared without case on macOS and Windows. A line the parser does not fully understand asks when a `Bash` deny or ask rule or a `Read`/`Edit` deny rule could apply, also under a bare `Bash` allow, and is refused in the modes that never ask (`bypassPermissions`, `dontAsk`). Shell rules are best effort, the docs say what they cover and recommend a sandbox for a guarantee. `Read` rules count every word of a command as a file it may read (`paste x`, `dd if=x`, `git show HEAD:x`) and refuse recursive readers (`grep -r`, `rg`, `tar`) over a directory a denied path may lie in, `Edit` rules check the files commands write (`tee`, `cp`, `sed -i`, redirections), and `grep`, `glob` and `list_files` leave out the files a `Read` deny covers (`ToolPermissionsView.canRead()`). Path rules use gitignore patterns, compare the path with `..` resolved and with symlinks followed (an allow needs both to match, a deny either), refuse backslashes used as separators and compare Windows paths as `/c/...`. A deny of any layer wins, then ask, then allow, and a bare deny also takes the tool out of the model's tool list.
  - `ToolConfig.access: { kind: 'read' | 'edit' | 'command' | 'fetch' | 'search' | 'agent', paths?, subtree?, command?, cwd?, env?, url?, agent? }` says what a call touches, so `Read(...)`, `Edit(...)` and `Bash(...)` rules and the modes cover tools of your own. The workspace tools (their paths resolved against the workspace they are bound to), `exec`, the `file_*` tools and `agentAsTool()` declare it, `restrictFileTools()` and `withParsedArguments()` keep it. `ToolConfig.mcp: { server, tool }` names the MCP tool behind a tool, which `@cogitator-ai/mcp` sets, so `mcp__<server>__<tool>` rules match whatever `namePrefix` the tool got.
  - Layers, highest first: `managed` (`managed-settings.json` and `managed-settings.d/*.json` in Cogitator's and Claude Code's system directories), `session` (rules in code, "always allow" answers for the session, the `allowed-tools` of active skills), `local` (`.claude/settings.local.json`, `.cogitator/settings.local.json`), `project` (`.claude/settings.json`, `.cogitator/settings.json`) and `user` (`~/.cogitator/settings.json`, `~/.claude/settings.json`). `permissions.settings: true` (or `{ root, userDirs, managedDirs, layers, trusted }`) reads the files, again once one changes, skipping broken files and entries with a warning. As in Claude Code a project or local file cannot set `defaultMode` to `auto` or `bypassPermissions`, `disableBypassPermissionsMode` and `disableAutoMode` work from any file, `allowManagedPermissionRulesOnly` in a managed file makes its rules the only ones, and `trusted: false` ignores what an untrusted project grants (the allow rules, extra directories and mode of its project and local files). The `allowed-tools` of skills found in the workspace count only with `trusted: true`.
  - Modes: `default` (an edit asks unless an allow rule covers it), `acceptEdits` (edits inside the workspace and `mkdir`, `touch`, `mv`, `cp` on workspace paths, their options read exactly, run without asking), `dontAsk` (what would ask is refused), `plan` (only the runtime's read-only tools and read-only commands with options known to only read run, never what an MCP server claims, switching a run into it offers `exit_plan_mode`, the model presents its plan with the `exit_plan_mode` tool, the run pauses with an interrupt of kind `plan` holding the plan in `details.plan`, and an answer `{ approved: true, mode? }` (`default`, `acceptEdits` or `dontAsk`, the modes that ask less are the host's to set) carries it out, `{ approved: false, feedback? }` keeps planning), `auto` (a classifier decides each call that would ask, `permissions.classifier: { model, instructions?, timeout?, transcriptMessages? }` or your own `{ classify }`, with its reason in the log, an ask rule still asks and a failing classifier falls back to asking, the classifier reads the arguments escaped and never the tool results, and arguments too long to read whole ask) and `bypassPermissions` (every call runs but what a deny rule refuses, only for isolated environments). The mode comes from the run, the paused run, the agent, the runtime or the settings, and `RunHandle.setPermissionMode()` switches it while the run goes on (`RunHandle.permissionMode` reads it).
  - `resolvePermission(tool, args, context)` is the one decision behind the run loop, `invokeTool()` and `agentAsTool()`, whose inner run gets the caller's mode and session rules (`ToolContext.permissions`). A handoff the rules refuse does not hand over, after one that runs the rules of the agent the run went on as apply, and `invokeTool(tool, args, { agent })` applies the agent's. A refused call answers the model with `Permission denied: <reason>` and `errorCode: 'PERMISSION_DENIED'`. A request that asks carries `reason`, `rule`, `suggestedRule` and `mode`. Every decision, the automatic ones too, is saved to the thread as an `approval` entry (`{ toolCallId, toolName, decision, reason, decidedBy, mode, rule?, updatedArguments?, remembered? }`) and reported to `RunOptions.onPermissionDecision`, and `invokeTool()` returns it in `result.permission`.
  - With permissions set up, an approval may answer `{ approved: true, updatedArguments }`: the call runs with them once they pass the tool's schema and the rules again, and a `defaultDecision` never changes the arguments of the calls it answers. `{ approved: true, remember: true | { rule?, layer? } }` saves an allow rule ("always allow") to `permissions.rememberIn` (default `local`, the session without settings files): only the suggested rule or the exact call, and only to a layer of `permissions.rememberLayers` (default `session` and `local`). File layers are written to `.cogitator/settings.local.json`, `.cogitator/settings.json` or `~/.cogitator/settings.json`. A paused run keeps its mode, its own rules and the rules allowed for the session in `checkpoint.permissions`, and the calls the rules refused in `checkpoint.turn.denied`: resume it with the same or a newer version. A resume decides the calls the rules, the mode or the classifier allowed again under its own mode and rules (`checkpoint.turn.automatic`), and holds the calls a person approved to its deny rules and mode. A `cd`, `pushd`, `popd` or `builtin cd` followed by more commands makes the rest of the line not understood (a directory change is never followed), rules match the arguments as the tool's schema reads them, and plan mode takes `git` commands as read-only only in a trusted workspace (`permissions.settings.trusted: true`), `git diff`, `git show` and `git log -p` only with `--no-ext-diff --no-textconv`, and of `git branch`, `tag`, `remote`, `stash` and `worktree` only the listing forms. Arguments a `wrapToolCall` middleware changes a call to are decided again after it (a deny wins, an ask asks again, `checkpoint.turn.changed`), a handoff into a workspace whose settings disable the current mode falls back to `default`, and the run limits of a parent count what its delegates spent. Path rules compare names in NFC and without case where the file system ignores it (probed once per workspace root, `ignoreCase` and `pathsIgnoreCase()` to decide it yourself), every call of a turn is decided again right before it runs, so a mode switched mid-turn stops the later calls, a budget the host passes to `resume()` also wins over a lifted limit, and a tool call counts against `maxToolCalls` only once its tool starts. A command that touches a whole directory (`rm -r`, `rmdir`, `chmod -R`, `chown -R`, `chgrp -R`, `cp -r`, `mv`, `find`, `grep -r`, `rg`, `ag`, `du`, `ls -R`, `tar`, `zip -r`, `unzip`, `rsync`, `scp`) has everything inside it as its target, a recursive reader without a path reads the working directory, the options of these commands are read exactly so a value is never taken for a directory, and an unknown option makes the command not understood. `ToolAccess.subtree` lets a tool say the same (`file_delete` and `file_list` with `recursive: true`). A resume budget changes only the limits it names, and the model calls of the `auto` classifier count in the run's usage, cost, budgets and cost routing. Plan mode reads commands from a strict list with their options and operands (`printf -v` and a `date` that sets the clock are not read-only), and a builtin that changes the shell state (`export`, `set`, `alias`, `read`, `printf -v`, a bare assignment...) in a line of several commands makes the line not understood in every mode. A call is decided again once it holds its locks, right before its tool starts, the tool call allowance (the run's and its callers') is checked again then, what the memory upkeep after a run spends counts in its budgets and the session's spending, and a forced `toolChoice` naming a tool a bare deny hides is not forced. `grep`, `glob` and `list_files` withhold files a `Read` ask rule covers too and say how many (`withheld`), a shell read over a directory with such a file inside asks, agent budgets go by the agent's `id`, else its name, so a new instance of the agent keeps its spending, records keyed by agent names and other user strings have no prototype, and a person's approval holds through the final check right before a call runs in `dontAsk` mode. `invokeTool()` decides a call again right before its tool starts, `agentAsTool()` passes the caller's rules with the root and working directory their path patterns start from (`ToolPermissionsView.inherited`, `RunOptions.permissions.inherited`), and runs of one thread at the same time in one process share one live count of the session's spending. Arguments an approval of changed arguments gives go through the guardrails' tool call filter again, agent snapshots keep inherited rules, the `auto` classifier is not asked twice for one call, and rules a person allowed for a session apply to its next runs without permissions of their own. `~` and `~/` read as the home directory in commands and command patterns (`~user` is not understood), wrappers and `env` are unwrapped to a fixed point so their order never hides an assignment, MCP tools always carry their origin (`server: ''` for a nameless server) so their annotations are never trusted, the budget is checked before each call of the `auto` classifier, and `invokeTool()` reports the final decision in `result.permission`. A budget the host passes to `resume()` wins over a raised limit, and settings drop-in directories are watched for new files. `cp`/`mv` destinations are checked per source, inline variable assignments must be safe in every mode, too many paths on a line ask, `restrictFileTools()` checks paths where the wrapper reads them, budgets on agents anywhere down a handoff chain keep the session's spending, and a spending record memory refused is not lost to a staler one.
  - Session budgets: `budget: { session: { maxCostUsd, maxTokens, maxToolCalls }, agent, warnAt, onWarning }` on the runtime or a run, and `AgentConfig.budget`. A run that reaches a limit pauses with an interrupt of kind `budget` (`details: { scope, metric, used, limit }`) before its next model call or tool turn, and `{ action: 'stop' }` ends the run with `result.budgetStop`. Raising a limit is the host's decision: resume with a higher `budget`, or set `budget.allowRaise: true` to let an answer `{ action: 'continue', limit }` raise it (for the session when it is a session or agent limit) or `{ action: 'continue' }` go past it for the run. A session is a thread. A paused run keeps its own budgets in `checkpoint.budget.limits`, an agent's own `budget` keeps the session's spending too, and what an agent run through `agentAsTool()` spends (money, tokens and tool calls, its calls refused once the caller's tool call budget is spent) is charged to the caller's session. Runs of one thread that end at the same time add up their spending instead of overwriting it. With `limits.onExceeded: 'interrupt'` the cost routing check before a run pauses it too. The spending is kept in the thread's metadata (`budget`, without memory in the process) and returned as `result.sessionSpend`. `RunOptions.onBudgetWarning` hears warnings past `warnAt` (default 0.8).
  - `limits.onExceeded: 'interrupt'` makes `limits.maxTokensPerRun` and the cost routing budgets pause the run the same way, scopes `run`, `hour` and `day`, instead of failing it with `RUN_TOKEN_LIMIT_EXCEEDED` or `BUDGET_EXCEEDED`, which stays the default.
  - `InterruptRequest` takes `kind: 'plan'` and `details`, and `RunInterrupt.details` carries them. `AgentConfig.permissions` and `budget` travel in `serialize()`, not in the agent wire format: the receiving side decides what its tools may do.
  - `@cogitator-ai/core` exports `resolvePermission`, `PermissionRuleSet`, `suggestRule`, `ruleAllowsCall`, `parseRule`, `parseCommandLine`, `matchesCommandPattern`, `compilePathPattern`, `pathsIgnoreCase`, `readAllowed`, `rememberableRules`, `loadPermissionSettings`, `addAllowRule`, `rememberFile`, `modelClassifier`, `parseClassification`, `EXIT_PLAN_MODE`, `BUDGET_RESPONSE_SCHEMA`, `BUDGET_STOP_SCHEMA` and `SESSION_BUDGET_KEY`. `@cogitator-ai/types` adds `PermissionMode`, `PermissionsConfig`, `PermissionOptions`, `PermissionDecision`, `PermissionDecisionEvent`, `PermissionRuleRef`, `PermissionLayerSettings`, `InheritedPermissionRules`, `PermissionClassifier`, `ToolAccess`, `ToolMcpOrigin`, `ToolPermissionsView`, `ToolApprovalRemember`, `SessionBudgetConfig`, `BudgetLimits`, `BudgetUsage`, `BudgetWarning`, `SessionSpend`, `BudgetResponse` and `PlanResponse`.
  - Server adapters: `approval-required` approvals and paused answers carry `reason`, `rule` (the rule text, never the file it came from), `suggestedRule` and `mode`, interrupts carry `details`, and resume decisions take `updatedArguments` and `remember` (the Fastify and Tetsu schemas no longer drop them). The OpenAPI document and the conformance suite describe them. `useCogitatorChat` of `@cogitator-ai/next` gets `approveAlways()`, and `resume()` of both hooks sends `remember` and `updatedArguments`.
  - `@cogitator-ai/config` reads `permissions`, `budget` and `limits.onExceeded` from config files.
  - Channels: the approval prompt says why a call asks, an "always" reply (`approvals.alwaysWords`, default `always` and `всегда`) or the new "Always allow" button (`cogitator:always`) approves with `remember: true` when the request suggests a rule, and a plan question shows the plan.
  - Cogitator Studio shows why an approval asks and its rule, and offers "Always allow" with the rule it saves. `@cogitator-ai/a2a` carries `updatedArguments` and `remember` in approval answers, the reason in the status text and the plan of a plan question, and `@cogitator-ai/mcp` adds the reason to the elicitation and sets `tool.mcp` on imported tools (the new `server` option, else the name the server reports). `allowRemember: true` in its server options offers an `always` choice and `remember` on `<agent>_resume`, off by default so the client model cannot grant itself standing permissions.

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/types@0.76.0
  - @cogitator-ai/core@0.66.0
  - @cogitator-ai/server-shared@0.12.0

## 0.13.1

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0
  - @cogitator-ai/core@0.65.0
  - @cogitator-ai/server-shared@0.11.0

## 0.13.0

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
  - @cogitator-ai/server-shared@0.10.0

## 0.12.11

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/core@0.63.1
  - @cogitator-ai/server-shared@0.9.10

## 0.12.10

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/core@0.63.0
  - @cogitator-ai/server-shared@0.9.9

## 0.12.9

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/server-shared@0.9.8

## 0.12.8

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/server-shared@0.9.7

## 0.12.7

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - @cogitator-ai/server-shared@0.9.6

## 0.12.6

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/server-shared@0.9.5

## 0.12.5

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/server-shared@0.9.4

## 0.12.4

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/server-shared@0.9.3

## 0.12.3

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/server-shared@0.9.2

## 0.12.2

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/server-shared@0.9.1

## 0.12.1

No changes in this release.

## 0.12.0

### Minor Changes

- [#259](https://github.com/cogitator-ai/Cogitator-AI/pull/259) [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357) - Workflow checkpoints and resume over HTTP in every REST adapter

  With the new `workflowCheckpoints` option (a `CheckpointStore`), a workflow run accepts `options.checkpoint: true` and saves checkpoints there. A finished run answers with its `checkpointId`, and a failed one carries it in the error answer, next to `code` and `message`, and in a `workflow_failed` event before the stream's `error` event. `POST /workflows/:name/resume` and `/workflows/:name/resume/stream` take `{ checkpointId, options? }` and run the remaining nodes, with the server's limits, the caller's auth and the same answers as `/run` and `/stream`. A resumed run saves checkpoints too, so it can be resumed again.

  A checkpoint belongs to the user who ran the workflow: `WorkflowCheckpoint` gets an `owner`, set through `ownedCheckpoints(store, owner)` from server-shared. Another user's checkpoint, one of another workflow, an unknown id and a server without a store all answer `404 CHECKPOINT_NOT_FOUND`, a new error code, before anything runs. Without `workflowCheckpoints`, `options.checkpoint: true` is still refused. OpenAPI documents the resume routes, `WorkflowResumeRequest` and `checkpointId`, and the conformance cases cover the refusals.

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/server-shared@0.9.0

## 0.11.1

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/server-shared@0.8.1

## 0.11.0

### Minor Changes

- [#253](https://github.com/cogitator-ai/Cogitator-AI/pull/253) [`8b0fd20`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b0fd2045686cba1675b97163ee7fbea88a723f3) - Stream protocol events as Zod schemas and OpenAPI components, and `/agents/:name/resume/stream` in every REST adapter

  `@cogitator-ai/server-shared` exports a Zod schema for every stream event (`StreamEventSchema`, a discriminated union on `type`, and `StartEventSchema` through `SwarmEventSchema`, `RunUsageSchema`, `PendingApprovalSchema`), so a client can check what a server sends. The schemas have the shapes of the `StreamEvent` types, an unknown event type fails to parse and a field a newer server adds is dropped. `streamEventComponents()` turns them into OpenAPI 3.0 components, and `generateOpenAPISpec` now documents every SSE route as `text/event-stream` with the `StreamEvent` schema, a `oneOf` with a discriminator on `type`. The `RunUsage`, `PendingApproval`, `StreamStartEvent` and `StreamFinishEvent` components keep their names. `documentStreamEvents(document)` adds the same to a document another generator built: Fastify's Swagger document uses it, and a Tetsu document built with `openapi()` can go through it too. `truncated` and `iterationLimitReached` of `AgentRunResponse` and `StreamFinishEvent` are now documented as `true` when present, which is all a server ever sends. `ToolResultEvent.result`, `WorkflowEvent.data` and `SwarmEvent.data` are optional, as on the wire, where a tool that returned nothing sends no `result`.

  Express, Fastify, Hono and Koa serve `POST /agents/:name/resume/stream`, which Tetsu already had: it takes the body of `/resume`, refuses the same requests before the stream opens, and streams the rest of the run like `/stream`. A thread with no paused run ends the stream with an `error` event, `RUN_NOT_PAUSED`.

  The conformance cases now cover `/resume/stream`, and check every event of a stream against `StreamEventSchema`, so an adapter of your own that runs them needs the route.

### Patch Changes

- Updated dependencies [[`8b0fd20`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b0fd2045686cba1675b97163ee7fbea88a723f3)]:
  - @cogitator-ai/server-shared@0.8.0

## 0.10.0

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

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/server-shared@0.7.0
  - @cogitator-ai/core@0.56.4

## 0.9.6

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/server-shared@0.6.6

## 0.9.5

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/server-shared@0.6.5

## 0.9.4

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/server-shared@0.6.4

## 0.9.3

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/server-shared@0.6.3

## 0.9.2

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/server-shared@0.6.2

## 0.9.1

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/server-shared@0.6.1

## 0.9.0

### Minor Changes

- [#227](https://github.com/cogitator-ai/Cogitator-AI/pull/227) [`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Readiness checks and memory adapter health check contract ([#103](https://github.com/cogitator-ai/Cogitator-AI/issues/103)).

  - Add optional `healthCheck(): Promise<MemoryResult<void>>` to `MemoryAdapter` in `@cogitator-ai/types` and implement it for all five built-in memory adapters (in-memory, redis, postgres, sqlite, mongodb) using lightweight, non-mutating checks.
  - Add shared readiness check logic in `@cogitator-ai/server-shared` with a 3-second timeout per check. Adapters without `healthCheck()` report `unchecked` and fail open, and unconfigured memory does not fail readiness.
  - Update Express, Fastify, Hono, and Koa server adapters to check readiness against memory, returning HTTP 200 when ready and HTTP 503 on failure without exposing internal driver or network details.
  - Add `health-check` scenario to memory adapter conformance suite in `@cogitator-ai/test-utils`.
  - Update OpenAPI specification for `/ready` endpoint with `ReadinessResponse` schema.

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/server-shared@0.6.0

## 0.8.19

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/server-shared@0.5.19

## 0.8.18

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/server-shared@0.5.18

## 0.8.17

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/server-shared@0.5.17

## 0.8.16

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/server-shared@0.5.16

## 0.8.15

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/server-shared@0.5.15

## 0.8.14

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/core@0.47.0
  - @cogitator-ai/server-shared@0.5.14

## 0.8.13

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/server-shared@0.5.13

## 0.8.12

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/server-shared@0.5.12

## 0.8.11

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/server-shared@0.5.11

## 0.8.10

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/server-shared@0.5.10

## 0.8.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/server-shared@0.5.9

## 0.8.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/server-shared@0.5.8

## 0.8.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/server-shared@0.5.7

## 0.8.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/server-shared@0.5.6
  - @cogitator-ai/types@0.41.1

## 0.8.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/server-shared@0.5.5

## 0.8.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/server-shared@0.5.4

## 0.8.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/server-shared@0.5.3

## 0.8.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/server-shared@0.5.2

## 0.8.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/server-shared@0.5.1

## 0.8.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The adapters speak one protocol from `@cogitator-ai/server-shared`. Clients can no longer write system content: a run's `context` goes into the system prompt, so a request that sets any key is refused with `400` unless the new `acceptContext` option lists it (or is `true`), and `POST /threads/:id/messages` takes only `user` and `assistant` unless `threadMessageRoles` adds `system`. A body that is not JSON (`text/plain`, a form) is refused with `415` before it is parsed, so a web page on another origin cannot start a run without a preflight. Every adapter reads bodies with the shared validators, Fastify before its schema coerces types, and Next no longer accepts an empty `threadId`. The JSON answer of a run and the WebSocket `complete` event are the same object everywhere, with `structured`, `structuredError`, `truncated`, `blocked`, `iterationLimitReached` and `traceId`, and never the system prompt, the history or trace spans (Next drops `trace` from `AgentResponse`, read the full `RunResult` in `afterRun`). The `start` and `finish` events of an agent stream name the run's thread, so a client that sent none can continue the conversation. Swarm routes close the swarm they build once the run ends, so distributed swarms no longer leak Redis connections and keys without expiry, and `GET /swarms` lists a router and pipeline stages. `options.checkpoint: true` on workflow runs is refused instead of silently doing nothing. Next streams gain heartbeats (`sseHeartbeatMs` on `createChatHandler` and `createResumeHandler`) and use the shared protocol instead of a copy.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/server-shared@0.5.0

## 0.7.11

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0

## 0.7.10

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0

## 0.7.9

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2

## 0.7.8

No changes in this release.

## 0.7.7

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4

## 0.7.6

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3

## 0.7.5

### Patch Changes

- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/types@0.33.1

## 0.7.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1

## 0.7.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0

## 0.7.2

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0

## 0.7.1

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/server-shared@0.4.1
  - @cogitator-ai/types@0.31.0

## 0.7.0

### Minor Changes

- [`1c16684`](https://github.com/cogitator-ai/Cogitator-AI/commit/1c16684976705ab5c34778728f27f7efd247242f) - `CogitatorServer.init()` no longer prints `[CogitatorServer] Initialized at ...` to the console, and the WebSocket setup no longer prints where it listens. Both now report through the core logger at `debug` level, so they stay silent unless `LOG_LEVEL=debug` or your own logger set with `setLogger()` asks for them. Errors are still logged.

  Run bodies are now validated by the validator shared with every adapter from `@cogitator-ai/server-shared`. Blank inputs are still refused with `400 INVALID_INPUT`, the messages now name the field the same way as Hono and Koa (`Field "input" must not be blank`), and an empty `threadId` is refused too.

  SSE streams now write a `: keep-alive` comment every 5 seconds while a run is silent, so proxies and load balancers do not close a stream that waits on a slow tool or model. Set it with the new `config.sseHeartbeatMs` option (also on `ExpressStreamWriter`), `0` turns it off.

  The `usage` of a run answer now includes `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, like Tetsu and Next.

### Patch Changes

- [`9d40b76`](https://github.com/cogitator-ai/Cogitator-AI/commit/9d40b763f9fb25f9cb7cb2aba8a52ff2989fc5e9) - The `finish` event of an agent stream now carries the same `usage` as `POST /agents/:name/run`: `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` are included when the model reported them. Before, the stream sent only the input, output and total tokens, so a streaming client lost the reasoning and cache counts.
- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2), [`9d40b76`](https://github.com/cogitator-ai/Cogitator-AI/commit/9d40b763f9fb25f9cb7cb2aba8a52ff2989fc5e9), [`1c16684`](https://github.com/cogitator-ai/Cogitator-AI/commit/1c16684976705ab5c34778728f27f7efd247242f)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/server-shared@0.4.0

## 0.6.4

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2

## 0.6.3

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1

## 0.6.2

### Patch Changes

- 87951bf: A failing memory adapter no longer reaches the client through the Express and Fastify thread routes: the error is logged and answered as `500 Internal server error`, as Hono and Koa already did. Every unexpected error, whether caught by a route, a stream or the error handler, now carries the same code, `INTERNAL_ERROR` (routes and streams used `INTERNAL` before).
- 65d0cc0: Swagger UI calls the right URLs and offers a bearer token when the server checks credentials. The spec's `servers` now defaults to where the routes are mounted (Express `basePath`, the Hono/Koa mount prefix), and with `auth` configured the spec declares `bearerAuth` as an optional requirement (`swagger.auth` overrides it). The Swagger page escapes the title and the embedded spec, so agent names and descriptions can't inject markup.
- b6b1480: WebSocket `subscribe` channels no longer leak runs across users. A subscriber to `agent:<name>` now receives only the events of runs started by the same `userId` (as returned by `auth`) on other connections; before, any authenticated client could watch every user's prompts, tool calls and results. Servers without `auth` behave as before.
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
- Updated dependencies [65d0cc0]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/server-shared@0.3.1

## 0.6.1

### Patch Changes

- e211b6a: `cog.getMemory()` connects the configured memory adapter on first use, so threads can be read before any agent has run; `cog.memory` stays `undefined` until then. The `/threads` routes of every server adapter use it, so they no longer answer `503 Memory not configured` on a fresh server.
- 3e756f3: Errors that are not a `CogitatorError` no longer reach the client with their text, which can carry internals such as connection strings or file paths. They are logged on the server and answered as `Internal server error` everywhere: the Next.js agent, chat and resume handlers (now with `code: 'INTERNAL_ERROR'`), WebSocket run errors in Express and Fastify, `Workflow failed: …` responses, and the `node_error` / `agent_error` stream events of workflows and swarms in every adapter. A `CogitatorError` keeps its message and code.
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

## 0.6.0

### Minor Changes

- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

- 7bee3ef: Runs pause for a person to approve sensitive tool calls and continue later.

  - A tool with `requiresApproval` never runs without a decision. `RunOptions.onApproval` (or `guardrails.onToolApproval`) decides inline; otherwise the run pauses before executing the turn and returns `status: 'paused'`, `pendingApprovals` and a JSON `checkpoint`. `cogitator.resume(agent, threadId | checkpoint, { decisions, defaultDecision, userId })` executes the approved calls, answers declined ones with the reason, and goes on. A new message on the thread instead declines the waiting calls.
  - Paused runs are kept per thread in the memory adapter's thread metadata (`ThreadRunCheckpointStore`), in process memory without memory (`InMemoryRunCheckpointStore`), or in `runCheckpoints`. Resuming by thread checks the caller (`THREAD_ACCESS_DENIED`); a thread with nothing paused answers the new `RUN_NOT_PAUSED` (409).
  - `agentAsTool` passes the caller's `userId` to the delegated run and declines its approvals unless given `onApproval`, instead of reporting a paused sub-run as success.
  - Server adapters answer paused runs with `status` / `pendingApprovals` (never the checkpoint), stream `approval-required`, and take `POST /agents/:name/resume` (plus a WebSocket `resume` message); Next.js has `createResumeHandler` and `pendingApprovals` / `approve()` / `deny()` in its hooks; channels ask in the chat and resume on "approve" / "deny <reason>" (also "да" / "нет").

  **Behaviour change:** `requiresApproval` used to be enforced only with constitutional guardrails and an `onToolApproval` callback; without them such tools ran unasked. They now pause the run. WebSocket `complete` events no longer include a paused run's checkpoint.

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
  - @cogitator-ai/server-shared@0.3.0

## 0.5.0

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
  - @cogitator-ai/server-shared@0.2.1

## 0.4.2

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

## 0.4.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1

## 0.4.0

### Minor Changes

- `CogitatorRequest` takes a route params type (defaults to the previous one) so routes compile against @types/express 5; tested on express 5.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/server-shared@0.2.0
  - @cogitator-ai/types@0.24.0

## 0.3.1

## 0.3.0

### Minor Changes

- Every SSE stream (agents, workflows, swarms) was cut off right after it started. The routes closed the writer on req.on('close'), which since Node 16 fires about 2ms after the body is parsed, not on disconnect (confirmed with a probe). They now use res.on('close') guarded by writableEnded, and a disconnect aborts the run, workflow or swarm. Other fixes: finish() wrote after end(). Tool-call ids did not match tool-result ids, and tool arguments were never sent. Text is now split into blocks around tool calls. Workflow failures (returned as result.error) were reported as 200 or workflow_completed. CogitatorError codes always became 500. Malformed JSON and oversized bodies returned 500. Validation: input type, context, threadId, timeout, whitelisted workflow options, thread roles. Thread metadata was dropped. The agent list leaked system prompts. CORS origin '\*' granted credentials to every origin by default. The rate limiter could be bypassed by spoofing X-Forwarded-For or sending requests with no address. On WebSocket: auth was bypassed, 'stop' was a no-op, subscriptions were dead code (now an agent:<name> channel hub), and messages were not validated. enableWebSocket was half-wired; added CogitatorServer.attachWebSocket(). README and docs had a non-existent Cogitator config, an undefined routeContext and a fake requestTimeout option; fixed. The example ran new Function on model output; it now uses the shared examples/\_shared/arithmetic.ts.

  **Breaking changes**
  - CORS: credentials now default to false when origin is '_' (plain 'Access-Control-Allow-Origin: _'); pass credentials: true explicitly to keep reflecting the origin. Disallowed origins no longer get Allow-Credentials or preflight grants
  - GET /agents returns agent.config.description instead of the first 100 characters of the instructions
  - Workflow runs that fail now return 500 WORKFLOW_FAILED (and the stream sends an error event) instead of 200 or workflow_completed
  - WebSocket upgrades now go through the configured auth function (401 when it throws)
  - Stricter validation: input must be a non-empty string, context an object, threadId a string, swarm timeout positive; workflow options are type-checked and limited to maxConcurrency, maxIterations and checkpoint; thread messages need a user/assistant/system role and a non-empty string content
  - Rate limiter: with trustProxy it keys by the nearest X-Forwarded-For hop; requests without an address share one bucket; an invalid windowMs or max throws at construction
  - CogitatorError codes now map to their own HTTP status in routes (e.g. LLM_RATE_LIMITED gives 429 instead of 500)

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.2.15

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
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/types@0.22.3

## 0.2.14

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.2.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.2.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.2.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.2.8

## 0.2.7

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.2.6

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.2.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.2.4

### Patch Changes

- fix(express): audit — 8 bugs fixed, +43 tests, v0.2.4
  - Fixed redundant CORS condition check (cors.ts)
  - Fixed X-Forwarded-For spoofing: added `trustProxy` option to RateLimitConfig (default false)
  - Fixed 'unknown' shared rate-limit bucket for IP-less requests
  - Fixed thread timestamps using actual MemoryEntry.createdAt instead of Date.now()
  - Fixed AbortController overwrite without aborting previous in ws-handler
  - Fixed WebSocket OPEN magic number with named constant
  - Fixed notFoundHandler using AGENT_NOT_FOUND code for generic 404 → 'NOT_FOUND'
  - Added missing ExpressMiddleware type export
  - Added 43 unit tests (middleware, streaming, routes)
  - Added vitest + supertest to devDependencies
  - Updated docs with trustProxy option

## 0.2.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.2.0

### Minor Changes

- feat(express): add Express.js REST API integration package

  New package for mounting Cogitator as a REST API in any Express app:
  - CogitatorServer class for easy Express integration
  - Auto-generated endpoints for agents, threads, tools
  - SSE streaming via ExpressStreamWriter
  - WebSocket support for real-time communication
  - Swagger/OpenAPI auto-documentation
  - Middleware stack: auth, rate-limit, CORS, error handling
  - Optional workflow and swarm endpoints
