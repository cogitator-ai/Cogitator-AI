# create-cogitator-app

## 0.14.3

### Patch Changes

- Updated dependencies [[`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445)]:
  - @cogitator-ai/config@0.34.0
  - @cogitator-ai/deploy@0.7.10

## 0.14.2

### Patch Changes

- Updated dependencies [[`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6)]:
  - @cogitator-ai/config@0.33.0
  - @cogitator-ai/deploy@0.7.9

## 0.14.1

### Patch Changes

- Updated dependencies [[`cb4a7fa`](https://github.com/cogitator-ai/Cogitator-AI/commit/cb4a7fa20594805d6bf150f680185cc07520fec0)]:
  - @cogitator-ai/config@0.32.0
  - @cogitator-ai/deploy@0.7.8

## 0.14.0

### Minor Changes

- [#302](https://github.com/cogitator-ai/Cogitator-AI/pull/302) [`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4) - `createHarnessAgent()` assembles a production agent from the pieces the runtime has, in one call: a workspace with file tools (and `run_command` for coding), `write_todos`, `SKILL.md` skills, Markdown subagents with a built-in `general-purpose` one and commands, `AGENTS.md` project instructions, the permission engine in `default` mode, compaction, long tool results saved to the workspace past 30 000 characters, `tool_search` once an agent has more than 20 tools, and parallel read-only calls.

  ```ts
  const harness = createHarnessAgent({ preset: 'coding', workspace: './my-app' });
  const cog = new Cogitator(
    harness.mergeConfig({ llm: { defaultModel: 'anthropic/claude-sonnet-5-5' } })
  );
  await cog.run(harness.agent, {
    input: 'Fix the failing test',
    ...harness.runOptions,
    onApproval,
  });
  ```

  - Presets `coding` (every workspace tool, subagents, commands, project instructions, 100 turns) and `assistant` (no shell, a `./workspace` folder, memory files once the runtime has a memory adapter, given to the harness or in the config `mergeConfig()` merges into, 30 turns). Every piece is an option: `false` turns it off, a value changes it, `agent` sets any other field of the `Agent`.
  - The result is plain values: `agent`, `config` (the `Cogitator` fields the pieces need), `runOptions` (`parallelToolCalls`), `workspace`, `mergeConfig(base)` and `dispose()`. `mergeConfig` merges deep: the preset's defaults give way to your config, your `createHarnessAgent()` options win over it, maps such as `subagents.agents` merge by key. A piece you turn off with `false` (`subagents`, `commands`, `permissions`, `hooks`, `compaction`, `settings`, `memoryFiles`) is dropped from your config too, so it stays off.
  - A project's own subagents, commands, hooks and allow rules apply only with `trusted: true`, settings files are read only with `settings: true`, both from `projectRoot` on this machine: the root of a `LocalWorkspace` by default, the host directory of a `DockerWorkspace` when you pass it, none for a remote workspace. `permissions: false` with `settings: true` reads the hooks and leaves the permission engine off.
  - `AgentConfig.deferredTools` names tools whose schemas wait for `tool_search` without changing the tools, so a tool other agents share stays as it is. The harness defers your tools this way once the model would see more than 20 tools, its built-in ones counted.
  - `harnessPrompt(features)` builds the short system prompt section on the workspace, todos, subagents, deferred tools and approvals for an agent of your own.

  Existing agents and runtimes run as before: the harness composes them, and `deferredTools` is a new optional field.

  create-cogitator-app: the `assistant` preset (the `harness` feature) builds its agent with `createHarnessAgent({ preset: 'assistant' })`. `src/harness/workspace.ts` is gone, `src/agents/assistant.ts` exports `createAssistant(workspace)` and `assistantHarness`, `src/cogitator.ts` merges the harness settings into `cogitator.yml`, and approvals before writes come from the permission engine.

### Patch Changes

- Updated dependencies []:
  - @cogitator-ai/config@0.31.1
  - @cogitator-ai/deploy@0.7.7

## 0.13.6

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/config@0.31.0
  - @cogitator-ai/deploy@0.7.6

## 0.13.5

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/config@0.30.0
  - @cogitator-ai/deploy@0.7.5

## 0.13.4

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/config@0.29.0
  - @cogitator-ai/deploy@0.7.4

## 0.13.3

### Patch Changes

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/config@0.28.0
  - @cogitator-ai/deploy@0.7.3

## 0.13.2

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/config@0.27.0
  - @cogitator-ai/deploy@0.7.1

## 0.13.1

### Patch Changes

- [#292](https://github.com/cogitator-ai/Cogitator-AI/pull/292) [`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1) - An Ollama container in the Docker deployment of a project with local models, `cogitator deploy logs`, and the Fly app and organization in the deploy config.

  Behavior change: a docker deployment whose models run on a local Ollama used to reach the Ollama of the Docker host through `host.docker.internal`. From this release its next deploy runs an Ollama container next to the app instead and downloads the models into it on the first start, which takes as long as the download. Set `deploy.services.ollama: false` to keep reaching the Ollama of the host.

  - When the project's models run on a local Ollama, the docker target's Compose file runs an `ollama` service on `ollama/ollama:0.40.10`, with the models in the `ollama-data` volume and a health check. The roles are looked at one by one, in the environment the deployment gets (`deploy.env` included): the chat models the runtime uses (`llm.defaultModel`, `context.summaryModel` unless context is off, the models of the memory stages that are set, `reflection.reflectionModel` with reflection on, `guardrails.model` unless guardrails are off, `security.promptInjection.llmModel` with `classifier: llm`) and the embeddings of `memory.embedding` with `provider: ollama` (`nomic-embed-text` unless `memory.embedding.model` names another). Ollama Cloud models (a `:cloud` tag, or an API key without a URL) belong to the chat role and are never pulled. A role whose Ollama URL points beyond this machine keeps it, the variables it follows are forwarded (`GPU_OLLAMA` for `baseUrl: ${GPU_OLLAMA}`), and only the local roles move to the container. With `llm.defaultProvider: ollama` and no model in the config there is nothing to pull, so the app reaches the Ollama of the host with a warning unless `deploy.ollama.models` lists the models. A one-shot `ollama-pull` service pulls their models before the app starts: each model is an argument after `--`, never part of the script, and one the volume has already is skipped, so a restart without network still starts. A model name `ollama pull` would refuse or read as a flag fails preflight. A failed download fails the deploy with the last lines of the job, and the CLI says that the first start downloads the models. Redis and Postgres stay as they were.
  - A local chat role gets `COGITATOR_OLLAMA_BASE_URL`, `OLLAMA_BASE_URL`, `OLLAMA_URL` and `OLLAMA_HOST` set to `http://ollama:11434`, also when one of them was detected as a secret with a localhost value. Local embeddings get the variables their `memory.embedding.baseUrl` follows, such as `${OLLAMA_EMBEDDING_URL:-http://localhost:11434}`, with the whole URL or only the host for a variable that is the host part, checked to give the service URL, else left alone with a warning. A variable another provider's settings reference is never rewritten, and a variable is set only when it moves no role that stays remote, and the analyzer warns when the embeddings cannot reach the container or when `services.ollama: true` runs one no model uses.
  - `deploy.services.ollama` turns the container on or off. Off, the local roles reach the Ollama of the Docker host through `host.docker.internal` as before, each on the port of its own local URL, and a warning lists the models to pull there. The keys of `deploy.services` replace the detected ones one by one, so the opt-out keeps Redis and Postgres detected from the memory adapter. `deploy.ollama` sets the `models` to pull (the detected ones when unset, models agents name in code are not detected), `gpu: true` to reserve the NVIDIA GPUs of the host and the `image`. On Fly the analyzer warns when Ollama models or `services.ollama` have no Ollama to run on.
  - `cogitator deploy logs [service]` shows the logs of the deployment: `docker compose logs` of the deployed stack on the docker target (`-f, --follow`, `-n, --tail`, 100 lines by default, `--timestamps`, one service such as `app` or `ollama-pull`), `flyctl logs --app <app>` on Fly (`--no-tail` unless following). The commands are built as argument lists, a service name or tail that would read as a flag is refused, flags that do not apply to an action (or to Fly) are usage errors, and a logs command stopped by a signal exits with 128 plus its number. `Deployer.logsCommand()` resolves to the command for custom pipelines, and the optional `DeployProvider.logsCommand()` may return it or a promise of it.
  - `loadConfig({ env })` reads the `${VAR}` references of the file, the `COGITATOR_*` variables and the shared Ollama variables from `env` instead of `process.env`, and `loadEnvConfig(env)` and `loadEnvDefaults(env)` take it too. The deploy analyzer loads the config this way in exactly the environment the app container gets (`deploy.env`, the forwarded secrets and the Ollama variables it sets), and forwards the variables the config reads that are set (`${VAR}` references and `COGITATOR_*` overrides such as `COGITATOR_LLM_DEFAULT_MODEL`), so the app asks for the models the deployment pulled. `configOverrides.ollama` merges into `deploy.ollama` field by field.
  - `deploy.app` names the Fly app, the image name stays the fallback, and `deploy.org` creates a new app with `fly apps create --org <org>`. The config schema and Fly preflight refuse an app name Fly would refuse (lowercase letters, digits and dashes, starting and ending with a letter or digit, 63 characters at most) and an organization that is not a slug. `isFlyAppName`, `isFlyOrgSlug` and `isOllamaModelName` are exported from `@cogitator-ai/types`.
  - The README of a project from `create-cogitator-app` whose docker deployment gets an Ollama container says that it runs and fills its own Ollama.

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/deploy@0.7.0
  - @cogitator-ai/config@0.26.0

## 0.13.0

### Minor Changes

- [#288](https://github.com/cogitator-ai/Cogitator-AI/pull/288) [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b) - Memory defaults chosen on the memory benchmarks, and a shadow mode for extraction.

  - Behavior change: `memory.contextBuilder` without a `strategy` now uses `hybrid` when `memory.embedding` is set, and `recent` otherwise as before. A runtime with embeddings and no strategy keeps the newest turns as history and also recalls the earlier turns and memory items that match the turn, which embeds every message of a thread once, in the background. On seven long-memory datasets `hybrid` averaged 44.9% against 18.0% for `recent`, as much as `relevant` at three quarters of its cost. A `strategy` you set is kept, so set `strategy: 'recent'` to keep the old behavior.
  - `memory.extraction.mode` (types, core, config): `apply` by default, or `shadow`, which writes every new item as `suggested`, so it reaches no context, no recall and no fact until it is reviewed (`MemoryItems.query` with `statuses: ['suggested']`) and activated (`MemoryItems.activate`). It is `MemoryItems({ shadow: true })` (memory), which also leaves the confidence of other opinions alone. Extraction stays off by default and the docs recommend starting with `shadow`. Compaction stays off by default too.
  - Scaffolded projects with a lasting store (`sqlite`, `postgres`, `redis`, `mongodb`) get long-term memory in `cogitator.yml`: the provider's embedding model in `memory.embedding` with the `hybrid` strategy (`recent` with Anthropic, which has no embedding model), and `memory.files` for the agents' notes. On Ollama the embedding model is pulled with the chat model. The `assistant` preset is among them. Only Postgres keeps the vectors: on SQLite, Redis and MongoDB the message index lives in the process, so after a restart (`cogitator dev` restarts on every change) each thread's messages are embedded again the first time it is used, one embedding per message. That cost is cents beside the gain of `hybrid`, so those templates keep it, and the generated AGENTS.md says so.

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/config@0.25.0
  - @cogitator-ai/deploy@0.6.35

## 0.12.0

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

- Updated dependencies []:
  - @cogitator-ai/config@0.24.7
  - @cogitator-ai/deploy@0.6.33

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

- Updated dependencies []:
  - @cogitator-ai/config@0.24.5
  - @cogitator-ai/deploy@0.6.31

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

- Updated dependencies []:
  - @cogitator-ai/config@0.24.4
  - @cogitator-ai/deploy@0.6.30

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

- Updated dependencies []:
  - @cogitator-ai/config@0.24.3
  - @cogitator-ai/deploy@0.6.29

## 0.8.13

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/config@0.24.0
  - @cogitator-ai/deploy@0.6.26

## 0.8.12

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/config@0.23.0
  - @cogitator-ai/deploy@0.6.21

## 0.8.11

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/config@0.22.0
  - @cogitator-ai/deploy@0.6.20

## 0.8.10

### Patch Changes

- Updated dependencies [[`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/config@0.21.0
  - @cogitator-ai/deploy@0.6.19

## 0.8.9

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/config@0.20.0
  - @cogitator-ai/deploy@0.6.18

## 0.8.8

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/config@0.19.0
  - @cogitator-ai/deploy@0.6.17

## 0.8.7

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/config@0.18.0
  - @cogitator-ai/deploy@0.6.16

## 0.8.6

### Patch Changes

- [#223](https://github.com/cogitator-ai/Cogitator-AI/pull/223) [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913) - Generated projects pin Biome to an exact version, as Biome recommends. Its formatting changes between releases and the scaffolder formats the project it writes, so a new release, or one published without its binaries, no longer breaks or changes scaffolding.
- Updated dependencies []:
  - @cogitator-ai/config@0.17.4
  - @cogitator-ai/deploy@0.6.13

## 0.8.5

### Patch Changes

- [#214](https://github.com/cogitator-ai/Cogitator-AI/pull/214) [`f903fc1`](https://github.com/cogitator-ai/Cogitator-AI/commit/f903fc15fca7e29f5187f1fc60e099a8a9b28a03) - Require `tar` 7.5.22 or later. Earlier versions are open to hardlink and symlink path traversal and to several denial of service bugs, and the scaffolder extracts template archives downloaded from GitHub.

## 0.8.4

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/config@0.17.0
  - @cogitator-ai/deploy@0.6.9

## 0.8.3

### Patch Changes

- [#207](https://github.com/cogitator-ai/Cogitator-AI/pull/207) [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22) - Realtime tools can run through the Cogitator tool invoker. `createRealtimeTools(cogitator, tools, options)` turns Cogitator tools into realtime tools whose calls go through `cogitator.invokeTool`, the way an agent run executes them: arguments checked against the tool's schema, approval asked for calls that need it, the guardrails applied, sandboxed tools run in the sandbox and `tool.timeout` kept. A call that needs approval goes to `options.onApproval`, then to `guardrails.onToolApproval`, and one nobody approves does not run: the model gets an error saying it needs approval. Realtime sessions used to call `execute` directly, so a tool marked `requiresApproval` ran without anyone approving it. The options also set the `agentId`, `userId` and `threadId` (default `voice:<sessionId>`) the tools see.

  `RealtimeTool.execute(args, context)` gets the provider's `callId`, the session's `sessionId` (a `VoiceAgent` sets the client id, a `RealtimeSession` takes `sessionId` in its config) and a `signal` that aborts when the session closes or loses its connection. With Gemini it also aborts when Gemini cancels the call (`toolCallCancellation`, sent when the user interrupts), and the cancelled call gets no answer.

  The voice project of the scaffolder uses `createRealtimeTools`.

  **Migration:** tools written as `execute: async (args) => ...` keep working. Code that calls a `RealtimeTool`'s `execute` itself, such as a test, now passes a context: `{ callId, signal }`.

- Updated dependencies []:
  - @cogitator-ai/config@0.16.1
  - @cogitator-ai/deploy@0.6.8

## 0.8.2

### Patch Changes

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - The voice helper of a scaffolded project passes each tool's `maxResultLength` on to the realtime session, so a tool reads as much of its result in a voice call as in a run.
- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/config@0.16.0
  - @cogitator-ai/deploy@0.6.7

## 0.8.1

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/config@0.15.0
  - @cogitator-ai/models@18.5.0
  - @cogitator-ai/deploy@0.6.6

## 0.8.0

### Minor Changes

- [#201](https://github.com/cogitator-ai/Cogitator-AI/pull/201) [`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f) - The scaffolder offers to start the project's compose services once the project is created. When the stack has Postgres, Redis, MongoDB, Qdrant, Jaeger or the Ollama container and Docker is running, it asks whether to run `docker compose up --wait` and waits until they are healthy, so the first `dev` finds its database. The Ollama container pulls the model in the background, and the next steps point at `docker compose logs -f ollama-pull` instead of `ollama pull`. An Ollama that already answers at `OLLAMA_BASE_URL` is left alone and the compose one is not started, since it could not take the port. Nothing starts with `--yes`, `--json`, without a TTY, in CI or in a dry run. `cogitator init` makes the same offer and leaves the compose Postgres out when you give a database URL of your own.

  `startServices`, `dockerComposeAvailable`, `servicesToStart`, `offerServices` and `isInteractive` are exported. `offerServices` asks at the terminal, so programmatic callers check `isInteractive` first. `ProjectPlan.oneShotServices` names the services that run a task and exit.

  `resolveOllamaUrl` now answers with the Ollama the generated project talks to: `OLLAMA_BASE_URL`, which its `cogitator.yml` reads, else `http://localhost:11434`. It no longer reads `OLLAMA_HOST`, the address the Ollama server listens on, which the project ignores. With the common `OLLAMA_HOST=0.0.0.0` the scaffolder used to look for Ollama on port 80 and report a running one as missing.

### Patch Changes

- [#201](https://github.com/cogitator-ai/Cogitator-AI/pull/201) [`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f) - Projects created for Yarn 2 and later work out of the box, from create-cogitator-app, `--example` and `cogitator init` alike. They get a `.yarnrc.yml` with `nodeLinker: node-modules`, because tsx, vitest and Cogitator Studio could not find their packages under Plug'n'Play, Yarn's default, and the `.gitignore` entries Yarn recommends for `.yarn/`. Projects pinned to Yarn 1 get no `.yarnrc.yml`, Yarn 1 never reads it. Generated projects also declare `vite`, which vitest needs as a peer and which Yarn, unlike npm, pnpm and Bun, does not install by itself, so `yarn test` failed. The first install no longer fails under CI with Yarn 4, which refused to write the lockfile there (`YN0028`).

  To fix a Yarn project created earlier, add a `.yarnrc.yml` with `nodeLinker: node-modules`, run `yarn add -D vite` and install again.

## 0.7.1

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/deploy@0.6.5
  - @cogitator-ai/models@18.4.1

## 0.7.0

### Minor Changes

- [#155](https://github.com/cogitator-ai/Cogitator-AI/pull/155) [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292) - Bluesky and Threads channels in the scaffolder, `cogitator init` and `cogitator wizard`. A generated project keeps the Bluesky session and the Threads token in `.cogitator/tokens.json`, which is ignored by git, and `cogitator wizard --edit` keeps their settings.

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/models@18.4.0
  - @cogitator-ai/deploy@0.6.3

## 0.6.1

### Patch Changes

- [#151](https://github.com/cogitator-ai/Cogitator-AI/pull/151) [`90a5055`](https://github.com/cogitator-ai/Cogitator-AI/commit/90a50551e802a308655b46ad50547856f1e420cd) - The install runs with the package manager that launched the scaffolder, from the `npm_execpath` it sets, and falls back to the one on PATH. A pnpm started by its full path or as a standalone binary, which is not on PATH, failed the install with "pnpm is not installed". `cogitator add` installs the same way.

- [#151](https://github.com/cogitator-ai/Cogitator-AI/pull/151) [`6ff6a3f`](https://github.com/cogitator-ai/Cogitator-AI/commit/6ff6a3f8a2b6a617bc04007ff46908e30c81cc2f) - pnpm projects decline the build of better-sqlite3 unless a feature needs it. Every project gets better-sqlite3 through `@cogitator-ai/cli`, and pnpm 11.0 failed the install over its build nobody approved (`ERR_PNPM_IGNORED_BUILDS`). better-sqlite3 ships prebuilt binaries, so the build is not needed. SQLite memory and the assistant harness still allow it.

- [#151](https://github.com/cogitator-ai/Cogitator-AI/pull/151) [`398426b`](https://github.com/cogitator-ai/Cogitator-AI/commit/398426b3fb620937e94535c3a66e18b1fb330b38) - `sendTelemetry` sends nothing for a payload that is not exactly an event: the documented fields and no other, each a short value of letters, digits and `._,-`. It is exported, so a JavaScript caller could hand it anything, and analysis sandboxes that call every export with test values sent them to the project's analytics.

## 0.6.0

### Minor Changes

- [#150](https://github.com/cogitator-ai/Cogitator-AI/pull/150) [`73237de`](https://github.com/cogitator-ai/Cogitator-AI/commit/73237de96e86412051697491c8109a5887eb564a) - The telemetry event of a failed scaffold says where and why it failed. `failedStep` is `create` (the options, the directory, downloading or writing files) or `install`, and `errorCode` is the code it failed with: the package manager's own from a closed set of known codes (`ERR_PNPM_NO_MATCHING_VERSION`, npm's `ETARGET`, Yarn's `YN0035`, a code for the messages of Bun and Yarn 1, `ERR_PNPM_OTHER` or `NPM_OTHER` for any other, since install scripts print into the same output), a Node network or file system code (`ENOTFOUND`), or the scaffolder's (`DIRECTORY_NOT_EMPTY`, `HTTP_404`). Both are `none` on success. The event never holds the error message or the install output, which can contain paths and package names.

  An `--example` or `--template` whose install failed was counted as a success. It is a failure now, like a generated project.

  In the library, `payloadFor(spec, failure?, kind)` takes a `ScaffoldFailure` (`{ step, error }`) in place of the outcome, and `installFailure(result)` gives the one of a scaffold whose install failed. `telemetryErrorCode`, `installErrorCode` and `CodedError`, the error with a code the scaffolder throws, are exported too.

## 0.5.2

### Patch Changes

- [#148](https://github.com/cogitator-ai/Cogitator-AI/pull/148) [`559e443`](https://github.com/cogitator-ai/Cogitator-AI/commit/559e44375cbf18ae9f0d3d018155e5a237f85d27) - Telemetry events reach Umami. The event's User-Agent ended in `Node/<major>`, which Umami's bot filter takes for a server client, so every event was answered with 200 and dropped. The Node version stays in the event data, and the platform is written the way browsers do, so Umami also shows the OS.

## 0.5.1

### Patch Changes

- [#146](https://github.com/cogitator-ai/Cogitator-AI/pull/146) [`c08bd77`](https://github.com/cogitator-ai/Cogitator-AI/commit/c08bd77e37789ed261d055061c560672a09d98c3) - Projects created with 0.5.0 pinned `@cogitator-ai/cli` 0.5 and `@cogitator-ai/core` 0.34, the versions of the release before it, because the scaffolder was built before the version bump. `npm run dev:studio`, `npm run doctor`, `cogitator add` and `cogitator mcp` failed with an unknown command. New projects pin the current packages again, and the scaffolder reports its own version. A project created with 0.5.0 works again once its `@cogitator-ai/*` dependencies are on the latest versions, for example `npm install -D @cogitator-ai/cli@latest @cogitator-ai/test-utils@latest` and `npm install @cogitator-ai/core@latest @cogitator-ai/config@latest`.

## 0.5.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - The scaffolder is rebuilt on a spec and feature modules. Pick one of 16 presets or the stack itself with flags (`--app`, `--server`, `--channels`, `--memory`, `--vector-store`, `--features`, `--deploy`, `--agent`), see everything with `--dry-run --json`, and get a project with a registry of its agents in `src/cogitator.ts`, three working tools, tests on a mocked model, CI, Biome, a Zod env schema, `AGENTS.md` with the docs bundled for coding agents, Cogitator Studio (`dev:studio`) and, with `--deploy`, a production Dockerfile. Combinations that cannot work are refused before anything is written. `--example <name>` starts from an example of the repository and `--template github:owner/repo/path#ref` from a GitHub template. `--agent claude|cursor|codex` configures the `cogitator` MCP server and a skill. The programmatic `planProject()` and `scaffold(spec, options)` replace the old `scaffold(options)`, and `planAdd()` / `addToProject()` power `cogitator add`. Scaffolding sends one anonymous telemetry event, off with `--no-telemetry`, `COGITATOR_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, in CI and on `--dry-run`.

  Generated projects with pnpm 11 install in CI: the native builds a project needs are allowed and the optional ones (`cpu-features`, `protobufjs`, `ssh2`) declined in `pnpm-workspace.yaml`, so `ERR_PNPM_IGNORED_BUILDS` no longer fails the install, also in projects started from an example. A channels project keeps its gateway in `src/gateway.ts`, so `cogitator assistant`, `cogitator build` and `cogitator daemon` run it as before.

  The CI of a Yarn project turns on corepack and installs with `--immutable` on Yarn 2 and later and `--frozen-lockfile` on Yarn 1. `planAdd()` reports `removedDependencies`, and `changesDependencies(plan)` says whether an addition needs an install in either direction.

  **Breaking:** the programmatic API changed.

  - `scaffold(options)` is now `scaffold(spec, options)`: build the spec with `parseSpec()` or pass a `ProjectSpecInput`, and `planProject(spec)` shows the plan without writing.
  - Removed: `parseArgs`, `collectOptions`, `getTemplate`, `templateChoices`, `devCommand`, `defaultModels`, `providerConfig` and the types `ProjectOptions`, `Template`, `TemplateFile`, `ScaffoldStep`. Use `PRESETS`, `findPreset()`, `defaultModel()`, `PROVIDERS` and the other catalogs instead.
  - The old template names keep working as `--template` and `--preset` values. Projects created before are not touched.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/deploy@0.6.0

## 0.4.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A freshly scaffolded project now runs on the first try. The `dev` and `start` scripts load `.env` (`tsx --env-file-if-exists=.env`), so a key copied from `.env.example` reaches the app instead of failing with `OpenAI API key is required`, and a missing key stops the app with its name and a pointer to `.env.example`. `npx create-cogitator-app` now picks npm instead of pnpm. The default Ollama model is `qwen3.5:9b`, the prompt lists the models already pulled, `--model` and `ProjectOptions.model` choose another one, a missing model is offered for download, and the compose file pulls it into the Ollama container. The printed next steps and the generated README include `cp .env.example .env` or `ollama pull <model>` when the first run needs them.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The project name is validated as an npm package name before anything is written, both by the CLI and by `scaffold()`, and `validateProjectName(name)` is exported to check it up front. `.` names the project after the current directory instead of `"."`, and the name is quoted in the generated code, so a name like `bob's agents` is reported instead of producing code that does not compile.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Generated projects pin the `@cogitator-ai/*` packages with a caret to the versions released together with the scaffolder (for example `^0.33.0`) instead of `latest`, so an older cached scaffolder keeps generating code that compiles and a reinstall without a lockfile does not pull in an incompatible release.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Generated scripts exit with code 1 when the run fails, so CI no longer reports a failed run as a success, and `workflow` also fails on an error in the workflow result. `memory` and `swarm` close their connections on failure too. The `workflow` template prints the report and each node's output instead of `nodeResults: {}`. The generated ignore file now covers every `.env.*` except `.env.example`, `*.tsbuildinfo`, and for `nextjs` the `.next/`, `out/` and `next-env.d.ts` build output.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The `api-server` and `nextjs` templates keep the conversation: they configure in-process memory, so the next message in a thread sees the earlier ones and the thread routes of `api-server` answer instead of `503 Memory not configured`. `api-server` no longer serves unauthenticated runs to every origin on every interface: it listens on `127.0.0.1` in development, checks `Authorization: Bearer $API_TOKEN` on everything but health and docs, refuses to start in production without a token, enables CORS only for the origins in `CORS_ORIGIN`, and its `cogitator.yml` lists the provider key and `API_TOKEN` as deploy secrets. The `nextjs` chat shows run errors and a Stop button, and its `lint: next lint` script, which prompts in CI and is gone in Next 16, is replaced by `typecheck`.

## 0.3.1

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.

## 0.3.0

### Minor Changes

- [`26745cd`](https://github.com/cogitator-ai/Cogitator-AI/commit/26745cdeb375bd6193e782b4a6f72d649da1e1d9) - Generated servers now deploy healthy, and `scaffold()` can be embedded.

  - The `api-server` template mounts its routes at `/api` but `cogitator deploy` probed `/cogitator/health`, so its containers were marked unhealthy. Its `cogitator.yml` now sets `deploy.health.path: /api/health`. The `nextjs` template gets a `/api/health` route and the same setting.
  - `scaffold()` takes `install: false` to write the files without running `<pm> install`, and the CLI takes `--no-install`. It now resolves to a `ScaffoldResult` with the generated files and the outcome of the install and git steps, so a failed install is reported (`{ status: 'failed', error }`) instead of being swallowed. The CLI prints the error and adds the install command to the next steps.
  - The `api-server` template installs express 5, matching its `@types/express` 5 typings and the express version `@cogitator-ai/express` is built against.

## 0.2.1

### Patch Changes

- 63489f0: Generated projects now work with the current packages: `cogitator.yml` uses the `llm.defaultProvider` / `llm.defaultModel` (and `memory`) layout `@cogitator-ai/config` loads instead of top-level keys it dropped, templates depend on zod ^4 like `@cogitator-ai/core`, the workflow template's state type satisfies the workflow `WorkflowState` constraint, and the swarm template no longer reads a nonexistent `result.strategy`. Docs links point to https://cogitator.app, the repository link to cogitator-ai/Cogitator-AI, and the banner shows the installed version instead of v0.1.0.
- 63489f0: `-y`/`--yes` was parsed but ignored, so the CLI still asked every question. It now runs without prompts, using the given flags and the defaults for the rest (`my-agents`, basic template, Ollama, the package manager it was launched with, Docker Compose and git on). Provider hints in the prompts now show the models the templates actually use.
- 4b45676: The initial scaffold commit is now authored by your own git identity instead of a hard-coded `Cogitator <init@cogitator.dev>` address. A neutral `create-cogitator-app@localhost` identity is used only when no `user.name`/`user.email` is configured, so the commit still succeeds on fresh machines.

## 0.2.0

### Minor Changes

- pnpm projects get a `pnpm-workspace.yaml` allowing the native builds pnpm 10.26+/11 would otherwise refuse, so a fresh project installs again; current default models.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

## 0.1.1

### Patch Changes

- fix: audit — 10 bugs fixed, +112 tests added

  Key fixes:
  - Fix gemini-2.0-flash → gemini-2.5-flash (model was returning 404)
  - Fix array bounds crash when --template/--provider/--pm flags have no value
  - Fix workflow template to use correct agentNode/functionNode API
  - Fix swarm template hierarchical config (remove invalid coordination wrapper)
  - Fix git initial commit to configure identity (prevents failure on unconfigured git)
  - Fix docker-compose Postgres credentials to use env var defaults
  - Add REDIS_URL to .env.example for memory template
  - Add non-empty directory check before scaffolding (prevents silent overwrite)
  - Fix project name trimming before path resolution
  - Add lib.ts export for programmatic usage

  New: 100 unit tests, 12 e2e tests, package README, docs page
