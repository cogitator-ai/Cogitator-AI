# @cogitator-ai/studio

## 0.10.1

### Patch Changes

- Updated dependencies [[`4483b63`](https://github.com/cogitator-ai/Cogitator-AI/commit/4483b63469c0c43b3a5f496186f56be0e512edfa), [`4483b63`](https://github.com/cogitator-ai/Cogitator-AI/commit/4483b63469c0c43b3a5f496186f56be0e512edfa)]:
  - @cogitator-ai/core@0.78.1
  - @cogitator-ai/models@18.6.0
  - @cogitator-ai/swarms@0.15.12
  - @cogitator-ai/workflows@0.15.6

## 0.10.0

### Minor Changes

- [#319](https://github.com/cogitator-ai/Cogitator-AI/pull/319) [`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c) - MCP Apps (extension `io.modelcontextprotocol/ui`): tools come with interactive `ui://` pages, our MCP server serves them, the client reads them, and Studio renders them.

  Server:

  - A tool's new `app` field names its MCP App. `mcpApp({ uri, html, csp?, permissions?, domain?, prefersBorder?, visibility? })` builds one for a tool this process serves, and an `MCPServer` that serves the tool lists it with `_meta.ui.resourceUri` (and the older flat `_meta['ui/resourceUri']`), serves the page as a resource of type `text/html;profile=mcp-app` with `_meta.ui` on the listing and the content, and declares the extension in its capabilities.
  - `server.registerApp(config)` serves an app on its own and `server.getRegisteredApps()` lists the URIs served. `serveAgents` takes `apps`, an app per agent, for the agent's tool.
  - A tool with `visibility: ['app']` is for its page only.

  Client:

  - `MCPClient` tells servers it takes apps (`apps: false` turns it off). A wrapped tool of a server that points at an app carries it as `tool.app`: `read()` gives the page with its CSP, permissions, domain and border preference, `callTool(name, args)` calls a tool of the same server for the page (only a tool open to apps, a structured result that is no object coming as `{ result: value }`), `requiresApproval(name)` says whether that tool needs approval, under the `requiresApproval` setting of `getTools()` (destructive tools by default).
  - A wrapped tool whose server answers with images, audio or binary resources next to `structuredContent` keeps the structured result in the call's `details` (`ToolStructuredDetails`), out of what the model reads, so the tool's app gets both. `callTool(name, args, { structuredDetails: true })` does the same by hand, `callTool` without it returns what it did.
  - `getTools()` leaves out the tools a server opens to apps only, as MCP Apps asks of a host. `getToolApp(name)`, `readApp(uri)` and `callToolForApp(name, args)` do the same by hand.
  - `@modelcontextprotocol/ext-apps` 2.0.4 is a new dependency of `@cogitator-ai/mcp`.

  Studio:

  - A tool call whose tool has an app shows the app under it, in the chat and on the run page. The studio serves the page from its own address, sandboxed with `allow-scripts` only so it runs with an opaque origin, and with a Content-Security-Policy built from the origins the app declares and a Permissions-Policy that grants the features it asked for and nothing else.
  - The studio is the app's host through the ext-apps `AppBridge`: it sends the call's arguments and result (or that it failed), sizes the frame and opens web links in a new tab. Tool calls the app makes go to its server, held to the agent's permission rules, hooks and guardrails like a call of the agent: a denied one answers the app with an error, and one a rule asks for or that needs approval (destructive, or as the adapter's `requiresApproval` says) waits for the person to press **Allow** in the card.
  - New routes: `GET /api/agents/:agent/tools/:tool/app`, `GET .../app/view` and `POST .../app/call`.
  - A web host is asked to put a sandbox proxy on an origin of its own between itself and the app. Studio gets the same isolation from the app's frame with an opaque origin and a header policy the page cannot change. A dedicated `domain` an app asks for is not honored.

### Patch Changes

- Updated dependencies [[`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c), [`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c)]:
  - @cogitator-ai/types@0.89.0
  - @cogitator-ai/core@0.78.0
  - @cogitator-ai/memory@0.29.7
  - @cogitator-ai/swarms@0.15.11
  - @cogitator-ai/workflows@0.15.5

## 0.9.4

### Patch Changes

- Updated dependencies [[`ac89cec`](https://github.com/cogitator-ai/Cogitator-AI/commit/ac89cec9ea8d288afd58f7dbbe1531f8425d757a)]:
  - @cogitator-ai/core@0.77.0
  - @cogitator-ai/types@0.88.0
  - @cogitator-ai/swarms@0.15.10
  - @cogitator-ai/workflows@0.15.4
  - @cogitator-ai/memory@0.29.6

## 0.9.3

### Patch Changes

- Updated dependencies [[`e2f1c87`](https://github.com/cogitator-ai/Cogitator-AI/commit/e2f1c8793df4d1fdb06e9d8a5d0e8be984cbd2d2)]:
  - @cogitator-ai/types@0.87.0
  - @cogitator-ai/core@0.76.0
  - @cogitator-ai/memory@0.29.5
  - @cogitator-ai/swarms@0.15.9
  - @cogitator-ai/workflows@0.15.3

## 0.9.2

### Patch Changes

- Updated dependencies [[`2bb4941`](https://github.com/cogitator-ai/Cogitator-AI/commit/2bb4941dc40889458575db0893766c233dabaaaf)]:
  - @cogitator-ai/core@0.75.0
  - @cogitator-ai/types@0.86.0
  - @cogitator-ai/swarms@0.15.8
  - @cogitator-ai/workflows@0.15.2
  - @cogitator-ai/memory@0.29.4

## 0.9.1

### Patch Changes

- Updated dependencies [[`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a)]:
  - @cogitator-ai/types@0.85.0
  - @cogitator-ai/core@0.74.0
  - @cogitator-ai/memory@0.29.3
  - @cogitator-ai/swarms@0.15.7
  - @cogitator-ai/workflows@0.15.1

## 0.9.0

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
  - @cogitator-ai/workflows@0.15.0
  - @cogitator-ai/memory@0.29.2
  - @cogitator-ai/swarms@0.15.6

## 0.8.0

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
  - @cogitator-ai/memory@0.29.1
  - @cogitator-ai/swarms@0.15.5
  - @cogitator-ai/workflows@0.14.24

## 0.7.0

### Minor Changes

- [#307](https://github.com/cogitator-ai/Cogitator-AI/pull/307) [`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6) - Rewind and fork threads from the memory tree. Every entry gets "Rewind here" and "Fork here" buttons: a rewind shows a dry run first (entries that leave the branch, stale memory items, runs that get dropped, and with "Restore files" the files written back and deleted), and a busy thread can be rewound by aborting its run. A fork opens a new thread that links back to its origin and shows the conversation it starts from. Rewound turns stay in the chat, faded, and are left out when a thread is replayed after a restart. User messages that name a file checkpoint are marked in the tree, and scripts get `POST /api/threads/:id/rewind` and `POST /api/threads/:id/fork`. A fork with "Restore files" previews its file restore first, and both answers carry the safety snapshot taken before files change. Threads of the studio's own memory are kept entry by entry (ids, metadata and file checkpoints included) after every chat, rewind and fork, so a restart replays exactly the branch a thread was on, with every branch of the thread (so entries forks were copied from stay after a rewind), its metadata and the threads a fork comes from, which its file rewinds need. A forced rewind leaves stopping runs to the runtime, which validates the rewind first.

### Patch Changes

- Updated dependencies [[`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6)]:
  - @cogitator-ai/types@0.82.0
  - @cogitator-ai/core@0.71.0
  - @cogitator-ai/memory@0.29.0
  - @cogitator-ai/swarms@0.15.4
  - @cogitator-ai/workflows@0.14.23

## 0.6.3

### Patch Changes

- Updated dependencies [[`cb4a7fa`](https://github.com/cogitator-ai/Cogitator-AI/commit/cb4a7fa20594805d6bf150f680185cc07520fec0)]:
  - @cogitator-ai/types@0.81.0
  - @cogitator-ai/core@0.70.0
  - @cogitator-ai/memory@0.28.0
  - @cogitator-ai/swarms@0.15.3
  - @cogitator-ai/workflows@0.14.22

## 0.6.2

### Patch Changes

- Updated dependencies [[`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4)]:
  - @cogitator-ai/types@0.80.0
  - @cogitator-ai/core@0.69.0
  - @cogitator-ai/memory@0.27.1
  - @cogitator-ai/swarms@0.15.2
  - @cogitator-ai/workflows@0.14.21

## 0.6.1

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/memory@0.27.0
  - @cogitator-ai/types@0.79.0
  - @cogitator-ai/core@0.68.1
  - @cogitator-ai/swarms@0.15.1
  - @cogitator-ai/workflows@0.14.20

## 0.6.0

### Minor Changes

- [#298](https://github.com/cogitator-ai/Cogitator-AI/pull/298) [`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130) - Subagents and commands from Markdown files in Claude Code's format, approvals of delegated runs that bubble up through nested checkpoints, background subagents, and agent teams in swarms with a live graph in Studio.

  Everything is off by default: without `subagents`, `commands` and the `team` strategy a run does what it did before, and `agentAsTool()` still declines the approvals of its inner agent.

  Breaking:

  - `ToolAccess.agent` may now be a function that reads the agent's name from the call's arguments (`agent: (params) => params.subagent_type`), so an `Agent(name)` rule matches a tool that delegates to the agent its call names. Code that reads `tool.access.agent` as a string checks `typeof agent === 'string'` first.
  - The Claude Code names `SendMessage`, `TaskOutput` and `TaskStop` used to match no tool. They now name the subagent tools `send_message`, `task_output` and `task_stop` (never other tools of those names, such as a swarm's), so a rule or hook matcher with one of them that matched nothing before matches these tools.
  - `ToolApprovalRequest` has `subagent`, the delegate a bubbled approval comes from, and its `toolCallId` is the qualified one (`<toolCallId>/<id>`) in the calling run's `onApproval` too.
  - An entry of a YAML `allowed-tools` list in a `SKILL.md` is split on white space and commas outside parentheses, as a string value always was: `- Read Grep` is two tools. `Bash(git status *)` stays one.
  - In swarms, a tool of `agentTools` named like a tool of the strategy gives way to the strategy's tool. Only the new team tools can collide.

  New:

  - `CogitatorConfig.subagents: { files?, agents?, approvalMode?, tools?, maxDepth?, maxBackground?, messages?, mcp?, onDelegationStart?, onDelegationComplete?, onDiagnostic? }`. Subagents come from Markdown files (`.agents/agents`, `.cogitator/agents`, `.claude/agents` of the project, read only once it is trusted as for hooks, the user's `~/.agents`, `~/.cogitator` and `~/.claude` folders, the managed directories, the host's `dirs`, folders read recursively) and from `agents` in code, shaped like Claude Code's `--agents` JSON. Precedence is managed, code, `dirs`, project, user. The frontmatter is read leniently with the skills' YAML parser, and its `hooks` run as hooks of the file's layer, so managed `disableAllHooks`, `allowManagedHooksOnly` and the HTTP allowlists hold for them: `name`, `description`, `tools`, `disallowedTools`, `model` (`inherit`, an alias of the new `llm.modelAliases`, or `provider/model`), `permissionMode` (`manual` is `default`, applied by Claude Code's rules but never wider than the delegating run's mode), `maxTurns` (the subagent's `maxIterations`), `skills` (preloaded in full), `mcpServers` (names of servers the run has, or inline ones connected through `subagents.mcp`), `hooks` (`Stop` runs as `SubagentStop`), `memory` (`user`, `project`, `local`: a notes folder at Claude Code's place with an `agent_memory` tool and `MEMORY.md` in the prompt), `background`, `isolation: worktree`, `color` and `effort`. A file without frontmatter or `name` is documentation, problems are diagnostics (`DefinitionDiagnostic`) logged once.
  - Runs get an `agent` tool with Claude Code's `Agent` input (`description`, `prompt`, `subagent_type`, `model`, `run_in_background`, `name`), or a tool per subagent with `tools: 'each'`, plus `send_message`, `task_output` and `task_stop`. `AgentConfig.subagents` (`false` or a list of names) limits which subagents an agent may use, and it is not carried by the agent wire. A subagent gets the delegating run's permission mode and `session` rules (its own `permissionMode` follows Claude Code, except that `acceptEdits`, `auto` and `bypassPermissions` under a `default` run are ignored, `narrowMode()`), only the tools the lists of every subagent above it allow (the runtime's tools included) plus its own memory and MCP tools, the subagents its delegating agent may use (`AgentConfig.subagents` narrows down the chain), `Agent(name)` deny rules refuse it, subagent names are lowercase letters, digits and hyphens, the call's `model` is `inherit` or an alias of `llm.modelAliases`, a model without a known price is refused when a cost limit applies to the delegating run or a run above it, a Claude model id without a provider runs on Anthropic, its tool calls are charged to the session of the run that delegated, `tools` and `disallowedTools` filter every tool of its run with the permission rule grammar, and a `tools` list that names none of the available tools fails the delegation. `maxDepth` (3) caps nesting.
  - `approvalMode: 'bubble'` (in `subagents` and in `agentAsTool()` options): the delegate's approvals go to the calling run's `onApproval`, and when the delegate pauses, for an approval or a question of a tool, the calling run pauses with the delegate's checkpoint in `RunCheckpoint.turn.children[toolCallId]` and its interrupts and approvals under ids that start with `<toolCallId>/`, across any number of levels. A resume that answers them (`responses` or `decisions`) goes on inside the delegate, with its calls checked against the permission rules again. Tools that delegate get `ToolContext.delegation` (`conversation()`, `onApproval`, `resume`, `depth`), and `DelegatePauseSignal` pauses the calling run.
  - Background subagents run on their own run handle, their slot taken before anything is set up: `send_message` steers a running one or continues one that finished with its conversation, set up again as it was (its mode, its worktree, its MCP servers) and held to what the continuing run allows, `task_output` reads its result, `task_stop` stops it. A run that would stop waits for the background subagents it started and reads their results as a `<task-notification>` message, a run that pauses or fails stops them. `maxBackground` (20) caps how many run at once.
  - `isolation: worktree` runs a subagent in a git worktree under `.cogitator/worktrees/` of the repository the run's local workspace is in, with every setting of the run's `LocalWorkspace` (`LocalWorkspace.withRoot()`, its `exec.launch` sandbox included) and the run's workspace-bound tools rebound to it, removed with its branch when the subagent changed nothing and kept, with its path in the result's `note`, otherwise. A subagent that paused goes on in the same worktree.
  - `messages: 'none' | 'conversation' | (messages) => messages` picks the delegating run's messages a delegate reads before its task. `onDelegationStart` and `onDelegationComplete` hear every delegation (`DelegationStartEvent`, `DelegationCompleteEvent`), and the runtime's `SubagentStart` and `SubagentStop` hooks fire for every subagent run.
  - `CogitatorConfig.commands: { files?, commands?, onDiagnostic? }`. An input that starts with `/name` is replaced by the command's template before the run starts (never in a run started from a tool call): Markdown files in `commands/` folders from the same places as subagents (`frontend/component.md` is `/frontend:component`) and templates in code. `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` (0-based, as Claude Code counts them now), `$name` of `arguments`, `\$` escapes, `${CLAUDE_PROJECT_DIR}`, `${COGITATOR_PROJECT_DIR}` and `${CLAUDE_SESSION_ID}`, and `ARGUMENTS: <value>` added when no placeholder took the arguments. `allowed-tools` become allow rules of that run when permissions are set up, `disallowed-tools` take tools away from it, `effort` sets its reasoning effort, `model` runs it on another model and that model's provider. `context: fork` and `agent` are reported as not supported. A paused run keeps the expanded command in `RunCheckpoint.command`, so a resume runs under the same model, effort and tool limits. `RunResult.command` reports what was expanded (`ExpandedCommand`).
  - `cog.listSubagents({ root })` and `cog.listCommands({ root })` return what a run would see, with the diagnostics.
  - `@cogitator-ai/core` exports `parseSubagentFile`, `parseCommandFile`, `SubagentFinder`, `CommandFinder`, `toolPolicy`, `narrowMode`, `taskNotification`, `openWorktree`, `agentMemoryDir`, `commandInvocation`, `expandCommand`, `splitArguments`, `DelegatePauseSignal`, `isDelegatePause` and the tool names. `@cogitator-ai/types` adds `SubagentsConfig`, `SubagentDefinition`, `SubagentDefinitionInput`, `SubagentCatalog`, `DefinitionFileOptions`, `DefinitionDiagnostic`, `DelegationApprovalMode`, `DelegationMessages`, the delegation events, `ToolDelegationContext`, `DelegatedResume`, `CommandsConfig`, `CommandDefinition`, `ExpandedCommand` and `BackgroundSubagentStatus`. `@cogitator-ai/config` reads `subagents`, `commands` and `llm.modelAliases` from config files (without the functions).
  - Agent teams: a new `team` swarm strategy where a lead plans the work as a shared task list and members claim or are assigned tasks, work through them concurrently and talk through mailboxes, in the spirit of Claude Code's agent teams. Tasks are pending, in progress or completed, can depend on other tasks, and are claimed atomically, with one task in progress per member. The lead gets `create_task` and `assign_task`, everyone gets `list_tasks`, `update_task`, `send_message` and `read_inbox`, and members get `claim_task`. Messages are marked as coming from agents and never count as the user's approval, and every bound (`maxLeadTurns`, `maxTurnsPerMember`, `maxConcurrentMembers`, `maxTasks`) keeps a run finite. `SwarmBuilder` gets `.lead()`, `.members()` and `.team()`. `@cogitator-ai/types` adds `TeamConfig`, `TeamTask`, `TeamResult` and the typed `team:*` events (`TeamEventMap`).
  - `@cogitator-ai/studio` runs the swarms of a project (`POST /api/swarms/:key/run`, a Swarms page) and shows a team as a live graph: the agents' status, task assignments, messages and the task board.

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0
  - @cogitator-ai/core@0.68.0
  - @cogitator-ai/swarms@0.15.0
  - @cogitator-ai/memory@0.26.7
  - @cogitator-ai/workflows@0.14.19

## 0.5.1

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0
  - @cogitator-ai/core@0.67.0
  - @cogitator-ai/memory@0.26.6
  - @cogitator-ai/workflows@0.14.18

## 0.5.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/types@0.76.0
  - @cogitator-ai/core@0.66.0
  - @cogitator-ai/memory@0.26.5
  - @cogitator-ai/workflows@0.14.17

## 0.4.3

### Patch Changes

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

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0
  - @cogitator-ai/core@0.65.0
  - @cogitator-ai/memory@0.26.4
  - @cogitator-ai/workflows@0.14.16

## 0.4.2

### Patch Changes

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

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0
  - @cogitator-ai/core@0.64.0
  - @cogitator-ai/workflows@0.14.15
  - @cogitator-ai/memory@0.26.3

## 0.4.1

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/core@0.63.1
  - @cogitator-ai/memory@0.26.2
  - @cogitator-ai/workflows@0.14.14

## 0.4.0

### Minor Changes

- [#289](https://github.com/cogitator-ai/Cogitator-AI/pull/289) [`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd) - Agent Skills from `SKILL.md` folders, todo lists with `write_todos`, and deferred tools found with `tool_search`.

  - `SkillRegistry` (core) finds skills in the Agent Skills format: folders with a `SKILL.md` whose YAML frontmatter gives `name` and `description`, next to the files the skill needs. It searches `dirs` (folders of skills, or a skill folder itself), a `project` folder on the host, with `user` the home folder, and the run's workspace (`.agents/skills`, `.cogitator/skills` and `.claude/skills` under its root, unless `workspace: false`), the first skill of a name winning. Host folders win over the workspace by default, so a skill a repository or the agent put there cannot replace one you chose, and `precedence: 'workspace'` puts the workspace first. Frontmatter is read leniently: a file without frontmatter or `description` is skipped, a name that breaks the format's rules or differs from its folder, a value of the wrong type or past its length and an unknown YAML tag are loaded with a warning, and every problem is in the catalog's `diagnostics` and logged once. Only metadata is kept (`name`, `description`, `license`, `compatibility`, `metadata`, `allowedTools`, `location`, `source`), the body and the files are read when the skill is activated. Host folders are scanned once per registry (`reload()` scans again), the workspace on every run, abortable with the run.
  - `AgentConfig.skills` takes a `SkillRegistry`, its configuration or any `SkillLoader` next to skills defined in code, whose tools and instructions still join the agent's. When skills are found, the system prompt ends with an `<available_skills>` section (names and descriptions, at most 12 000 characters of descriptions, then names only) and the run offers `use_skill({ skill })`, which returns the body of `SKILL.md` without its frontmatter (cut at `maxInstructionChars`, 20 000 by default, with a note where the rest is), the skill folder and its files. Files of a skill in the workspace are read with the agent's `read_file`, files of a host skill with `read_skill_file({ skill, path })`, which refuses paths that leave the skill folder, symlinks included. In the workspace a symbolic link is never followed, for a skill folder, the folders above it, its `SKILL.md` or its files, checked on every read. Activating a skill whose instructions are still in the conversation returns a short note, told apart by the skill's folder and workspace, so another agent's skill of the same name loads its own. An agent a handoff reaches gets its own skills. `allowed-tools` is kept on the skill and named to the model, not enforced. An invalid skills source fails the run with `CONFIGURATION_ERROR`, and an object that looks like a code skill but is not one is refused by the `Agent` constructor.
  - `AgentConfig.todos` gives the model `write_todos({ todos: [{ id, content, status }] })`. Each call replaces the list, ids are unique and at most one item is `in_progress`, else the call fails with a validation error. The list is read from the conversation and copied to the thread's metadata under `todos` (`{ items, entryId }`) by a run that saves to memory on the active branch. A later run whose history lost the list gets it from there when `entryId` is on its branch. The list is reported with the new `RunOptions.onTodos` and `RunObserver.onTodos` (also when a run starts from one), whose errors and failed metadata writes are logged without undoing the list, and returned as `RunResult.todos`. `todos` travels in the agent wire format and in snapshots.
  - `Tool.deferred` keeps a tool's schema out of the requests. A run whose agent has deferred tools offers `tool_search({ query, limit })`, which ranks them with BM25 over names, descriptions and parameter names and descriptions, identifiers split into words, and loads the best ones: their schemas are sent from the next turn on. The loaded tools are read back from the `tool_search` results in the conversation, so they stay loaded after a resume, in a fork, after a handoff and in later runs of the thread. A call to a deferred tool that was not loaded still runs, and a deferred tool forced with `toolChoice` is sent and stays loaded. The history budget counts the tools loaded in a `history` the run is given, and a history whose loaded tools push it past the window is cut to fit. Loading tools changes the tool list, and so the prompt cache prefix from that turn.
  - Clearing tool outputs leaves the run's own `use_skill` (the newest, up to 40 000 characters), `tool_search` and `write_todos` results alone, a tool of yours with one of these names is cleared as before. Compaction of a run's conversation puts the instructions of active skills (the newest, up to 40 000 characters, a note naming the rest) and the tools a search loaded back as system messages when it dropped them, and the newest todo list as a `write_todos` call and its result that checkpoints and `history` keep, one each however many compactions there are, and keeps room for them in the window. `ContextManager.compress()` takes the tokens to keep free, and `ToolRegistry.getSchemas()` a filter.
  - `Agent.clone()` merges the instructions of skills defined in code once, also clone after clone, where each clone used to add another copy.
  - Cogitator Studio shows a run's todo list in a Todos panel, updated live from the new `run.todos` host event, and keeps it in `RunRecord.todos`.
  - The `SkillLoader` interface of types, declared but never implemented, now describes a source of `SKILL.md` skills (`discover(context)` returning a `SkillCatalog`, `context.signal` aborting with the run), and `AgentConfig.skills` is typed `AgentSkillSource[]`.

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/core@0.63.0
  - @cogitator-ai/memory@0.26.1
  - @cogitator-ai/workflows@0.14.13

## 0.3.21

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b), [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/memory@0.26.0
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/workflows@0.14.12

## 0.3.20

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/memory@0.25.6
  - @cogitator-ai/workflows@0.14.11

## 0.3.19

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - @cogitator-ai/memory@0.25.5
  - @cogitator-ai/workflows@0.14.10

## 0.3.18

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/memory@0.25.4
  - @cogitator-ai/workflows@0.14.9

## 0.3.17

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/memory@0.25.3
  - @cogitator-ai/workflows@0.14.8

## 0.3.16

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/memory@0.25.2
  - @cogitator-ai/workflows@0.14.7

## 0.3.15

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/memory@0.25.1
  - @cogitator-ai/workflows@0.14.6

## 0.3.14

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/memory@0.25.0
  - @cogitator-ai/workflows@0.14.5

## 0.3.13

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/workflows@0.14.4
  - @cogitator-ai/memory@0.24.5

## 0.3.12

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/memory@0.24.4
  - @cogitator-ai/workflows@0.14.3

## 0.3.11

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/memory@0.24.3
  - @cogitator-ai/core@0.56.4
  - @cogitator-ai/workflows@0.14.2

## 0.3.10

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/memory@0.24.2
  - @cogitator-ai/workflows@0.14.1

## 0.3.9

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/workflows@0.14.0
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/memory@0.24.1

## 0.3.8

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/memory@0.24.0
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/workflows@0.13.11

## 0.3.7

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/memory@0.23.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/workflows@0.13.10

## 0.3.6

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/memory@0.22.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/workflows@0.13.9

## 0.3.5

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/memory@0.21.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/workflows@0.13.8

## 0.3.4

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/memory@0.20.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/workflows@0.13.7

## 0.3.3

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/memory@0.19.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/workflows@0.13.6

## 0.3.2

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/memory@0.18.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/workflows@0.13.5

## 0.3.1

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/memory@0.17.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/workflows@0.13.4

## 0.3.0

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
  - @cogitator-ai/memory@0.16.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/workflows@0.13.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/memory@0.15.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/workflows@0.13.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/memory@0.14.0
  - @cogitator-ai/core@0.47.0
  - @cogitator-ai/workflows@0.13.1

## 0.2.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/workflows@0.13.0
  - @cogitator-ai/memory@0.13.3

## 0.1.12

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/workflows@0.12.12
  - @cogitator-ai/memory@0.13.2

## 0.1.11

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/workflows@0.12.11
  - @cogitator-ai/memory@0.13.1

## 0.1.10

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/memory@0.13.0
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/workflows@0.12.10

## 0.1.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/memory@0.12.9
  - @cogitator-ai/workflows@0.12.9

## 0.1.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/workflows@0.12.8
  - @cogitator-ai/memory@0.12.8

## 0.1.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/models@18.5.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/memory@0.12.7
  - @cogitator-ai/workflows@0.12.7

## 0.1.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/memory@0.12.6
  - @cogitator-ai/models@18.4.1
  - @cogitator-ai/types@0.41.1
  - @cogitator-ai/workflows@0.12.6

## 0.1.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/memory@0.12.5
  - @cogitator-ai/workflows@0.12.5

## 0.1.4

### Patch Changes

- [#155](https://github.com/cogitator-ai/Cogitator-AI/pull/155) [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292) - Decision models and OpenRouter as a built-in provider.

  - `cog.decide()` asks a decision model typed questions about a state and returns typed answers with probabilities instead of text: `noul` for yes or no, `choice` for one of several options, `score` for a level on a scale. Answers are typed by the questions, the request is checked before the call and the answer after it, and the call goes through the LLM retry policy, is checked against cost-routing budgets before it is sent, goes through `security.pii` masking or blocking, is priced and is reported to run observers as a run with one `llm.decide` span.
  - `decisionTool()` turns fixed questions into a tool an agent passes the state to.
  - OpenRouter's Decisions API is built in, with TypeSafe's Jev (`openrouter/typesafe/jev-1.13`). Other providers plug in through `llm.decisionBackends` and the `DecisionBackend` interface.
  - OpenRouter is a built-in provider for chat too: `llm.providers.openrouter` with `apiKey` and an optional `baseUrl`, or `OPENROUTER_API_KEY` through `@cogitator-ai/config`.
  - A chat run on a decision model fails at once with `CONFIGURATION_ERROR` instead of a provider error.
  - `LLMRetryPolicy` and `retryLLMCall` give calls that are not chat the retry policy of LLM backends.
  - `@cogitator-ai/models` knows Jev with its price, marks models with `kind: 'chat' | 'decision'` and adds `isDecisionModel()`.
  - Studio shows `llm.decide` spans.

  **Breaking:** a model string starting with `openrouter/` now runs on the OpenRouter provider. Before, the prefix stayed part of the model name on `llm.defaultProvider`.

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/models@18.4.0
  - @cogitator-ai/workflows@0.12.4
  - @cogitator-ai/memory@0.12.4

## 0.1.3

### Patch Changes

- [#153](https://github.com/cogitator-ai/Cogitator-AI/pull/153) [`60e8e89`](https://github.com/cogitator-ai/Cogitator-AI/commit/60e8e8930d7d7645bbf8dfe7a6ebf20da9d004ea) - A chat turn no longer sticks at "running" after its run finished. Right after sending, the studio loads the thread, and when that snapshot was taken while the run was still going but arrived after the event that it completed, it took the run back to running for good. Every run now has a `revision` that each change raises, streamed text included, and the UI keeps only the newer copy: a late snapshot no longer undoes an event, and text it already holds is not added twice. Revisions go on above those of a session before a restart.

  A run whose fork steps cannot be recorded still completes, without steps, and the studio log says why. It used to stay running.

## 0.1.2

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/workflows@0.12.3
  - @cogitator-ai/memory@0.12.3

## 0.1.1

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/workflows@0.12.2
  - @cogitator-ai/memory@0.12.2

## 0.1.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - Cogitator Studio, a local debugger for agent projects: an overview of the project with its runs, success rate, spend, latency and daily activity, chat with every agent of the registry with streamed Markdown answers, highlighted code, LaTeX math, reasoning, tool calls and threads, approve or reject tool calls that need it, read each run as a waterfall of model calls, tool calls and nested agents with tokens and cost, and open any span for its details, run workflows with live node statuses and rerun them from a node, fork a finished run from any step with a changed input, context or tool result and compare both branches. A command palette (`⌘K`) reaches every agent, workflow, run and action, keyboard shortcuts cover the rest, and the light and dark themes follow the system. The project runs in a child process that reloads on save, and the history is kept in `.cogitator/studio/`.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/memory@0.12.1
  - @cogitator-ai/workflows@0.12.1
  - @cogitator-ai/types@0.37.0
