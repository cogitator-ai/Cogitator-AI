# @cogitator-ai/cli

## 0.17.2

### Patch Changes

- Updated dependencies [[`f3b6c69`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3b6c69c499a72010b99fa2e4467044a1b62d19d)]:
  - @cogitator-ai/config@0.36.3
  - @cogitator-ai/deploy@0.7.15

## 0.17.1

### Patch Changes

- Updated dependencies [[`e2f1c87`](https://github.com/cogitator-ai/Cogitator-AI/commit/e2f1c8793df4d1fdb06e9d8a5d0e8be984cbd2d2)]:
  - @cogitator-ai/mcp@19.9.0
  - @cogitator-ai/types@0.87.0
  - @cogitator-ai/core@0.76.0
  - @cogitator-ai/app-server@0.2.1
  - @cogitator-ai/channels@0.21.3
  - @cogitator-ai/config@0.36.2
  - @cogitator-ai/deploy@0.7.14
  - @cogitator-ai/memory@0.29.5
  - @cogitator-ai/server-shared@0.16.1
  - @cogitator-ai/studio@0.9.3
  - @cogitator-ai/evals@0.14.0

## 0.17.0

### Minor Changes

- [#313](https://github.com/cogitator-ai/Cogitator-AI/pull/313) [`2bb4941`](https://github.com/cogitator-ai/Cogitator-AI/commit/2bb4941dc40889458575db0893766c233dabaaaf) - Headless runs and a typed JSON-RPC app-server: Cogitator can now be driven by another program, a script with `cogitator run -p` or an editor and an app through `cogitator app-server`, without a terminal in between.

  New package `@cogitator-ai/app-server`:

  - `SessionHost` over a `Cogitator` and its agents: threads live in the runtime's memory, a turn is a run of `cogitator.start()` (or `startResume()` for a paused thread) whose handle steers and interrupts it, one turn per thread at a time. Every event of a turn goes out as `turn/event`, the events of the runs it delegates to (subagents, agents as tools) tagged with the tool call that started them.
  - `createAppServer(host)` speaks JSON-RPC 2.0 over any transport that moves whole messages, `serveStdio(server)` over NDJSON on stdio, writing lines in order and waiting for the output to drain. When stdin ends, the turns of the client are interrupted and waited for.
  - Methods: `initialize` (approvals asked or paused, notifications to leave out), `thread/start`, `resume`, `fork`, `list`, `archive`, `unarchive`, `setPermissionMode`, `turn/start` (input or a resume of a paused thread, an output schema, a model, a permission mode), `turn/steer` (`steer`, `followUp`, `inject`, guarded by the expected turn id), `turn/interrupt`, and `review/start`, which reviews uncommitted changes, a branch, a commit or custom instructions in a review thread and returns structured findings. Extensions under `_cogitator/*`: memory search, rewind, traces, and workflows and swarms when the host has runners for them. Every turn runs with `onSpan` and the host keeps the spans of its recent turns: clients that declare `traces: true` get each span as it ends in `_cogitator/trace/span`, and `_cogitator/trace/get` returns the spans kept of a turn.
  - The answer to `turn/start` always goes out before `turn/started`. Tool approvals are asked with `approval/request` in the shape of ACP `session/request_permission`, or the turn ends paused. Errors carry their own codes: not found, not initialized, thread busy, turn not active, thread paused, thread archived and runtime errors with the runtime's code. The core methods map onto ACP for the agent that comes next.
  - The protocol is written as Zod schemas (`@cogitator-ai/app-server/protocol`). A JSON Schema of it and a typed client with no dependencies (`@cogitator-ai/app-server/client`) are generated from them, and a test fails when the committed client drifts from the schemas.

  CLI:

  - `cogitator run -p` runs a session headless: `--output-format text|json|stream-json`, `--input-format stream-json` for many turns (`user` lines as turns of their own, or with a delivery to the turn going on, `resume`, `interrupt`), `--resume` and `--fork` of kept sessions, `--session-id`, `--json-schema` (inline or a file) for a structured answer and `--no-session-persistence`. A stream-json line is a stream event with `session_id` and `parent_tool_use_id`, and each turn ends with a `result` line. Exit codes: 0 completed, 1 failed, 2 usage, 3 paused. Only protocol output reaches stdout, the CLI's messages and the runtime's logs go to stderr. A prompt argument with a piped stdin sends both, the piped text after the prompt.
  - `cogitator app-server` serves the app-server on stdio, `generate-ts` and `generate-json-schema` write its client and schema.
  - Without `memory.adapter` both keep sessions in SQLite at `~/.cogitator/sessions.db` (`COGITATOR_SESSIONS_DB`), so later runs continue them. The interactive `cogitator run` is unchanged.

  Groundwork in the runtime:

  - server-shared owns the JSON-RPC helpers now, with a lenient parser for stdio clients that leave out `jsonrpc`, notifications, a `JsonRpcPeer` with pending requests and batches, and NDJSON reading and writing. a2a re-exports them, its API is the same.
  - `RunOptions.onDelegatedRun` hears every run a run delegates to, through foreground, background and bubbled subagents and agents used as tools, and streams it tagged by its parent call. `AgentStreamSession` takes a `delegated` option that opens a stream session of its own per delegated run.
  - `Cogitator.listThreads({ archived })`, `archiveThread` and `unarchiveThread`, refused while a run goes on in the thread.
  - `Cogitator.startResume()` resumes a paused run with a `RunHandle`, so a resumed run can be steered and aborted like a started one.

### Patch Changes

- Updated dependencies [[`2bb4941`](https://github.com/cogitator-ai/Cogitator-AI/commit/2bb4941dc40889458575db0893766c233dabaaaf)]:
  - @cogitator-ai/app-server@0.2.0
  - @cogitator-ai/server-shared@0.16.0
  - @cogitator-ai/core@0.75.0
  - @cogitator-ai/types@0.86.0
  - @cogitator-ai/channels@0.21.2
  - @cogitator-ai/evals@0.14.0
  - @cogitator-ai/mcp@19.8.3
  - @cogitator-ai/studio@0.9.2
  - @cogitator-ai/config@0.36.1
  - @cogitator-ai/deploy@0.7.13
  - @cogitator-ai/memory@0.29.4

## 0.16.1

### Patch Changes

- Updated dependencies [[`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a)]:
  - @cogitator-ai/types@0.85.0
  - @cogitator-ai/core@0.74.0
  - @cogitator-ai/config@0.36.0
  - @cogitator-ai/channels@0.21.1
  - @cogitator-ai/deploy@0.7.12
  - @cogitator-ai/mcp@19.8.2
  - @cogitator-ai/memory@0.29.3
  - @cogitator-ai/studio@0.9.1
  - @cogitator-ai/evals@0.14.0
  - create-cogitator-app@0.14.5

## 0.16.0

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
  - @cogitator-ai/channels@0.21.0
  - @cogitator-ai/studio@0.9.0
  - @cogitator-ai/config@0.35.0
  - @cogitator-ai/deploy@0.7.11
  - @cogitator-ai/mcp@19.8.1
  - @cogitator-ai/memory@0.29.2
  - @cogitator-ai/evals@0.14.0
  - create-cogitator-app@0.14.4

## 0.15.0

### Minor Changes

- [#308](https://github.com/cogitator-ai/Cogitator-AI/pull/308) [`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445) - Plugins, experimental: a plugin written for Claude Code loads unchanged, a Cogitator manifest adds code that runs in a process of its own under a permissions manifest, plugins reload by generation and install from marketplaces, npm and git, pinned.

  Every new entry point carries the `experimental_` prefix and is listed in `docs/EXPERIMENTAL_API.md`. Without `experimental_plugins` a runtime behaves as before: only the core's own plugin loads, which registers the built-in LLM providers.

  Plugins (types, core, config):

  - `CogitatorConfig.experimental_plugins` (`PluginsConfig`): plugins in code (`plugins`, made with `experimental_definePlugin`), plugin folders loaded in place (`dirs`, ids `name@inline`), the installed plugins (`installed`, default `~/.cogitator/plugins` or `COGITATOR_PLUGINS_DIR`), where settings are read (`settings`), `enabled` and `options` in code, the MCP connector (`mcp`), a secret store (`secrets`), host `permissions.deny`, `isolation` limits and `watch`. The config package reads the parts a file can hold.
  - Claude Code's format: `.claude-plugin/plugin.json` (or none), `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, the manifest's component keys with their replace, add and merge rules, path checks (`./`, existence, containment), strict `userConfig` options, marketplace entries with `strict` mode, `dependencies`, `defaultEnabled`. Components are named as there: skills `plugin:skill`, subagents `plugin:folder:name`, commands `/plugin:name`, MCP servers `plugin:<plugin>:<server>` with tools `mcp__plugin_<plugin>_<server>__<tool>`. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (with `COGITATOR_` names), `${CLAUDE_PROJECT_DIR}` and `${user_config.KEY}` are put into hooks, MCP configs and text, a secret only where a process needs it, and hooks get `CLAUDE_PLUGIN_OPTION_<KEY>`. `.cogitator-plugin/plugin.json` adds `main`, `permissions`, `ui.panels` and `engines.cogitator`. `experimental_validatePlugin` checks a folder as `claude plugin validate` does.
  - What plugins add reaches every run: tools after the runtime's own, skills (every agent gets them), subagents and commands (the subagent and command services are on once plugins are configured), hooks in a layer per plugin under the managed hook policies, MCP servers, LLM backends, middleware and Studio panels. A run takes them when it starts.
  - `PluginContext`: one API for the core's plugin, the host's plugins and third-party ones. `registerTool` (a `tool()` or a JSON Schema spec), `registerSkill`, `registerAgent`, `registerCommand`, `registerHooks`, `registerMcpServer`, `registerLLMBackend`, `registerMiddleware`, `registerPanel`, `onDispose`, each returning its disposer, plus `options`, `secret()`, `files`, `fetch`, `exec`, `logger` and `signal`.
  - Options and secrets: `userConfig` values from `pluginConfigs` of the settings, `sensitive` ones from the operating system's credential store (`experimental_keychainSecretStore`: `security` on macOS, `secret-tool` on Linux, PowerShell with the Credential Manager on Windows, the secret on standard input). Without one a secret fails with `SECRET_STORE_UNAVAILABLE`, never a plain file. `experimental_memorySecretStore` for servers that bring their own vault.
  - Enabling: `enabledPlugins` of the settings layers (managed over code over local, project and user, a project's files once trusted), else `defaultEnabled`, dependencies enabled with what needs them. Of two enabled plugins with one name the one managed settings enable loads, else code over folders over installed, and a disabled plugin shadows nothing.
  - Lifecycle: `cog.experimental_plugins` (`experimental_PluginHost`) loads plugins in the order of their dependencies, with `list()`, `get()`, `reload()`, `setEnabled()`, `snapshot()`, `onChange()` and `dispose()`. Registrations unload in reverse order, a reload builds a new generation and swaps it in only once it loaded in full (its MCP servers started), a failed one keeps the old (`code: 'PLUGIN_RELOAD_FAILED'`), also when a save left `plugin.json` broken, the new manifest's dependencies cannot load, a secret cannot be read or the host refuses a registration of an isolated plugin, and `watch` reloads a changed folder. A run keeps the generations it started with until it ends (`lease()`), so a reload never pulls tools, skills, subagents, hooks, the MCP servers its hooks call, LLM providers or a plugin process from under it. `experimental_plugins.root` sets the project the plugins work in, and a generation keeps the skill text and files of a plugin folder as they were when it loaded. Plugins unload before the plugins they depend on. Missing, disabled, failed or out-of-range dependencies block with `PLUGIN_DEPENDENCY_UNMET`, cycles with `PLUGIN_DEPENDENCY_CYCLE`, and a local copy stands in for a dependency without a range check, as in Claude Code.
  - Isolation: plugin code from a folder runs in a child process under Node's permission model, reading its folder and writing its data folder only, without processes, workers, addons, network or DNS, and refused when its folder links outside it. What it asks of the host goes through the permission engine against its `permissions` (`Read`, `Edit`, `Bash`, `WebFetch` rules), refused with `PLUGIN_PERMISSION_DENIED`, and the hooks and MCP servers of a plugin with `permissions` are checked against them too, every kind of hook (`mcp_tool` by its server and tool), an MCP server that sets a loader variable such as `NODE_OPTIONS` refused. A plugin with code and no `permissions` registers no hooks or MCP servers, the host's `deny` rules apply to every plugin, a version that drops `permissions` keeps the ones granted, and `exec` runs with the host's path variables only. Plugins in the host's code get the same checks.
  - Installing: `experimental_PluginInstaller` adds marketplaces (Claude Code's `marketplace.json` from GitHub, git, an https URL, a folder or a file, `extraKnownMarketplaces` of the settings) and installs from them or straight from npm and git, with every plugin source type of Claude Code (relative path, `github`, `url`, `git-subdir`, `npm`, `archive`, `command`). Installs are pinned to the commit, the npm version and integrity or the archive digest, a plugin's permissions are agreed to at install, dependencies resolve against `<name>--v<version>` tags, and updates follow Claude Code's version rule, install the dependencies a new version adds and keep a dependency within the ranges on it. Options are checked before anything is written, a marketplace is read and checked before its folder is replaced, the headers of a download never follow a redirect to another origin, private addresses are refused however an IPv6 address writes them, npm names and versions are checked before npm runs and npm never runs through a shell (on Windows node runs `npm-cli.js`), every version an install or update would write is checked against every installed range and the ranges of the plugins still being installed, whatever the source, and a failed install or update removes what it installed on the way, a timed-out install command is killed with what it started, a dependency already installed outside a new range is updated within every installed range or the install fails before writing, an update never leaves the range an installed plugin puts on it, installing a plugin that came as a dependency makes it your own, and every plugin id gets a data folder of its own. Downloads go over https only and never to loopback, link-local or metadata hosts.
  - New error codes: `PLUGIN_NOT_FOUND`, `PLUGIN_INVALID`, `PLUGIN_ACTIVATION_FAILED`, `PLUGIN_DEPENDENCY_CYCLE`, `PLUGIN_DEPENDENCY_UNMET`, `PLUGIN_PERMISSION_DENIED`, `PLUGIN_RELOAD_FAILED`, `PLUGIN_INSTALL_FAILED`, `SECRET_STORE_UNAVAILABLE`.

  MCP: `experimental_mcpConnector()` connects `.mcp.json` servers (stdio, HTTP, SSE) for `experimental_plugins.mcp` and `subagents.mcp`, tools named `mcp__<server>__<tool>`. A new client transport `legacy-sse` (and `createSseTransport()`) connects servers of the older HTTP+SSE protocol, which the connector uses for `type: "sse"`.

  Evals: `experimental_runPluginEvals()` runs a plugin's eval suite in the format of `claude plugin eval` (`evals/<case>/prompt.md`, `case.yaml`, the `regex`, `tool_used`, `tool_order`, `file_exists`, `llm` and `baseline` graders, fixed MCP mocks), with and without the plugin, and writes `aggregate-result.json` (`schemaVersion: 1`) and a self-contained `report.html`. Each case is judged by its own agent model unless `judgeModel` is set, the grants hold for delegated agents too and their calls are recorded, a judge grader skipped at the cost ceiling makes the result partial, an interrupt aborts the judge and starts no further judge grader, each run has plugin data of its own and its workspace as the project, `experimental.evals` takes `./` paths and an array, and `cogitator plugin eval` accepts Claude Code's CI flags and exits 1 on a command-line error.

  CLI: `cogitator plugin install | uninstall | enable | disable | update | list | configure | validate | eval` and `cogitator plugin marketplace add | list | remove | update`, with `--json` results and Claude Code's exit codes. `enable` and `disable` without `--scope` write to the settings file that decides now and warn when a higher one overrides it. `cogitator run` connects the MCP servers of plugins of its config.

  Studio: a Plugins page with each plugin's status, generation, contributions, permissions and diagnostics, Reload and Enable or Disable, and plugin panels in a sandboxed frame that may load or fetch nothing, closed when it navigates away, which talk to their plugin through `postMessage`.

  Breaking changes and migration:

  - `ToolRegistry.register()`, `ToolRegistry.registerMany()` and `registerLLMBackend()` return a disposer instead of `void`. Code that calls them is unaffected, a class that overrides `register` returns the disposer too.
  - `LLMPlugin`, `LLMPluginMetadata` and `LLMBackendFactory` moved to `@cogitator-ai/types`. `@cogitator-ai/core` still exports them.
  - The built-in providers are created through the core's plugin. `llm.backends` still wins over them, and a provider registered globally with `registerLLMBackend` under a built-in name is still not used for that name. A provider registered globally wins over a plugin's provider of the same name.
  - `DefinitionSource` has a new value `plugin`, and `SubagentDefinition`, `CommandDefinition` and `ExpandedCommand` a `plugin` field: a `switch` over the source that must be exhaustive needs the case.
  - `ErrorCode` has the new members above: a `Record<ErrorCode, ...>` of your own needs entries for them.
  - A command file's `argument-hint` written as a YAML list (`argument-hint: [env]`) is read as `[env]` instead of being dropped with a warning.
  - `agentMemoryDir` accepts names with `:` parts, kept in the folder `part.part`.

### Patch Changes

- Updated dependencies [[`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445)]:
  - @cogitator-ai/types@0.83.0
  - @cogitator-ai/core@0.72.0
  - @cogitator-ai/mcp@19.8.0
  - @cogitator-ai/evals@0.14.0
  - @cogitator-ai/studio@0.8.0
  - @cogitator-ai/config@0.34.0
  - @cogitator-ai/channels@0.20.7
  - @cogitator-ai/deploy@0.7.10
  - @cogitator-ai/memory@0.29.1
  - create-cogitator-app@0.14.3

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

- Updated dependencies [[`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6), [`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6)]:
  - @cogitator-ai/types@0.82.0
  - @cogitator-ai/core@0.71.0
  - @cogitator-ai/memory@0.29.0
  - @cogitator-ai/config@0.33.0
  - @cogitator-ai/studio@0.7.0
  - @cogitator-ai/channels@0.20.6
  - @cogitator-ai/deploy@0.7.9
  - @cogitator-ai/mcp@19.7.6
  - create-cogitator-app@0.14.2

## 0.13.2

### Patch Changes

- Updated dependencies [[`cb4a7fa`](https://github.com/cogitator-ai/Cogitator-AI/commit/cb4a7fa20594805d6bf150f680185cc07520fec0)]:
  - @cogitator-ai/types@0.81.0
  - @cogitator-ai/core@0.70.0
  - @cogitator-ai/config@0.32.0
  - @cogitator-ai/memory@0.28.0
  - @cogitator-ai/channels@0.20.5
  - @cogitator-ai/deploy@0.7.8
  - @cogitator-ai/mcp@19.7.5
  - @cogitator-ai/studio@0.6.3
  - create-cogitator-app@0.14.1

## 0.13.1

### Patch Changes

- Updated dependencies [[`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4)]:
  - @cogitator-ai/types@0.80.0
  - @cogitator-ai/core@0.69.0
  - create-cogitator-app@0.14.0
  - @cogitator-ai/channels@0.20.4
  - @cogitator-ai/config@0.31.1
  - @cogitator-ai/deploy@0.7.7
  - @cogitator-ai/mcp@19.7.4
  - @cogitator-ai/memory@0.27.1
  - @cogitator-ai/studio@0.6.2

## 0.13.0

### Minor Changes

- [#280](https://github.com/cogitator-ai/Cogitator-AI/pull/280) [`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Send Ollama custom headers from the CLI and the embedding service.

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/memory@0.27.0
  - @cogitator-ai/config@0.31.0
  - @cogitator-ai/types@0.79.0
  - @cogitator-ai/channels@0.20.3
  - @cogitator-ai/core@0.68.1
  - @cogitator-ai/studio@0.6.1
  - create-cogitator-app@0.13.6
  - @cogitator-ai/deploy@0.7.6
  - @cogitator-ai/mcp@19.7.3

## 0.12.5

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0
  - @cogitator-ai/core@0.68.0
  - @cogitator-ai/config@0.30.0
  - @cogitator-ai/studio@0.6.0
  - @cogitator-ai/channels@0.20.2
  - @cogitator-ai/deploy@0.7.5
  - @cogitator-ai/mcp@19.7.2
  - @cogitator-ai/memory@0.26.7
  - create-cogitator-app@0.13.5

## 0.12.4

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0
  - @cogitator-ai/core@0.67.0
  - @cogitator-ai/config@0.29.0
  - @cogitator-ai/channels@0.20.1
  - @cogitator-ai/deploy@0.7.4
  - @cogitator-ai/mcp@19.7.1
  - @cogitator-ai/memory@0.26.6
  - @cogitator-ai/studio@0.5.1
  - create-cogitator-app@0.13.4

## 0.12.3

### Patch Changes

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/types@0.76.0
  - @cogitator-ai/core@0.66.0
  - @cogitator-ai/channels@0.20.0
  - @cogitator-ai/studio@0.5.0
  - @cogitator-ai/mcp@19.7.0
  - @cogitator-ai/config@0.28.0
  - @cogitator-ai/deploy@0.7.3
  - @cogitator-ai/memory@0.26.5
  - create-cogitator-app@0.13.3

## 0.12.2

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0
  - @cogitator-ai/core@0.65.0
  - @cogitator-ai/studio@0.4.3
  - @cogitator-ai/channels@0.19.1
  - @cogitator-ai/config@0.27.1
  - @cogitator-ai/deploy@0.7.2
  - @cogitator-ai/mcp@19.6.1
  - @cogitator-ai/memory@0.26.4

## 0.12.1

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0
  - @cogitator-ai/core@0.64.0
  - @cogitator-ai/channels@0.19.0
  - @cogitator-ai/config@0.27.0
  - @cogitator-ai/studio@0.4.2
  - @cogitator-ai/mcp@19.6.0
  - @cogitator-ai/deploy@0.7.1
  - @cogitator-ai/memory@0.26.3
  - create-cogitator-app@0.13.2

## 0.12.0

### Minor Changes

- [#292](https://github.com/cogitator-ai/Cogitator-AI/pull/292) [`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1) - An Ollama container in the Docker deployment of a project with local models, `cogitator deploy logs`, and the Fly app and organization in the deploy config.

  Behavior change: a docker deployment whose models run on a local Ollama used to reach the Ollama of the Docker host through `host.docker.internal`. From this release its next deploy runs an Ollama container next to the app instead and downloads the models into it on the first start, which takes as long as the download. Set `deploy.services.ollama: false` to keep reaching the Ollama of the host.

  - When the project's models run on a local Ollama, the docker target's Compose file runs an `ollama` service on `ollama/ollama:0.40.10`, with the models in the `ollama-data` volume and a health check. The roles are looked at one by one, in the environment the deployment gets (`deploy.env` included): the chat models the runtime uses (`llm.defaultModel`, `context.summaryModel` unless context is off, the models of the memory stages that are set, `reflection.reflectionModel` with reflection on, `guardrails.model` unless guardrails are off, `security.promptInjection.llmModel` with `classifier: llm`) and the embeddings of `memory.embedding` with `provider: ollama` (`nomic-embed-text` unless `memory.embedding.model` names another). Ollama Cloud models (a `:cloud` tag, or an API key without a URL) belong to the chat role and are never pulled. A role whose Ollama URL points beyond this machine keeps it, the variables it follows are forwarded (`GPU_OLLAMA` for `baseUrl: ${GPU_OLLAMA}`), and only the local roles move to the container. With `llm.defaultProvider: ollama` and no model in the config there is nothing to pull, so the app reaches the Ollama of the host with a warning unless `deploy.ollama.models` lists the models. A one-shot `ollama-pull` service pulls their models before the app starts: each model is an argument after `--`, never part of the script, and one the volume has already is skipped, so a restart without network still starts. A model name `ollama pull` would refuse or read as a flag fails preflight. A failed download fails the deploy with the last lines of the job, and the CLI says that the first start downloads the models. Redis and Postgres stay as they were.
  - A local chat role gets `COGITATOR_OLLAMA_BASE_URL`, `OLLAMA_BASE_URL`, `OLLAMA_URL` and `OLLAMA_HOST` set to `http://ollama:11434`, also when one of them was detected as a secret with a localhost value. Local embeddings get the variables their `memory.embedding.baseUrl` follows, such as `${OLLAMA_EMBEDDING_URL:-http://localhost:11434}`, with the whole URL or only the host for a variable that is the host part, checked to give the service URL, else left alone with a warning. A variable another provider's settings reference is never rewritten, and a variable is set only when it moves no role that stays remote, and the analyzer warns when the embeddings cannot reach the container or when `services.ollama: true` runs one no model uses.
  - `deploy.services.ollama` turns the container on or off. Off, the local roles reach the Ollama of the Docker host through `host.docker.internal` as before, each on the port of its own local URL, and a warning lists the models to pull there. The keys of `deploy.services` replace the detected ones one by one, so the opt-out keeps Redis and Postgres detected from the memory adapter. `deploy.ollama` sets the `models` to pull (the detected ones when unset, models agents name in code are not detected), `gpu: true` to reserve the NVIDIA GPUs of the host and the `image`. On Fly the analyzer warns when Ollama models or `services.ollama` have no Ollama to run on.
  - `cogitator deploy logs [service]` shows the logs of the deployment: `docker compose logs` of the deployed stack on the docker target (`-f, --follow`, `-n, --tail`, 100 lines by default, `--timestamps`, one service such as `app` or `ollama-pull`), `flyctl logs --app <app>` on Fly (`--no-tail` unless following). The commands are built as argument lists, a service name or tail that would read as a flag is refused, flags that do not apply to an action (or to Fly) are usage errors, and a logs command stopped by a signal exits with 128 plus its number. `Deployer.logsCommand()` resolves to the command for custom pipelines, and the optional `DeployProvider.logsCommand()` may return it or a promise of it.
  - `loadConfig({ env })` reads the `${VAR}` references of the file, the `COGITATOR_*` variables and the shared Ollama variables from `env` instead of `process.env`, and `loadEnvConfig(env)` and `loadEnvDefaults(env)` take it too. The deploy analyzer loads the config this way in exactly the environment the app container gets (`deploy.env`, the forwarded secrets and the Ollama variables it sets), and forwards the variables the config reads that are set (`${VAR}` references and `COGITATOR_*` overrides such as `COGITATOR_LLM_DEFAULT_MODEL`), so the app asks for the models the deployment pulled. `configOverrides.ollama` merges into `deploy.ollama` field by field.
  - `deploy.app` names the Fly app, the image name stays the fallback, and `deploy.org` creates a new app with `fly apps create --org <org>`. The config schema and Fly preflight refuse an app name Fly would refuse (lowercase letters, digits and dashes, starting and ending with a letter or digit, 63 characters at most) and an organization that is not a slug. `isFlyAppName`, `isFlyOrgSlug` and `isOllamaModelName` are exported from `@cogitator-ai/types`.
  - The README of a project from `create-cogitator-app` whose docker deployment gets an Ollama container says that it runs and fills its own Ollama.

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/deploy@0.7.0
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/config@0.26.0
  - create-cogitator-app@0.13.1
  - @cogitator-ai/channels@0.18.6
  - @cogitator-ai/core@0.63.1
  - @cogitator-ai/mcp@19.5.31
  - @cogitator-ai/memory@0.26.2
  - @cogitator-ai/studio@0.4.1

## 0.11.5

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/core@0.63.0
  - @cogitator-ai/studio@0.4.0
  - @cogitator-ai/channels@0.18.5
  - @cogitator-ai/config@0.25.1
  - @cogitator-ai/deploy@0.6.36
  - @cogitator-ai/mcp@19.5.30
  - @cogitator-ai/memory@0.26.1

## 0.11.4

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b), [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/memory@0.26.0
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/config@0.25.0
  - create-cogitator-app@0.13.0
  - @cogitator-ai/channels@0.18.4
  - @cogitator-ai/studio@0.3.21
  - @cogitator-ai/mcp@19.5.29
  - @cogitator-ai/deploy@0.6.35

## 0.11.3

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/channels@0.18.3
  - @cogitator-ai/config@0.24.8
  - @cogitator-ai/deploy@0.6.34
  - @cogitator-ai/mcp@19.5.28
  - @cogitator-ai/memory@0.25.6
  - @cogitator-ai/studio@0.3.20

## 0.11.2

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - create-cogitator-app@0.12.0
  - @cogitator-ai/channels@0.18.2
  - @cogitator-ai/config@0.24.7
  - @cogitator-ai/deploy@0.6.33
  - @cogitator-ai/mcp@19.5.27
  - @cogitator-ai/memory@0.25.5
  - @cogitator-ai/studio@0.3.19

## 0.11.1

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/channels@0.18.1
  - @cogitator-ai/config@0.24.6
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/deploy@0.6.32
  - @cogitator-ai/mcp@19.5.26
  - @cogitator-ai/memory@0.25.4
  - @cogitator-ai/studio@0.3.18

## 0.11.0

### Minor Changes

- [#278](https://github.com/cogitator-ai/Cogitator-AI/pull/278) [`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32) - Channels: a Microsoft Teams channel on the Bot Framework protocol, with no SDK.

  - `teamsChannel({ appId, appPassword, tenantId })` takes activities on a webhook, on a server of the channel's own (`/api/messages`, bodies up to 1 MB, other routes such as a GitHub webhook served on the same port) or through `handleWebhook` and `webhookListener()`. Every request must carry a Bot Framework JWT, checked with `node:crypto` alone: RS256 only, signed by a key of the published JWKS (cached, loaded again in the background once a day, and for an unknown key at most every five minutes), issued by `https://api.botframework.com` for the App ID, valid now within five minutes of skew, with a `serviceurl` claim equal to the activity's `serviceUrl` and a key endorsed for `msteams`. Activities are answered at once and handled after, each once, and the bot's own are skipped.
  - Answers go to the Bot Connector of the conversation's verified `serviceUrl` (optionally limited to `serviceUrlHosts`), with a client credentials token from the bot's own tenant (`appType: 'SingleTenant'` by default, `'MultiTenant'` for legacy bots, `'UserAssignedMSI'` with a `tokenProvider`), cached until shortly before it expires. Requests to one conversation stay inside all four of Teams' limits (7 a second, 8 in 2 seconds, 60 in 30 seconds, 1800 an hour), with edits and typing kept to three quarters of each so new messages always find room. Throttled and failing requests (`429`, `412`, `502`, `504`) are tried again with a backoff that doubles, with jitter, holding the conversation back meanwhile, every request has a timeout, and errors are `TeamsApiError`s with the Bot Connector's `errorCode`. After `MessageWritesBlocked` (the user blocked the bot) the conversation gets nothing more until it writes again.
  - Each personal chat, group chat and channel thread is a conversation of its own: `channelId` is the conversation id, a channel thread's root message is its `topicId`, and `userId` is the user's Entra object id. In group chats and channels the bot answers @mentions without the mention in the text (`trigger: 'all'` answers every message an app with resource-specific consent gets), and only users of its own tenant unless `tenants` says otherwise.
  - Answers are Markdown with `textFormat: 'extendedmarkdown'`, up to 13653 characters a message (80 KB of JSON), with images sent as links so injected text cannot leak data through an image URL, and stream into a message the bot edits. Buttons are Adaptive Cards with `Action.Execute`, answered in the invoke response, and an `Action.Submit` fallback, both delivered to `onAction`, so approval prompts get Approve and Deny buttons. Files upload in personal chats through a file consent card, and elsewhere go out by their public URL. A message the Gateway refuses while it stops is answered `503`.
  - `ChannelType` includes `'teams'`, and a channel thread is a `topicId`.
  - `ChannelAction.groupId` names the group a button was pressed in. The Gateway checks an approval press against the group policy like a message of that group (Telegram and Teams set it), and a press while the Gateway stops gets `approvals.stoppingMessage` and leaves the request waiting instead of being lost.
  - `chunkMessage` never cuts an emoji or another surrogate pair in two, on every channel.
  - In `cogitator.yml`, `channels.teams` takes owners (Entra object ids), `appType`, `tenantId`, `tenants`, `users`, `trigger`, `serviceUrlHosts` and the webhook port and path (default `3978`), with the secrets from `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` and `TEAMS_TENANT_ID`. `cogitator init`, `cogitator wizard` and create-cogitator-app (`--channels teams`) set up a single-tenant bot. Projects that `cogitator init` and create-cogitator-app generate serve its messaging endpoint on the WebChat port when WebChat runs, and the GitHub webhook on the Teams port when both run, while `cogitator wizard` writes `cogitator.yml` with a port per channel (3978 for Teams). `UserAssignedMSI` is built in code with a `tokenProvider`.

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/channels@0.18.0
  - @cogitator-ai/types@0.67.0
  - create-cogitator-app@0.11.0
  - @cogitator-ai/config@0.24.5
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/deploy@0.6.31
  - @cogitator-ai/mcp@19.5.25
  - @cogitator-ai/memory@0.25.3
  - @cogitator-ai/studio@0.3.17

## 0.10.0

### Minor Changes

- [#276](https://github.com/cogitator-ai/Cogitator-AI/pull/276) [`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30) - Channels: an email channel, so an agent answers mail in the thread it came in.

  - `emailChannel({ address, smtp, imap, allowFrom })` reads unread mail of a mailbox over IMAP with `imapflow` and `postal-mime`: IDLE reports new mail at once and a poll catches the rest, mail is flagged `\Seen` only once the Gateway took it, so a restart reads only new mail, and a dropped connection is opened again with a wait that doubles from 1 s up to 60 s. Mail is fetched in batches, mail over `maxBytes` (25 MB) is skipped by its size, the rest is parsed a few at once and handed over in order. `start()` fails at once when `imapflow`, `postal-mime` or `nodemailer` is missing.
  - Inbound webhooks of Mailgun, Postmark and SendGrid work instead of IMAP or with it, on a server of the channel's own (bodies up to 10 MB) or through `handleWebhook({ method, query, headers, rawBody })`. Mailgun requests must carry a valid HMAC of timestamp and token (or of the body in JSON mode), at most 5 minutes old, and a replayed signature is not handled again. Postmark and SendGrid do not sign, so their URL carries basic auth or a `token`, compared in constant time. SendGrid fields are decoded in the character sets SendGrid names. A request whose mail the Gateway does not take is answered `503`, so the provider sends it again.
  - Answers go out over SMTP with `nodemailer`, or any transport with `sendMail`, as HTML rendered from the Markdown with a plain text alternative, with a `Re:` subject and `In-Reply-To` and `References` set, so mail clients keep the thread. A reminder with only a topic answers the thread's latest mail. Files are sent as attachments. Sent mail cannot be edited (`editable: false`), and an answer is one mail however long.
  - A message's `channelId` and `userId` are the sender's address in lower case, `topicId` is the thread's first `Message-ID`, and `replyTo` is `In-Reply-To`, so each email thread is a conversation of its own. The agent reads the plain text part, or the HTML as text, without the quoted history (`On ... wrote:` in several languages, Outlook headers, a trailing `>` block) and the signature, with the subject on a thread's first mail, and attachments up to 10 MB.
  - The bot never answers itself, its `aliases` or mail with the `X-Cogitator` header it puts on everything it sends, and skips auto-replies, bounces and bulk or list mail. Each `Message-ID` is handled once.
  - Email is spoofable, so the bot answers only `allowFrom` (addresses, domains, `*.domain` or `*`, nobody by default with a warning) and `owners`, reading the address outside the quoted strings and comments of `From`. It drops mail whose DKIM, SPF or DMARC results fail for the `From` domain, using only results the receiving side wrote: Mailgun's (two copies of a header fail) and SendGrid's reports, Postmark's spam tests, and over IMAP the topmost `Authentication-Results` of `trustedAuthservIds`, without which IMAP mail counts as not reported. `senderAuth: 'required'` also drops mail without results, and owner mail reaches the agent only with a passing result.
  - A channel learns which messages the Gateway does not answer because it stops: the new optional `Channel.redeliver(msg)` gets a message that comes in while the Gateway stops (before its handler resolves) and the queued or running ones `stop()` drops after `drainTimeout`, before the channels stop. The email channel leaves such mail unread or marks it unread again, and answers the webhook `503`.
  - `htmlToText` and `markdownToHtml` are exported, and `ChannelType` includes `'email'`.
  - In `cogitator.yml`, `channels.email` takes the address, `allowFrom`, owners (always answered), `imap`, `smtp` and a `webhook` provider, checked as addresses and domains, with the secrets and, where the file leaves them out, hosts and ports from `EMAIL_*` variables. `cogitator init`, `cogitator wizard` and create-cogitator-app (`--channels email`) set up a bot that reads a mailbox over IMAP.

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/channels@0.17.0
  - @cogitator-ai/types@0.66.0
  - create-cogitator-app@0.10.0
  - @cogitator-ai/config@0.24.4
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/deploy@0.6.30
  - @cogitator-ai/mcp@19.5.24
  - @cogitator-ai/memory@0.25.2
  - @cogitator-ai/studio@0.3.16

## 0.9.0

### Minor Changes

- [#272](https://github.com/cogitator-ai/Cogitator-AI/pull/272) [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899) - Channels: a GitHub channel, so an agent answers issues, pull requests, comments and code reviews.

  - `githubChannel({ token, webhook: { secret, port } })` takes events from a repository or organization webhook: opened issues and pull requests, issue and pull request comments, reviews with a body and comments on lines of a diff. Every delivery is checked against `X-Hub-Signature-256` with the webhook secret, answered at once and handled after, and each `X-GitHub-Delivery` is handled once. It runs a webhook server of its own on `port` (bodies up to 1 MB), or `handleWebhook` is mounted in any HTTP server with the raw body.
  - Each issue or pull request is a conversation, `channelId` `owner/repo#number`, answered with a comment on it. A comment on a line is answered in its review thread, which is the message's `topicId`, so every review thread is a conversation of its own.
  - It answers only the repository's owner, the organization's members and collaborators (`author_association`), whatever the trigger: `associations` names others or `'any'`, and `authors` lists logins answered whatever their association. What people write steers an agent that holds the bot's token, so the docs recommend a bot account with a fine-grained token scoped to its repositories, `repositories` set (`start()` warns without it) and approvals for tools that write.
  - By default the bot answers only mentions of `@login` (outside fenced, indented and inline code and quotes), plus the next comment of someone it answered (such as the answer to an approval prompt) and comments in review threads it replied in. `trigger: 'all'` answers every event, and `repositories` limits it to `owner/repo` or `owner/*`. It skips its own comments, with or without an app's `[bot]`, and other bots unless `allowBots` is set.
  - Deliveries are handled once by `X-GitHub-Delivery` and by the comment, issue or review they carry, remembered in memory. A delivery that comes while the bot's login cannot be loaded is still answered `200` and the login is tried again before the event is dropped. Once stopped the channel answers `503`.
  - Answers are sent finished, since GitHub notifies people of a comment's first text, and `stream: true` streams them into a comment it edits, at most every 3 seconds (`GITHUB_MIN_EDIT_INTERVAL`) with the latest text. Answers past 65536 characters go out as several comments. `setReaction` uses GitHub's eight reactions and replaces the bot's earlier one, one after another per message, and `sendFile` links files with a public URL, as GitHub has no upload API for comments.
  - `token` takes a function too, for GitHub App installation tokens that expire, with `login` set to `<app-slug>[bot]`. `apiUrl` points it at GitHub Enterprise Server. REST errors are `FeedError`s with `retryAfter` from `Retry-After` or the rate limit reset.
  - `webhookListener()` is the webhook as a Node request listener, and `webchatChannel({ routes })` serves plain HTTP routes on the WebChat port, so a project with both takes GitHub's webhook on the WebChat port.
  - `ChannelType` includes `'github'`. In `cogitator.yml`, `channels.github` reads `GITHUB_CHANNEL_TOKEN` (falling back to `GITHUB_TOKEN`, the token of the `github_api` tool, with a warning) and `GITHUB_WEBHOOK_SECRET`, and checks `repositories`, `webhook.path` and numeric `ownerIds`. `cogitator init`, `cogitator wizard` and create-cogitator-app (`--channels github`) set it up with `GITHUB_CHANNEL_TOKEN`, and with WebChat too the scaffolded webhook is a route of the WebChat server.

### Patch Changes

- [#272](https://github.com/cogitator-ai/Cogitator-AI/pull/272) [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899) - Channels: the gateway answers the messages of a thread one at a time and keys threads by conversation.

  This changes behavior for existing gateways:

  - `queueMode` defaults to `'sequential'`: a thread answers its messages in the order they came, one at a time, while different threads run side by side. A channel's message handler returns once the message is queued, so Telegram long polling and the Bluesky and Threads polls go on to other chats, button presses and stop buttons while a thread is busy. `injectMessage` resolves once the message is answered, and the new `gateway.idle()` waits until every queued message is.
  - Channels now confirm a message to their platform once it is queued, before it is answered: Telegram long polling moves its offset, Bluesky marks its notifications seen, Threads moves past the post. So `gateway.stop()` drains first: it flushes the debouncer and waits up to the new `drainTimeout` (default 30000 ms) for the queued messages and the runs in progress, then aborts the runs still going, drops what still waits, waits up to `drainTimeout` again for the aborted runs to settle and only then stops the channels. Messages that come in while it stops are dropped and reported to `onError`, a second `stop()` returns the same promise, and `RuntimeBuilder`'s `cleanup()` closes memory after it. `cogitator assistant` and `cogitator up` wait for it, quitting at once on a second Ctrl-C.
  - `injectMessage` rejects when the message was not answered: its run failed (also reported to `onError`, as before), `stop()` aborted or dropped it, or it came in while the gateway was stopping. `HeartbeatScheduler` records that as an error, and a one-shot task that fails stays pending and fires again on a later poll or after a restart (up to `maxRetries`, unless it is `bestEffort`) instead of being lost.
  - The default thread key is `channelType:conversation:userId` instead of `channelType:userId`. The conversation is the new `ChannelMessage.conversationId` when a channel sets it, else `channelId` plus `:topicId`. A user's private chat, each group, each Telegram forum topic, each Slack thread and each GitHub issue, pull request and review thread is a thread of its own.
  - Slack sets `topicId` to the `ts` of the Slack thread of a channel message. A top-level channel message is answered in a new Slack thread, a conversation of its own without the history of earlier ones, and `sendText` posts into the `topicId` thread when a reply names no message. A DM stays one conversation.
  - Bluesky and Threads set `conversationId` to `thread:<root>`, so the replies of one post thread stay in one thread while each answer still goes to its post. A WhatsApp direct chat addressed by LID sets `conversationId` to the person's phone-number jid when WhatsApp shares it, so it is one thread with the chat addressed by phone number. `userId` stays as before. `ChannelAction` and `ChannelStop` carry `conversationId` too, and the approval buttons check it.
  - Telegram gives a button press a `topicId` only in a forum topic or a private chat topic, as it does for messages, so Approve and Deny work in the reply threads of plain groups.
  - Runs get the `topicId` and `conversationId` of their message (`RunOptions`, `ToolContext`, the run middleware context and `invokeTool` options have both, and `@cogitator-ai/ai-sdk` passes them between the AI SDK and Cogitator tool contexts like the other channel fields, while workflows and swarms build no channel context), `schedule_task` stores them with the task and `HeartbeatScheduler` puts them on the message it fires, so a reminder set in a topic or a post thread fires there, even after the user moved on. A task without them is answered in the topic of the user's most recent conversation in its chat, taken from the conversations the gateway keeps in each user's session metadata (`conversations`, up to 50). `compactAll()` finds the threads of stored sessions there after a restart.
  - `stats.totalSessions` and `getSessions()` count conversations, not users, and the gateway keeps its bookkeeping of the 10000 most recent threads (`MAX_TRACKED_THREADS`).
  - New exports: `defaultThreadKey`, `legacyThreadKey`, `conversationOf`, `readConversations`, `CONVERSATIONS_KEY`, `MAX_TRACKED_THREADS` and the types `ConversationRef`, `StoredConversation` and `MessageProcessor`. `MessageQueue.push` returns a promise that settles once the message is done with, `true` when it was handled, and its processor may resolve `false` for a message it could not handle (`MessageProcessor`).

  Migration: to keep the old behavior, pass `queueMode: 'parallel'`, and pass `session: { threadKey: legacyThreadKey }` to keep the threads stored under the old key (their history is not found by the new one). With `legacyThreadKey`, `compactAll()` still finds the thread of every stored session, while any other custom `threadKey` leaves stored sessions to it and the gateway keeps no conversations. With `cogitator up`, set `session.queueMode: parallel` and `session.threadKey: legacy` in `cogitator.yml`.

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/channels@0.16.0
  - @cogitator-ai/types@0.65.0
  - create-cogitator-app@0.9.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/config@0.24.3
  - @cogitator-ai/deploy@0.6.29
  - @cogitator-ai/mcp@19.5.23
  - @cogitator-ai/memory@0.25.1
  - @cogitator-ai/studio@0.3.15

## 0.8.26

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/memory@0.25.0
  - @cogitator-ai/channels@0.15.12
  - @cogitator-ai/mcp@19.5.22
  - @cogitator-ai/studio@0.3.14
  - @cogitator-ai/config@0.24.2
  - @cogitator-ai/deploy@0.6.28

## 0.8.25

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/channels@0.15.11
  - @cogitator-ai/mcp@19.5.21
  - @cogitator-ai/studio@0.3.13
  - @cogitator-ai/config@0.24.1
  - @cogitator-ai/deploy@0.6.27
  - @cogitator-ai/memory@0.24.5

## 0.8.24

### Patch Changes

- Updated dependencies [[`d936a95`](https://github.com/cogitator-ai/Cogitator-AI/commit/d936a952fb233dcb22b961d421ac42ce03841d29)]:
  - @cogitator-ai/channels@0.15.10

## 0.8.23

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/config@0.24.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/channels@0.15.9
  - @cogitator-ai/deploy@0.6.26
  - @cogitator-ai/mcp@19.5.20
  - @cogitator-ai/memory@0.24.4
  - @cogitator-ai/studio@0.3.12
  - create-cogitator-app@0.8.13

## 0.8.22

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/memory@0.24.3
  - @cogitator-ai/channels@0.15.8
  - @cogitator-ai/core@0.56.4
  - @cogitator-ai/studio@0.3.11
  - @cogitator-ai/mcp@19.5.19

## 0.8.21

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/channels@0.15.7
  - @cogitator-ai/config@0.23.4
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/deploy@0.6.25
  - @cogitator-ai/mcp@19.5.18
  - @cogitator-ai/memory@0.24.2
  - @cogitator-ai/studio@0.3.10

## 0.8.20

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/studio@0.3.9
  - @cogitator-ai/channels@0.15.6
  - @cogitator-ai/config@0.23.3
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/deploy@0.6.24
  - @cogitator-ai/mcp@19.5.17
  - @cogitator-ai/memory@0.24.1

## 0.8.19

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/memory@0.24.0
  - @cogitator-ai/channels@0.15.5
  - @cogitator-ai/config@0.23.2
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/deploy@0.6.23
  - @cogitator-ai/mcp@19.5.16
  - @cogitator-ai/studio@0.3.8

## 0.8.18

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/memory@0.23.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/channels@0.15.4
  - @cogitator-ai/config@0.23.1
  - @cogitator-ai/deploy@0.6.22
  - @cogitator-ai/mcp@19.5.15
  - @cogitator-ai/studio@0.3.7

## 0.8.17

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/memory@0.22.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/config@0.23.0
  - @cogitator-ai/channels@0.15.3
  - @cogitator-ai/deploy@0.6.21
  - @cogitator-ai/mcp@19.5.14
  - @cogitator-ai/studio@0.3.6
  - create-cogitator-app@0.8.12

## 0.8.16

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/memory@0.21.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/config@0.22.0
  - @cogitator-ai/channels@0.15.2
  - @cogitator-ai/deploy@0.6.20
  - @cogitator-ai/mcp@19.5.13
  - @cogitator-ai/studio@0.3.5
  - create-cogitator-app@0.8.11

## 0.8.15

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/memory@0.20.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/config@0.21.0
  - @cogitator-ai/channels@0.15.1
  - @cogitator-ai/deploy@0.6.19
  - @cogitator-ai/mcp@19.5.12
  - @cogitator-ai/studio@0.3.4
  - create-cogitator-app@0.8.10

## 0.8.14

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/memory@0.19.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/config@0.20.0
  - @cogitator-ai/channels@0.15.0
  - @cogitator-ai/deploy@0.6.18
  - @cogitator-ai/mcp@19.5.11
  - @cogitator-ai/studio@0.3.3
  - create-cogitator-app@0.8.9

## 0.8.13

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/memory@0.18.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/channels@0.14.0
  - @cogitator-ai/config@0.19.0
  - @cogitator-ai/deploy@0.6.17
  - @cogitator-ai/mcp@19.5.10
  - @cogitator-ai/studio@0.3.2
  - create-cogitator-app@0.8.8

## 0.8.12

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/memory@0.17.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/channels@0.13.0
  - @cogitator-ai/config@0.18.0
  - @cogitator-ai/deploy@0.6.16
  - @cogitator-ai/mcp@19.5.9
  - @cogitator-ai/studio@0.3.1
  - create-cogitator-app@0.8.7

## 0.8.11

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/memory@0.16.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/studio@0.3.0
  - @cogitator-ai/channels@0.12.7
  - @cogitator-ai/config@0.17.6
  - @cogitator-ai/deploy@0.6.15
  - @cogitator-ai/mcp@19.5.8

## 0.8.10

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/memory@0.15.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/channels@0.12.6
  - @cogitator-ai/config@0.17.5
  - @cogitator-ai/deploy@0.6.14
  - @cogitator-ai/mcp@19.5.7
  - @cogitator-ai/studio@0.2.2

## 0.8.9

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/memory@0.14.0
  - @cogitator-ai/core@0.47.0
  - create-cogitator-app@0.8.6
  - @cogitator-ai/channels@0.12.5
  - @cogitator-ai/config@0.17.4
  - @cogitator-ai/deploy@0.6.13
  - @cogitator-ai/mcp@19.5.6
  - @cogitator-ai/studio@0.2.1

## 0.8.8

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/studio@0.2.0
  - @cogitator-ai/channels@0.12.4
  - @cogitator-ai/mcp@19.5.5
  - @cogitator-ai/config@0.17.3
  - @cogitator-ai/deploy@0.6.12
  - @cogitator-ai/memory@0.13.3

## 0.8.7

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/channels@0.12.3
  - @cogitator-ai/mcp@19.5.4
  - @cogitator-ai/studio@0.1.12
  - @cogitator-ai/config@0.17.2
  - @cogitator-ai/deploy@0.6.11
  - @cogitator-ai/memory@0.13.2

## 0.8.6

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/channels@0.12.2
  - @cogitator-ai/mcp@19.5.3
  - @cogitator-ai/studio@0.1.11
  - @cogitator-ai/config@0.17.1
  - @cogitator-ai/deploy@0.6.10
  - @cogitator-ai/memory@0.13.1

## 0.8.5

### Patch Changes

- Updated dependencies [[`f903fc1`](https://github.com/cogitator-ai/Cogitator-AI/commit/f903fc15fca7e29f5187f1fc60e099a8a9b28a03), [`f903fc1`](https://github.com/cogitator-ai/Cogitator-AI/commit/f903fc15fca7e29f5187f1fc60e099a8a9b28a03)]:
  - @cogitator-ai/mcp@19.5.2
  - create-cogitator-app@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/memory@0.13.0
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/config@0.17.0
  - @cogitator-ai/channels@0.12.1
  - @cogitator-ai/studio@0.1.10
  - @cogitator-ai/mcp@19.5.1
  - @cogitator-ai/deploy@0.6.9
  - create-cogitator-app@0.8.4

## 0.8.3

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22), [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22), [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/channels@0.12.0
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/mcp@19.5.0
  - create-cogitator-app@0.8.3
  - @cogitator-ai/config@0.16.1
  - @cogitator-ai/deploy@0.6.8
  - @cogitator-ai/memory@0.12.9
  - @cogitator-ai/studio@0.1.9

## 0.8.2

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/mcp@19.4.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/config@0.16.0
  - create-cogitator-app@0.8.2
  - @cogitator-ai/channels@0.11.4
  - @cogitator-ai/studio@0.1.8
  - @cogitator-ai/deploy@0.6.7
  - @cogitator-ai/memory@0.12.8

## 0.8.1

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/config@0.15.0
  - @cogitator-ai/models@18.5.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/channels@0.11.3
  - @cogitator-ai/deploy@0.6.6
  - @cogitator-ai/mcp@19.3.7
  - @cogitator-ai/memory@0.12.7
  - @cogitator-ai/studio@0.1.7
  - create-cogitator-app@0.8.1

## 0.8.0

### Minor Changes

- [#201](https://github.com/cogitator-ai/Cogitator-AI/pull/201) [`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f) - The scaffolder offers to start the project's compose services once the project is created. When the stack has Postgres, Redis, MongoDB, Qdrant, Jaeger or the Ollama container and Docker is running, it asks whether to run `docker compose up --wait` and waits until they are healthy, so the first `dev` finds its database. The Ollama container pulls the model in the background, and the next steps point at `docker compose logs -f ollama-pull` instead of `ollama pull`. An Ollama that already answers at `OLLAMA_BASE_URL` is left alone and the compose one is not started, since it could not take the port. Nothing starts with `--yes`, `--json`, without a TTY, in CI or in a dry run. `cogitator init` makes the same offer and leaves the compose Postgres out when you give a database URL of your own.

  `startServices`, `dockerComposeAvailable`, `servicesToStart`, `offerServices` and `isInteractive` are exported. `offerServices` asks at the terminal, so programmatic callers check `isInteractive` first. `ProjectPlan.oneShotServices` names the services that run a task and exit.

  `resolveOllamaUrl` now answers with the Ollama the generated project talks to: `OLLAMA_BASE_URL`, which its `cogitator.yml` reads, else `http://localhost:11434`. It no longer reads `OLLAMA_HOST`, the address the Ollama server listens on, which the project ignores. With the common `OLLAMA_HOST=0.0.0.0` the scaffolder used to look for Ollama on port 80 and report a running one as missing.

### Patch Changes

- [#201](https://github.com/cogitator-ai/Cogitator-AI/pull/201) [`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f) - Projects created for Yarn 2 and later work out of the box, from create-cogitator-app, `--example` and `cogitator init` alike. They get a `.yarnrc.yml` with `nodeLinker: node-modules`, because tsx, vitest and Cogitator Studio could not find their packages under Plug'n'Play, Yarn's default, and the `.gitignore` entries Yarn recommends for `.yarn/`. Projects pinned to Yarn 1 get no `.yarnrc.yml`, Yarn 1 never reads it. Generated projects also declare `vite`, which vitest needs as a peer and which Yarn, unlike npm, pnpm and Bun, does not install by itself, so `yarn test` failed. The first install no longer fails under CI with Yarn 4, which refused to write the lockfile there (`YN0028`).

  To fix a Yarn project created earlier, add a `.yarnrc.yml` with `nodeLinker: node-modules`, run `yarn add -D vite` and install again.

- Updated dependencies [[`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f), [`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f)]:
  - create-cogitator-app@0.8.0

## 0.7.4

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - `cogitator build` bundles with its own esbuild, now a dependency of the CLI. It used to look for esbuild in the project and found it only when the package manager happened to hoist the copy that tsx brings along, so with pnpm's `hoist: false`, a globally installed CLI or a project without tsx it stopped with "esbuild is required". Projects can drop the `esbuild` dev dependency they added for it.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/channels@0.11.2
  - @cogitator-ai/config@0.14.2
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/deploy@0.6.5
  - @cogitator-ai/mcp@19.3.6
  - @cogitator-ai/memory@0.12.6
  - @cogitator-ai/models@18.4.1
  - @cogitator-ai/studio@0.1.6
  - @cogitator-ai/types@0.41.1
  - create-cogitator-app@0.7.1

## 0.7.3

### Patch Changes

- Updated dependencies [[`6481bdf`](https://github.com/cogitator-ai/Cogitator-AI/commit/6481bdfc871d20fe3633392ce0ea2f0fd0e17052)]:
  - @cogitator-ai/channels@0.11.1

## 0.7.2

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/channels@0.11.0
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/config@0.14.1
  - @cogitator-ai/deploy@0.6.4
  - @cogitator-ai/mcp@19.3.5
  - @cogitator-ai/memory@0.12.5
  - @cogitator-ai/studio@0.1.5

## 0.7.1

### Patch Changes

- Updated dependencies [[`d7f5fcf`](https://github.com/cogitator-ai/Cogitator-AI/commit/d7f5fcf044784ac278a12772ae1cd0acea708cea)]:
  - @cogitator-ai/channels@0.10.1

## 0.7.0

### Minor Changes

- [#155](https://github.com/cogitator-ai/Cogitator-AI/pull/155) [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292) - Bluesky and Threads channels in the scaffolder, `cogitator init` and `cogitator wizard`. A generated project keeps the Bluesky session and the Threads token in `.cogitator/tokens.json`, which is ignored by git, and `cogitator wizard --edit` keeps their settings.

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/models@18.4.0
  - @cogitator-ai/config@0.14.0
  - @cogitator-ai/studio@0.1.4
  - @cogitator-ai/channels@0.10.0
  - create-cogitator-app@0.7.0
  - @cogitator-ai/mcp@19.3.4
  - @cogitator-ai/deploy@0.6.3
  - @cogitator-ai/memory@0.12.4

## 0.6.5

### Patch Changes

- Updated dependencies [[`60e8e89`](https://github.com/cogitator-ai/Cogitator-AI/commit/60e8e8930d7d7645bbf8dfe7a6ebf20da9d004ea)]:
  - @cogitator-ai/studio@0.1.3

## 0.6.4

### Patch Changes

- [#151](https://github.com/cogitator-ai/Cogitator-AI/pull/151) [`90a5055`](https://github.com/cogitator-ai/Cogitator-AI/commit/90a50551e802a308655b46ad50547856f1e420cd) - The install runs with the package manager that launched the scaffolder, from the `npm_execpath` it sets, and falls back to the one on PATH. A pnpm started by its full path or as a standalone binary, which is not on PATH, failed the install with "pnpm is not installed". `cogitator add` installs the same way.
- Updated dependencies [[`90a5055`](https://github.com/cogitator-ai/Cogitator-AI/commit/90a50551e802a308655b46ad50547856f1e420cd), [`6ff6a3f`](https://github.com/cogitator-ai/Cogitator-AI/commit/6ff6a3f8a2b6a617bc04007ff46908e30c81cc2f), [`398426b`](https://github.com/cogitator-ai/Cogitator-AI/commit/398426b3fb620937e94535c3a66e18b1fb330b38)]:
  - create-cogitator-app@0.6.1

## 0.6.3

### Patch Changes

- [#150](https://github.com/cogitator-ai/Cogitator-AI/pull/150) [`73237de`](https://github.com/cogitator-ai/Cogitator-AI/commit/73237de96e86412051697491c8109a5887eb564a) - The telemetry event of a failed scaffold says where and why it failed. `failedStep` is `create` (the options, the directory, downloading or writing files) or `install`, and `errorCode` is the code it failed with: the package manager's own from a closed set of known codes (`ERR_PNPM_NO_MATCHING_VERSION`, npm's `ETARGET`, Yarn's `YN0035`, a code for the messages of Bun and Yarn 1, `ERR_PNPM_OTHER` or `NPM_OTHER` for any other, since install scripts print into the same output), a Node network or file system code (`ENOTFOUND`), or the scaffolder's (`DIRECTORY_NOT_EMPTY`, `HTTP_404`). Both are `none` on success. The event never holds the error message or the install output, which can contain paths and package names.

  An `--example` or `--template` whose install failed was counted as a success. It is a failure now, like a generated project.

  In the library, `payloadFor(spec, failure?, kind)` takes a `ScaffoldFailure` (`{ step, error }`) in place of the outcome, and `installFailure(result)` gives the one of a scaffold whose install failed. `telemetryErrorCode`, `installErrorCode` and `CodedError`, the error with a code the scaffolder throws, are exported too.

- Updated dependencies [[`73237de`](https://github.com/cogitator-ai/Cogitator-AI/commit/73237de96e86412051697491c8109a5887eb564a)]:
  - create-cogitator-app@0.6.0

## 0.6.2

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/config@0.13.0
  - @cogitator-ai/channels@0.9.3
  - @cogitator-ai/mcp@19.3.3
  - @cogitator-ai/studio@0.1.2
  - @cogitator-ai/deploy@0.6.2
  - @cogitator-ai/memory@0.12.3

## 0.6.1

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/config@0.12.2
  - @cogitator-ai/channels@0.9.2
  - @cogitator-ai/mcp@19.3.2
  - @cogitator-ai/studio@0.1.1
  - @cogitator-ai/deploy@0.6.1
  - @cogitator-ai/memory@0.12.2

## 0.6.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - New commands: `cogitator add` grows a scaffolded project with rag, mcp, workflows, evals, memory, deploy and the rest, merging into files you changed and refusing with a diff when it cannot; `cogitator dev` opens Cogitator Studio; `cogitator mcp` serves the bundled docs and the project's registry to Claude Code, Cursor and Codex; `cogitator doctor` checks that a project can run; `cogitator eval` runs eval suites for CI. `cogitator init` generates the `channels` preset of create-cogitator-app. Every command now exits `0`, `1` or `2` (wrong command line), reports failures with hints on stderr (stack traces with `COGITATOR_DEBUG`), prints JSON with `--json` (now also on `models`, `status` and `deploy`), and ends its help with examples.

  `cogitator mcp --project <path>` serves another project, and `cogitator add` installs when an addition removes dependencies too, so the lockfile follows package.json. `cogitator doctor` finds packages installed with Yarn Plug'n'Play and packages hoisted to a parent node_modules.

  **Breaking:**

  - Errors and warnings go to stderr, and a wrong command line (unknown option, missing argument, invalid value) exits with `2` instead of `1`. Scripts that read errors from stdout or check for `1` need to follow.
  - `cogitator init` generates a different project: the agent moves from `src/agent.ts` to `src/agents/assistant.ts` and the registry `src/cogitator.ts`, and `src/index.ts` starts the gateway for `dev` and `start`. `src/gateway.ts` still exports `gateway`, so `cogitator assistant`, `build` and `daemon` work as before. Existing projects are not touched.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/deploy@0.6.0
  - create-cogitator-app@0.5.0
  - @cogitator-ai/memory@0.12.1
  - @cogitator-ai/channels@0.9.1
  - @cogitator-ai/studio@0.1.0
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/mcp@19.3.1
  - @cogitator-ai/config@0.12.1

## 0.5.20

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Projects from `cogitator init` deploy as they are. `init` writes a runtime `cogitator.yml` with the provider, model and memory, and a `deploy` section that runs the gateway as a worker, publishes the WebChat port and lists the API key and channel tokens as secrets, so `cogitator deploy` no longer ships a container without them that restarts forever. The SQLite memory directory is created at start (the first `pnpm dev` failed without it) and lives on a volume when deployed, and `package.json` pins the pnpm, Yarn or Bun version that ran `init` in `packageManager`.

  `cogitator deploy -c <file>` reads the model, memory and deploy section from that file instead of mixing it with the default one, finds `.cogitator.yml` like `loadConfig` does, and shows the project kind, volumes and which services Fly does not provision.

  `cogitator run` loads the `.env` next to the config file, and with an assistant config from `cogitator wizard` runs its `llm.provider` and `llm.model` instead of silently falling back to a local Ollama model.

  `cogitator build` bundles only the project's own code and leaves every package to `node_modules`, so a project with the Docker sandbox (whose `ssh2` dependency ships a native addon) or optional media dependencies builds again.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `CompactionConfig.threshold` means tokens everywhere. The Gateway compared it with the number of messages while `CompactionService` compared it with tokens, so `threshold: 8000` from the memory docs waited for 8000 messages in a channel. The new `messageThreshold` counts messages, and a thread is compacted once either limit is reached (`threshold` is now optional, at least one is required). Gateway configs that meant messages should switch to `messageThreshold`. The `memory.compaction.threshold` of an assistant YAML config still counts messages, and `cogitator init` generates `messageThreshold`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `OLLAMA_HOST`, `OLLAMA_URL` and the new `OLLAMA_BASE_URL` are read the way Ollama reads `OLLAMA_HOST`. `OLLAMA_HOST=0.0.0.0`, set so `ollama serve` listens on every interface, used to send every call to port 80 and fail with `ECONNREFUSED`. Now a value without a scheme gets port 11434 and a wildcard address is reached as `localhost`, in `loadConfig` and in the CLI alike (`resolveOllamaHost()`). These variables also no longer replace an explicit `llm.providers.ollama.baseUrl` from cogitator.yml, they apply only when the file sets none (`loadEnvDefaults()`), while `COGITATOR_OLLAMA_BASE_URL` still overrides it. `loadEnvConfig()` therefore no longer returns them.

  `loadConfig` looks for `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml` and `.cogitator.yaml` in that order, the same order `cogitator run` and `cogitator deploy` use (`findConfigFile()`).

- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/models@18.3.0
  - @cogitator-ai/config@0.12.0
  - @cogitator-ai/channels@0.9.0
  - @cogitator-ai/memory@0.12.0
  - @cogitator-ai/deploy@0.5.0

## 0.5.19

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/channels@0.8.6
  - @cogitator-ai/config@0.11.8
  - @cogitator-ai/deploy@0.4.8
  - @cogitator-ai/memory@0.11.8

## 0.5.18

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0
  - @cogitator-ai/channels@0.8.5
  - @cogitator-ai/config@0.11.7
  - @cogitator-ai/deploy@0.4.7
  - @cogitator-ai/memory@0.11.7

## 0.5.17

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/channels@0.8.4
  - @cogitator-ai/config@0.11.6
  - @cogitator-ai/deploy@0.4.6
  - @cogitator-ai/memory@0.11.6

## 0.5.16

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4
  - @cogitator-ai/channels@0.8.3

## 0.5.15

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3
  - @cogitator-ai/channels@0.8.2

## 0.5.14

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/channels@0.8.1
  - @cogitator-ai/config@0.11.5
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/deploy@0.4.5
  - @cogitator-ai/memory@0.11.5
  - @cogitator-ai/models@18.2.1
  - @cogitator-ai/types@0.33.1

## 0.5.13

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/channels@0.8.0
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/config@0.11.4
  - @cogitator-ai/core@0.30.1
  - @cogitator-ai/deploy@0.4.4
  - @cogitator-ai/memory@0.11.4

## 0.5.12

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/channels@0.7.6
  - @cogitator-ai/config@0.11.3
  - @cogitator-ai/deploy@0.4.3
  - @cogitator-ai/memory@0.11.3

## 0.5.11

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0
  - @cogitator-ai/channels@0.7.5

## 0.5.10

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/config@0.11.2
  - @cogitator-ai/deploy@0.4.2
  - @cogitator-ai/memory@0.11.2
  - @cogitator-ai/types@0.31.0
  - @cogitator-ai/channels@0.7.4

## 0.5.9

### Patch Changes

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`26745cd`](https://github.com/cogitator-ai/Cogitator-AI/commit/26745cdeb375bd6193e782b4a6f72d649da1e1d9), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7), [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6), [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36), [`5caa2aa`](https://github.com/cogitator-ai/Cogitator-AI/commit/5caa2aa17e737fb7c5fcd56f3acab57744af7217), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/deploy@0.4.1
  - @cogitator-ai/memory@0.11.1
  - @cogitator-ai/models@18.2.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/channels@0.7.3
  - @cogitator-ai/config@0.11.1

## 0.5.8

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2
  - @cogitator-ai/channels@0.7.2

## 0.5.7

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1
  - @cogitator-ai/channels@0.7.1

## 0.5.6

### Patch Changes

- d626dfb: Fix `cogitator up` and `cogitator wizard --edit`:

  - `up` loads `.env` into `process.env` (without overriding variables already set), so tools that read it, such as `web_search` and `github_api`, see keys written by the wizard.
  - `up` supervises the assistant for restarts even without `selfConfig`, so the owner `/restart` command (exit code 78) restarts it instead of stopping it.
  - `wizard --edit` keeps a postgres memory config and the WhatsApp/WebChat channels instead of overwriting them.

- cee7c73: The `cogitator up` startup summary listed every configured channel, including ones skipped because their token (e.g. `WEBCHAT_TOKEN`) is missing. It now lists the channels the gateway actually runs, and warns when none are running.
- cee7c73: `cogitator up` treated every `./cogitator.yml` as an assistant config, so in a project from create-cogitator-app (whose `cogitator.yml` is an `@cogitator-ai/config` runtime config) it failed with assistant validation errors. A runtime config is now recognised: `up` starts the project's Docker Compose services, or explains what the file is when there are none, and `cogitator daemon` no longer picks it as the entry to run.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8963e1e]
- Updated dependencies [1df914a]
- Updated dependencies [f43f6af]
- Updated dependencies [8d520c0]
- Updated dependencies [a3c2ee1]
- Updated dependencies [8bcf914]
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
- Updated dependencies [e7925d5]
- Updated dependencies [b8c9eca]
- Updated dependencies [0736823]
- Updated dependencies [7d6952d]
- Updated dependencies [0736823]
- Updated dependencies [0736823]
- Updated dependencies [bb17767]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [e7925d5]
- Updated dependencies [d35ef2a]
- Updated dependencies [4a2925f]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/channels@0.7.0
  - @cogitator-ai/memory@0.11.0
  - @cogitator-ai/config@0.11.0
  - @cogitator-ai/deploy@0.4.0

## 0.5.5

### Patch Changes

- Updated dependencies [e211b6a]
- Updated dependencies [333e4ad]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [1368ff8]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [e561607]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/memory@0.10.0
  - @cogitator-ai/types@0.28.0
  - @cogitator-ai/channels@0.6.1
  - @cogitator-ai/config@0.10.1
  - @cogitator-ai/deploy@0.3.4

## 0.5.4

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/models@18.1.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/config@0.10.0
  - @cogitator-ai/channels@0.6.0
  - @cogitator-ai/deploy@0.3.3
  - @cogitator-ai/memory@0.9.1

## 0.5.3

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0
  - @cogitator-ai/config@0.9.0
  - @cogitator-ai/memory@0.9.0
  - @cogitator-ai/channels@0.5.1
  - @cogitator-ai/deploy@0.3.2

## 0.5.2

### Patch Changes

- 9eae101: Slack: answer @mentions in channels. The adapter only listened to `message` events, so a mention delivered as `app_mention` (the documented subscription) was dropped. Mentions are now handled, the `<@bot>` token is stripped from the text, a message that arrives both as `message` and `app_mention` is handled once, and the new `mentionOnly` option ignores channel messages that do not mention the bot. `RuntimeBuilder` now passes `SLACK_APP_TOKEN` (Socket Mode) and `SLACK_PORT`, and warns when Slack falls back to HTTP mode; `cogitator wizard` and `cogitator init` ask for the app token.
- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [9eae101]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/config@0.8.0
  - @cogitator-ai/channels@0.5.0
  - @cogitator-ai/deploy@0.3.1
  - @cogitator-ai/memory@0.8.1

## 0.5.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1
  - @cogitator-ai/channels@0.4.1

## 0.5.0

### Minor Changes

- `cogitator init` writes a `pnpm-workspace.yaml` that allows the native builds pnpm 10.26+/11 would otherwise refuse; generated projects require Node 22.12+ and `build` targets node22.
- Prompts (clack 1): pressing Enter on an empty field no longer saves the grey placeholder as the value. Extra positional arguments are now an error instead of being silently dropped (commander 15).
- Current model lists and Ollama defaults (`qwen3:8b`).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/channels@0.4.0
  - @cogitator-ai/config@0.7.0
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/deploy@0.3.0
  - @cogitator-ai/memory@0.8.0
  - @cogitator-ai/models@18.0.0
  - @cogitator-ai/types@0.24.0

## 0.4.0

### Minor Changes

- Several CLI flows did not work and are now fixed. init pinned @cogitator-ai/\* to ^0.1.0 (which resolves to 0.1.x), ignored the memory choice, never loaded .env, and suggested a `cogitator up` that fails. The daemon ran `node src/gateway.ts`, which never started anything; piped its logs through the exiting parent; could SIGKILL an unrelated process when a PID was reused; and installed a systemd unit with WantedBy=multi-user.target, which never starts in the user manager. build produced a bundle that did not start the gateway. up started HeartbeatScheduler twice (duplicate reminders) and did not forward SIGTERM to the restart child. models --pull reported Ollama errors as success and dropped NDJSON lines split across chunks. run ignored -c precedence and llm.defaultModel. skill create/remove allowed path traversal, so remove could rm -rf outside the skills dir. wizard --edit lost .env comments, MCP servers and other settings. Removed @ts-expect-error in favour of a type-guarded optional module loader. Removed the assistant 'pause' hotkey, which did nothing. All shell-string docker/launchctl calls now go through execFile. README, docs page, wizard docs and examples were rewritten.

  **Breaking changes**
  - `run`: an explicit -c now wins over COGITATOR_CONFIG, and a missing explicit or env config file is an error instead of a silent fallback.
  - `daemon start/restart/install`: -c no longer defaults to src/gateway.ts. The entry is auto-detected (dist/cogitator.mjs, then cogitator.yml, then src/gateway.ts). The PID file is now JSON (legacy plain PIDs are still read).
  - `daemon logs --json` was removed (it did nothing).
  - The `assistant` 'p' (pause) hotkey was removed (it did nothing).
  - `skill create` requires kebab-case names. Generated tool names are snake_case.
  - `up` without cogitator.yml and with no Docker running exits with 'No cogitator.yml or docker-compose.yml found' as before. `up` gained -c/--config, and --no-restart-loop is now a documented option.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/channels@0.3.0
  - @cogitator-ai/config@0.6.0
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/deploy@0.2.0
  - @cogitator-ai/memory@0.7.0
  - @cogitator-ai/types@0.23.0

## 0.3.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/memory@0.6.22
  - @cogitator-ai/types@0.22.3
  - @cogitator-ai/channels@0.2.5
  - @cogitator-ai/config@0.5.6
  - @cogitator-ai/deploy@0.1.9

## 0.3.15

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/channels@0.2.4
  - @cogitator-ai/config@0.5.5
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/deploy@0.1.8
  - @cogitator-ai/memory@0.6.21

## 0.3.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/deploy@0.1.7

## 0.3.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/channels@0.2.3
  - @cogitator-ai/config@0.5.4
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/models@17.1.8
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/deploy@0.1.6
  - @cogitator-ai/memory@0.6.20

## 0.3.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/channels@0.2.2
  - @cogitator-ai/config@0.5.3
  - @cogitator-ai/deploy@0.1.5
  - @cogitator-ai/memory@0.6.19

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.3.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5
  - @cogitator-ai/config@0.5.2
  - @cogitator-ai/deploy@0.1.4

## 0.3.7

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.3.6

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.3.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
  - @cogitator-ai/config@0.5.1
  - @cogitator-ai/deploy@0.1.3

## 0.3.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/deploy@0.1.2

## 0.3.3

### Patch Changes

- fix(cli): exclude test files from compiled dist

## 0.3.2

### Patch Changes

- fix(cli): audit — 5 bugs & improvements
  - Fix: `loadConfig()` in `run.ts` now passes `configPath` for YAML config files (was ignoring user config)
  - Fix: `printBanner()` reads version from package.json dynamically (was hardcoded as v0.1.0)
  - Refactor: extract shared `findDockerCompose()` and `checkDocker()` to `utils/docker.ts`
  - Fix: parent dir traversal in `findDockerCompose()` now checks both `.yml` and `.yaml`
  - Add `vitest.config.ts` to restrict test discovery to `src/` only
  - Add 22 new unit tests covering `docker.ts`, `models.ts`, and `run.ts` utilities

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.3.0

### Minor Changes

- Add one-command deployment engine (`cogitator deploy`)
  - New deploy types: `DeployTarget`, `DeployConfig`, `DeployResult`, `DeployPlan`
  - Deploy section in `cogitator.yml` schema with target, port, region, instances, registry, services, secrets
  - CLI `deploy` command with `--target`, `--dry-run`, `--push`, `status`, and `destroy` subcommands

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/config@0.4.0
  - @cogitator-ai/deploy@0.1.1

## 0.2.25

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/config@0.3.13

## 0.2.24

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/config@0.3.12

## 0.2.23

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2

## 0.2.22

### Patch Changes

- @cogitator-ai/config@0.3.11
- @cogitator-ai/core@0.17.1

## 0.2.21

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/config@0.3.10

## 0.2.20

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/config@0.3.9

## 0.2.19

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/config@0.3.8

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/config@0.3.7

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/config@0.3.6

## 0.2.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/config@0.3.5

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/config@0.3.4
  - @cogitator-ai/core@0.11.5

## 0.2.14

### Patch Changes

- @cogitator-ai/config@0.3.3
- @cogitator-ai/core@0.11.4

## 0.2.13

### Patch Changes

- @cogitator-ai/config@0.3.2
- @cogitator-ai/core@0.11.3

## 0.2.12

### Patch Changes

- @cogitator-ai/config@0.3.1
- @cogitator-ai/core@0.11.2

## 0.2.11

### Patch Changes

- @cogitator-ai/core@0.11.1

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0
  - @cogitator-ai/config@0.3.0

## 0.2.9

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/config@0.2.8

## 0.2.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.9.0
  - @cogitator-ai/config@0.2.7

## 0.2.7

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/config@0.2.6

## 0.2.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/config@0.2.5

## 0.2.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/config@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/config@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/config@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.3.0
  - @cogitator-ai/config@0.2.1

## 0.2.0

### Features

- **New command: `cogitator status`** - Show status of Docker services and Ollama
- **New command: `cogitator logs`** - View Docker service logs with follow mode
- **New command: `cogitator models`** - List and pull Ollama models
- **Environment variables**: `COGITATOR_MODEL` and `COGITATOR_CONFIG` support
- **Interactive mode improvements**:
  - `/model <name>` - Switch models mid-conversation
  - `/clear` - Reset conversation history
  - `/help` - Show available commands
  - Message counter in prompt

### Fixes

- Version now reads from package.json instead of hardcoded value
- Config loading errors are now logged as warnings instead of silently ignored

## 0.1.1

### Patch Changes

- @cogitator-ai/config@0.1.1
- @cogitator-ai/core@0.1.1

## 0.1.0

### Initial Release

- `cogitator init <name>` - Create new project with Docker setup
- `cogitator up` - Start Docker services (Redis, PostgreSQL, Ollama)
- `cogitator down` - Stop Docker services
- `cogitator run [message]` - Run agent with streaming support
