---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/channels': minor
'@cogitator-ai/workflows': minor
'@cogitator-ai/server-shared': minor
'@cogitator-ai/express': minor
'@cogitator-ai/fastify': minor
'@cogitator-ai/hono': minor
'@cogitator-ai/koa': minor
'@cogitator-ai/tetsu': minor
'@cogitator-ai/next': minor
'@cogitator-ai/studio': minor
'@cogitator-ai/cli': minor
'@cogitator-ai/config': minor
---

Triggers, routines and the inbox, experimental: a saved task on an agent or a workflow starts itself on a cron schedule, an API call or a webhook of GitHub, email or Slack, and what it comes to lands in an inbox. Every scheduler of the runtime now runs on one core.

Every new entry point carries the `experimental_` prefix and is listed in `docs/EXPERIMENTAL_API.md`. Without `experimental_triggers` a runtime has no trigger manager and behaves as before.

One scheduler core (types, core, channels, workflows):

- `experimental_createCronEngine` over `cron-parser` (5 or 6 fields, `@daily` and the other presets, IANA time zones, the skipped hour of daylight saving fired at the first minute after it, the repeated hour once) and `planOccurrences` for catch-up (`latest`, `none`, `all`, with a window). `cron-parser` is an optional peer of the core, loaded on first use, `experimental_loadCronEngine()`.
- `experimental_TimerClaims` and `experimental_TimerPoller`: the one claim, renew and release logic over the `TimerStore` contract, and `experimental_Scheduler` on top of it (cron, one-shot and interval entries, retries, `update` or `append` rescheduling, pause, resume, run now).
- `getNextCronMs` and `HeartbeatScheduler` of channels, and the cron helpers, `TimerManager`, `JobScheduler` and `CronTriggerExecutor` of workflows are clients of it, with their public API and the workflow presets kept. `InMemoryTimerStore` and `FileTimerStore` moved to the core (workflows exports the same classes), and `FileTimerStore` now sees what other processes wrote and locks its file while it writes.
- `TimerEntry` gained `trigger`, `catchUp`, `catchUpWindowMs` and `lastOccurrence`.

Triggers and routines (types, core, config):

- `CogitatorConfig.experimental_triggers` and `cog.experimental_triggers` (`experimental_TriggerManager`): routines (`prompt`, a target agent or workflow, `session`, `overlap` `skip`, `queue`, `parallel` or `replace`, `maxConcurrent`, `catchUp`, `owner`, `notify`) and their triggers: `cron` (with `timezone`), `api` (a bearer token the manager issues and keeps as its SHA-256, `issueToken`, `rotateToken`, or one from the environment), `webhook` (HMAC over the raw body), `github` (`X-Hub-Signature-256`, events and field filters, `ping`), `email` (Mailgun signature, Postmark and SendGrid secret) and `slack` (signature, URL verification, bot messages ignored). `maxPerHour` per trigger.
- The routine's prompt is the task, what the event carries follows it in a `<trigger-payload untrusted="true">` block the payload cannot close, and the event is kept with the input in the session log as `metadata.trigger` (`RunOptions.inputMetadata`).
- A firing starts one run: deliveries are deduplicated by their id in the routine store with a TTL, the run id is made from the trigger and the occurrence (`trg_<routine>.<trigger>_<occurrence>`) and claimed, and with `durable` a second start finds the run held. Two runtimes sharing their stores start each cron occurrence once. Durable routine runs a stopped process left are continued on `start()`.
- Routine stores (routines made at run time, trigger state, history, claims): `experimental_InMemoryRoutineStore`, `experimental_FileRoutineStore`, `experimental_RedisRoutineStore`, `experimental_PostgresRoutineStore`. Saved routines name their target and take secrets as `{ env }`. `experimental_fileTriggerStores()` puts routines, schedules and the inbox in `.cogitator/triggers` for a runtime and the CLI to share.
- The inbox: `experimental_Inbox` over `experimental_InMemoryInboxStore`, `experimental_FileInboxStore`, `experimental_RedisInboxStore` or `experimental_PostgresInboxStore`, items of kind `result`, `approval`, `question` and `failure`, sinks (`experimental_webhookSink`, signed), live changes with `subscribe()`. Runs waiting for a person are answered with `respond()`. The `Notification` hooks hear `routine_result` and `routine_failed`.
- Agents schedule themselves: `triggers.schedulerTools(agent)` gives an agent `schedule_task`, `list_tasks` and `cancel_task` whose tasks the manager runs on it in the thread they were given in, the description read back as data.
- Plugins register routines and triggers with `registerRoutine` and `registerTrigger`, also from an isolated process, and a routine's run holds a lease on the plugins.
- New error codes `TRIGGER_NOT_FOUND` (404) and `INBOX_ITEM_ANSWERED` (409). The config package reads `experimental_triggers` from files (`TriggersConfigSchema`), the routine schemas are in types (`RoutineSchema`, `TriggerSpecSchema`).

Channels: `experimental_channelSink` tells a routine's owner in their chat, `experimental_emailTriggerParser` reads mail for email triggers as the email channel does. The heartbeat's task text is wrapped as untrusted data the agent wrote earlier, and `verifyGitHubSignature`, `verifyMailgunSignature` and `secretsEqual` are the core's.

Workflows: `experimental_routineWorkflow` runs a workflow as a routine's target, its human approvals in the inbox and answered through the trigger manager, nodes that finally fail in the inbox (`experimental_inboxNotifier`, `experimental_inboxDeadLetterQueue`). `DefaultTriggerManager.start()` brings back the triggers of its store. `JobScheduler` refuses an invalid cron expression or time zone and reports runs it could not schedule (`onError`).

Server adapters: with `triggers` (the runtime's trigger manager) express, fastify, hono, koa, tetsu and next serve `POST /triggers/:id/fire` and `POST /triggers/:id/webhook` (the raw body handed over untouched, before the adapter's auth, up to 10 MiB) and `GET /inbox` and `PATCH /inbox/:id` (the caller's own items). Next gets `createTriggerHandler` and `createInboxHandler`. Shared handlers, OpenAPI paths and a conformance suite live in server-shared.

Studio: Inbox (live, read, archive, approve, reject, answer questions, also through `POST /approvals/:id`) and Schedules (start, stop, run now, pause, resume, history). The Plugins page lists the routines a plugin registered.

CLI: `cogitator schedule list | add | rm | run | pause | resume`, `cogitator inbox [--unread] | show | read | unread | archive` and `cogitator trigger fire | token`.

Breaking changes and migration:

- `schedule_task` (`createSchedulerTools`) checks a cron expression with the cron engine instead of a 5-field pattern: `@daily`, 6 fields and a new `timezone` parameter are taken, and the first run of a cron task is the expression's first occurrence instead of one minute after it was scheduled. A runtime that uses it without channels or workflows needs `cron-parser` installed (`npm install cron-parser`) or a `cron` engine passed in, a cron task fails with `CONFIGURATION_ERROR` otherwise. `list_tasks` and `cancel_task` leave the schedules of routines in the same store alone. The answer of `schedule_task` may also carry `timezone`.
- The message `HeartbeatScheduler` sends for a task no longer starts with `[SCHEDULED TASK]`: the description comes in a `<trigger-payload source="agent" untrusted="true">` block, and `raw.trigger` carries the event. Code that read the old text reads `raw.taskId` or `raw.trigger.text`.
- `RunNotification.type` has two more values, `routine_result` and `routine_failed`: an exhaustive `switch` over it needs the new cases.
- `PluginContributions` has `routines` and `PluginContext` has `registerRoutine` and `registerTrigger`: a hand-written object of either type adds them.
- `DefaultTriggerManager.start()` returns a promise that resolves once the triggers of its store are back. Code that calls it without `await` still works.
- `JobScheduler.registerCronJob()` and `scheduleRun()` with an invalid cron expression or time zone throw `VALIDATION_ERROR`, and a cron job whose run could not be scheduled is reported to `onError` (else logged) instead of being dropped silently.
- `CronTriggerExecutor` keeps the latest 100 missed occurrences when more were missed, instead of the oldest.
- `FileTimerStore` writes `timers.json` with mode 0600 under a lock file next to it.
