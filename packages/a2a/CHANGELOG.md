# @cogitator-ai/a2a

## 0.11.2

### Patch Changes

- Updated dependencies [[`ac89cec`](https://github.com/cogitator-ai/Cogitator-AI/commit/ac89cec9ea8d288afd58f7dbbe1531f8425d757a)]:
  - @cogitator-ai/core@0.77.0
  - @cogitator-ai/types@0.88.0
  - @cogitator-ai/server-shared@0.16.2

## 0.11.1

### Patch Changes

- Updated dependencies [[`e2f1c87`](https://github.com/cogitator-ai/Cogitator-AI/commit/e2f1c8793df4d1fdb06e9d8a5d0e8be984cbd2d2)]:
  - @cogitator-ai/types@0.87.0
  - @cogitator-ai/core@0.76.0
  - @cogitator-ai/server-shared@0.16.1

## 0.11.0

### Minor Changes

- [#314](https://github.com/cogitator-ai/Cogitator-AI/pull/314) [`bff4fea`](https://github.com/cogitator-ai/Cogitator-AI/commit/bff4fea95b5bd9aa84f05ea21a16c47341b5059a) - A2A 1.0 next to A2A 0.3, on the same server and the same endpoints.

  A request names its version in the `A2A-Version` header (or query parameter). A request without one speaks 0.3 as before, byte for byte, so existing 0.3 clients do not notice anything. A request with `A2A-Version: 1.0` gets the 1.0 protocol: the PascalCase methods (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, the four push config methods, `GetExtendedAgentCard`), the ProtoJSON model without `kind`, streams that close on the final state instead of a `final` flag, and errors with `google.rpc.ErrorInfo` and `BadRequest` details. An unsupported version is refused with `-32009`, its ErrorInfo listing the supported ones. The internal task model stays in the 0.3 shape and is translated at the boundary, so `TaskStore`, `RedisTaskStore` and stored tasks are untouched and a task created over one version is readable over the other.

  Server:

  - The A2A 1.0 HTTP+JSON binding under `restPath` (default `<basePath>/rest`), with the routes of the proto's http bindings, `/{tenant}/` variants, `:cancel` and `:subscribe`, `application/a2a+json` or `application/json` bodies, SSE streams, `201` on create, `204` on delete, and `{ error: { code, status, message, details } }` errors with the HTTP status table of the specification. `A2AServer.handleRest()` serves it for custom integrations.
  - Every agent is a tenant: its 1.0 interfaces carry its name, a mismatching tenant is `-32602`, and a task created over 1.0 is visible only through the agent that created it, over 1.0 and 0.3 alike (the new internal metadata key `cogitator:agent`). Tasks created over 0.3 and tasks stored before stay visible to every agent, and a message cannot join a context that holds another agent's tasks. On REST a first segment that names an agent is read as its tenant first, so an agent may be called `tasks`.
  - `ListTasks` pages with a keyset cursor over `TaskStore.list()`: `pageSize` 1 to 100 (default 50), `nextPageToken` empty on the last page, `totalSize`, `statusTimestampAfter`, `includeArtifacts`. The cursor sorts with ties broken by task id, while the stores and the 0.3 `tasks/list` extension with offsets keep their order.
  - Agent Cards come from one model per agent: `getV1AgentCard()` next to `getAgentCard()`. Card responses carry `Vary: A2A-Version`, an `ETag` and `Cache-Control: public, max-age=300`, and answer a matching `If-None-Match` with `304`. An agent without tools lists one `chat` skill, so `skills` is never empty, and the extended card is announced in `capabilities.extendedAgentCard`.
  - Cards are signed with a private key as A2A 1.0 specifies: `cardSigning: { alg, privateKey, kid, jku?, publishJwks? }` with ES256, RS256, PS256 or EdDSA on `node:crypto` (no new dependency), over the JCS of the 1.0 card, the same payload the official SDK verifies. The 1.0 card and the hybrid card carry the same signature, and `publishJwks` serves the public key at `/.well-known/jwks.json`. A 0.3 or hybrid card verifies only when its 0.3 fields follow from the signed 1.0 form (its `url` and `additionalInterfaces` are signed 0.3 interfaces, its security schemes round-trip without loss), and the signer refuses cards that do not. A client on 0.3 takes its endpoint from the signed 0.3 interface. `cardSigning: { secret }` (HS256) keeps working and is deprecated.
  - Extensions: `capabilities.extensions` lists the Cogitator ones (`https://cogitator.app/a2a/extensions/{tool-approvals,interrupts,run-timeout}/v1`) and the new `extensions` option. A message that does not ask for a required one in `A2A-Extensions` (`X-A2A-Extensions` in 0.3) is refused with `-32008`, and the response names the activated ones. Over 1.0 the run timeout comes from `metadata[run-timeout uri].timeoutMs`.
  - `ListTaskPushNotificationConfigs` pages by `pageSize` and `pageToken` with a `nextPageToken`. Push configs remember the version they were registered with. 0.3 webhooks get the task as before, 1.0 webhooks get `{ task }` in the 1.0 form as `application/a2a+json` with `Authorization: <scheme> <credentials>`.
  - `A2A_ERROR_CODES` has `extensionSupportRequired` (-32008) and `versionNotSupported` (-32009). `A2AHttpRequest` has an optional `query`. The Fastify plugin parses `application/a2a+json`, the Koa middleware and the Express router read the body themselves (up to 1 MiB, `413` above) when no parser did or a parser left `{}`, and the Next.js handlers work as a catch-all route and export `DELETE`.

  Client:

  - `A2AClient` reads 0.3 cards, the hybrid card and pure 1.0 cards. `protocolVersion: 'auto'` (default) speaks 1.0 when the card offers it, `'1.0'` and `'0.3'` pin it. `transport: 'JSONRPC' | 'HTTP+JSON'` picks the 1.0 binding, the tenant comes from the chosen interface, and `endpoint()` tells what it chose. The API stays on the 0.3-shaped types.
  - `listTasksPage()` for 1.0 `ListTasks`, `extensions` to ask for extensions, and `verifyAgentCard({ keys | resolveKey, trustJku })` for JWS signatures, with a `jku` fetched only from the card's own origin unless `trustJku` names others. `verifyAgentCard(secret)` still checks HS256.

  Changed defaults, and how to keep the old behavior:

  - The card served without `A2A-Version` is now the hybrid card: the 0.3 card plus `supportedInterfaces` listing every interface of both versions.
  - The REST binding is served under `<basePath>/rest`. Turn it off with `restPath: false`. An agent named `rest` keeps its endpoint: the default REST mount is then off, with a warning.
  - `A2AClient` speaks 1.0 to a server that offers it, so errors carry 1.0 codes (a message to an ended task is `-32004` instead of `-32600`) and webhooks it registers get the 1.0 payload. Keep a client on 0.3 with `protocolVersion: '0.3'`.
  - `protocolVersions: ['0.3']` on the server turns all of 1.0 off: no hybrid card, no REST binding, 0.3 only.

## 0.10.10

### Patch Changes

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

- Updated dependencies [[`2bb4941`](https://github.com/cogitator-ai/Cogitator-AI/commit/2bb4941dc40889458575db0893766c233dabaaaf)]:
  - @cogitator-ai/server-shared@0.16.0
  - @cogitator-ai/core@0.75.0
  - @cogitator-ai/types@0.86.0

## 0.10.9

### Patch Changes

- Updated dependencies [[`6d5d1d0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6d5d1d056fc6a0a6816b497baef12ac73083660a)]:
  - @cogitator-ai/types@0.85.0
  - @cogitator-ai/core@0.74.0
  - @cogitator-ai/server-shared@0.15.1

## 0.10.8

### Patch Changes

- Updated dependencies [[`74439c2`](https://github.com/cogitator-ai/Cogitator-AI/commit/74439c22cce3f000a35a104392b6d290dbb3327d)]:
  - @cogitator-ai/types@0.84.0
  - @cogitator-ai/core@0.73.0
  - @cogitator-ai/server-shared@0.15.0

## 0.10.7

### Patch Changes

- Updated dependencies [[`7d6092d`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d6092d211da63b353b138165e23d5dbae362445)]:
  - @cogitator-ai/types@0.83.0
  - @cogitator-ai/core@0.72.0
  - @cogitator-ai/server-shared@0.14.2

## 0.10.6

### Patch Changes

- Updated dependencies [[`c826f57`](https://github.com/cogitator-ai/Cogitator-AI/commit/c826f57cd32cd086717a1eb6f7b1c3857dff73b6)]:
  - @cogitator-ai/types@0.82.0
  - @cogitator-ai/core@0.71.0
  - @cogitator-ai/server-shared@0.14.1

## 0.10.5

### Patch Changes

- Updated dependencies [[`cb4a7fa`](https://github.com/cogitator-ai/Cogitator-AI/commit/cb4a7fa20594805d6bf150f680185cc07520fec0)]:
  - @cogitator-ai/types@0.81.0
  - @cogitator-ai/core@0.70.0
  - @cogitator-ai/server-shared@0.14.0

## 0.10.4

### Patch Changes

- Updated dependencies [[`904f784`](https://github.com/cogitator-ai/Cogitator-AI/commit/904f784cf78c8690e79ae51947920ef4bb836ae4)]:
  - @cogitator-ai/types@0.80.0
  - @cogitator-ai/core@0.69.0
  - @cogitator-ai/server-shared@0.13.3

## 0.10.3

### Patch Changes

- Updated dependencies [[`132e94f`](https://github.com/cogitator-ai/Cogitator-AI/commit/132e94f60407232b20ab06d608241460f3fb5a9e)]:
  - @cogitator-ai/types@0.79.0
  - @cogitator-ai/core@0.68.1
  - @cogitator-ai/server-shared@0.13.2

## 0.10.2

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0
  - @cogitator-ai/core@0.68.0
  - @cogitator-ai/server-shared@0.13.1

## 0.10.1

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0
  - @cogitator-ai/core@0.67.0
  - @cogitator-ai/server-shared@0.13.0

## 0.10.0

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
  - @cogitator-ai/server-shared@0.12.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0
  - @cogitator-ai/core@0.65.0
  - @cogitator-ai/server-shared@0.11.0

## 0.9.0

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

## 0.8.40

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/core@0.63.1
  - @cogitator-ai/server-shared@0.9.10

## 0.8.39

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/core@0.63.0
  - @cogitator-ai/server-shared@0.9.9

## 0.8.38

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/server-shared@0.9.8

## 0.8.37

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/server-shared@0.9.7

## 0.8.36

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - @cogitator-ai/server-shared@0.9.6

## 0.8.35

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/server-shared@0.9.5

## 0.8.34

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/server-shared@0.9.4

## 0.8.33

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/server-shared@0.9.3

## 0.8.32

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/server-shared@0.9.2

## 0.8.31

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/server-shared@0.9.1

## 0.8.30

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/server-shared@0.9.0

## 0.8.29

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/server-shared@0.8.1

## 0.8.28

### Patch Changes

- Updated dependencies [[`8b0fd20`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b0fd2045686cba1675b97163ee7fbea88a723f3)]:
  - @cogitator-ai/server-shared@0.8.0

## 0.8.27

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/server-shared@0.7.0
  - @cogitator-ai/core@0.56.4

## 0.8.26

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/server-shared@0.6.6

## 0.8.25

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/server-shared@0.6.5

## 0.8.24

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/server-shared@0.6.4

## 0.8.23

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/server-shared@0.6.3

## 0.8.22

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/server-shared@0.6.2

## 0.8.21

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/server-shared@0.6.1

## 0.8.20

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

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - Tool names are checked where a tool is created. `tool()` (and `fromAISDKTool()` of `@cogitator-ai/ai-sdk`) throws a `TypeError` for a name that one of the providers refuses, naming the rule (letters, digits, `_` and `-`, starting with a letter or `_`, at most 64 characters, the strictest of OpenAI, Anthropic, Gemini and Bedrock) and a name that fits. Such a name used to fail only once a run sent it, as a 400 from the provider, or worked on one provider and broke on the next.

  `assertToolName(name)` throws the same error for tools built without `tool()`. `normalizeToolName(name)` turns any name into one that fits (`weather.get` becomes `weather_get`, a name too long is cut and ends with a hash of the whole one), `normalizeToolNames(names)` does the same for a set and keeps it distinct, `isProviderSafeToolName(name)` checks one, `TOOL_NAME_MAX_LENGTH` is 64. The MCP adapter uses them, `normalizeMCPToolName` gives the same names as before.

  `ToolRegistry.register()` and `registerMany()` warn when a different tool takes a name that is registered, since the model can only call one of them. `{ replace: true }` replaces on purpose without a warning. In a run, a tool of the agent still replaces a tool of the same name in `cogitator.tools` quietly.

  `A2AClient.asToolFromCard()` names the tool after the card in a form providers accept: `Research Agent` becomes `Research_Agent`. A handoff to an agent with a long name gets a `transfer_to_...` tool name cut to fit, with a hash, and handoffs to agents whose names come out the same (`Billing EU` and `Billing/EU`, names in other scripts) get a hash each, so the model can reach every one of them. Tools an agent writes for itself with `create_tool` are refused, and skipped when loaded, when their name breaks the rule.

  **Migration:** a tool whose name breaks the rule now throws when it is created. Rename it, or wrap a name built from data in `normalizeToolName()`. Names with dots or colons that only Gemini accepted are among them.

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

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `message/stream` responses write a `: keep-alive` comment every `sseHeartbeatMs` (a new `A2AServer` option, 5 seconds by default, `0` turns it off) while the run is silent, so a proxy or Bun's idle timeout no longer cuts a run that waits on a slow tool. The Hono adapter now streams through the same code as the other adapters.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A task whose agent run pauses for tool approvals now waits in `input-required` instead of reporting `completed` with the model's text from before the tool call. The agent's message carries the waiting calls in a `tool-approval-request` data part, and the client answers with a `tool-approval-response` data part (`client.answerApprovals(taskId, { decisions })` or `toolApprovalResponsePart()`), which resumes the run through the server Cogitator's `resume()`. `readToolApprovalRequest(task)` reads the waiting calls, and `asTool()` reports them in `pendingApprovals`. `CogitatorLike` gains an optional `resume`, and `AgentRunResult` the `status` and `pendingApprovals` fields.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `A2AServer` and `A2AClient` now speak the A2A protocol v0.3 as specified, so they work with the official A2A SDKs, Google ADK and other v0.3 agents. Every response is checked against the official v0.3.0 JSON schema in the tests, and the official JavaScript SDK client talks to `A2AServer` (and `A2AClient` to an SDK server) in them.

  Breaking changes to the wire format and the API:

  - Parts, messages, tasks and stream events use `kind`. Messages need a `messageId` (`A2AClient` fills it in), file parts nest the file (`{ kind: 'file', file: { uri | bytes } }`), artifacts have `artifactId`, and `status.message` is an agent message instead of a string (`messageText()` reads it). `errorDetails` is gone.
  - Streams send every event as a JSON-RPC response with the request id, start with the task, mark the last status update `final: true` and have no `[DONE]` marker. The reply streams as `artifact-update` chunks (`append`, `lastChunk`) instead of `token` events. A request that fails before the stream starts is answered with a plain JSON-RPC error, and `tasks/resubscribe` reconnects to a running task.
  - The Agent Card is served at `/.well-known/agent-card.json` (the old path stays as an alias) with `protocolVersion`, `preferredTransport`, an absolute `url`, skill `tags`, spec security schemes (`in`, `name`) and `supportsAuthenticatedExtendedCard`. `version` is now the agent version (`agentVersion`, default `1.0.0`) and `provider` takes `{ organization, url }`. Card signatures are JWS (HS256) objects in `signatures`.
  - Every agent of a server has its own endpoint and card under `<basePath>/<agent>`, so any A2A client reaches it. `A2AClient` reads the card and sends requests to the endpoint it names, and with `agentName` uses that agent's own card.
  - Methods follow the specification: `tasks/pushNotificationConfig/{set,get,list,delete}` (configs are `{ url, token, authentication }`, webhooks receive the task with `X-A2A-Notification-Token`) and `agent/getAuthenticatedExtendedCard`. The client methods are `setPushNotificationConfig`, `getPushNotificationConfig`, `listPushNotificationConfigs` and `deletePushNotificationConfig`.
  - New tasks start `submitted`. A task in a terminal state can no longer take a message (`-32600`), carry a conversation on with a new message in its `contextId`, whose earlier tasks the agent now gets as context. `sendMessage` returns the task or a direct reply message.
  - Error codes follow the specification: `-32007` is the extended card error, an unknown agent is `-32602`. Missing or rejected credentials are answered with HTTP 401.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A client can no longer lift or remove the run timeout with `configuration.timeout`. It must be a positive integer on `message/send` and `message/stream` alike, and the server caps it at the agent's own `timeout`, or at the new `maxRunTimeoutMs` option (default `120000`) for an agent without one. Before, `timeout: 0` or `-1` ran without a time limit and a large value outlived the operator's limit.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/server-shared@0.5.0

## 0.7.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0

## 0.7.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0

## 0.7.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2

## 0.7.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
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

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/types@0.31.0

## 0.7.1

### Patch Changes

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0

## 0.7.0

### Minor Changes

- 39bc4a9: The Express, Fastify, Hono and Koa adapters serve JSON-RPC on the server's `basePath` (still `/a2a` by default) instead of always `/a2a`, so the endpoint matches the URL the Agent Cards advertise; `A2AServer.basePath` exposes it and must start with `/`. `A2AClient` takes an `agentName` option that it sends with `message/send`, `message/stream` and `agent/extendedCard`, and `agentCard()` returns that agent's card, so every agent of a multi-agent server is reachable, not only the first.

### Patch Changes

- 39bc4a9: Errors that are neither an `A2AError` nor a `CogitatorError` (a failing task store, auth validator or agent run) no longer reach clients with their text: JSON-RPC answers them with a bare `-32603 Internal error`, failed tasks and stream `failed` events say `Internal error`, and the real error is logged on the server. A2A errors and `CogitatorError` messages are kept.
- e69e30c: `RedisClientLike.scan` now declares the call `RedisTaskStore` makes (`MATCH` / `COUNT`), so an ioredis client is accepted as is; keys SCAN returns twice are listed once.
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
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0

## 0.6.0

### Minor Changes

- 3b35cd8: `auth.validate` may return the caller (`{ userId }`) instead of `true`. Tasks then belong to the user who created them: other users get `Task not found` from `tasks/get`, `tasks/cancel`, the push-notification methods and attempts to continue the task, `tasks/list` returns only the caller's own tasks (`TaskFilter.visibleTo`), a `contextId` holding another user's tasks is refused, and runs carry the `userId` so threads and memory are scoped too. Returning `true` keeps every caller in one shared space as before. The push-notification `get`, `list` and `delete` methods now require the task to exist, like `create`.

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

## 0.5.3

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

## 0.5.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0

## 0.5.1

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

## 0.5.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

## 0.4.0

### Minor Changes

- Resumed the unfinished 2026-07-26 audit at step 4. Critical: no framework adapter passed credentials, so any server configured with `auth` rejected every request. getAuthToken() was added and wired into all 5 adapters, and the auth scheme is now advertised on the agent card. Streaming fixes: artifact events used to be emitted after the terminal status and so never reached SSE clients. input-required streams ended with a fake failure. Listeners leaked on continuation errors. A rejected execution hung the stream. Client disconnects now abort the LLM run through an AbortSignal. Multi-turn tasks now replay the transcript, where before only the newest message was sent, and artifacts accumulate. SendMessageConfiguration is implemented: blocking:false, historyLength, acceptedOutputModes, timeout, and the new pushNotificationConfig. SSRF fixes: 127.0.0.2, CGNAT, IPv6 ULA/link-local, hex IPv4-mapped addresses, DNS rebinding (now pinned at connect time) and redirects. Client fixes: the stream timeout is now an idle timeout (it used to kill streams after 30s), CRLF SSE framing, JSON-RPC errors on non-2xx responses, and asTool. Also: the Redis cjson empty-array corruption, running tasks being evicted, and wrong JSON-RPC error codes.

  **Breaking changes**
  - tasks/pushNotification/create now returns TaskNotFound (-32001) for unknown task ids
  - Structurally invalid JSON-RPC requests now return -32600 Invalid Request instead of -32700
  - Adapters stream only for method message/stream; Accept: text/event-stream no longer turns message/send into SSE
  - JSON-RPC notifications get HTTP 204 with no body
  - Continuations pass threadId (contextId), loadHistory:false and a transcript input to CogitatorLike.run; artifacts accumulate across turns
  - Streams end on input-required; artifact events precede the final status event
  - asTool results may include taskId/state, and output is the latest answer

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.3.12

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

## 0.3.11

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.3.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.3.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.3.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.3.5

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.3.4

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.3.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.3.2

### Patch Changes

- fix(a2a): audit — 37 bugs & security fixes, +78 tests

  Security:
  - Timing-safe HMAC comparison (timingSafeEqual)
  - SSRF protection for webhook URLs (validateWebhookUrl)
  - Canonical JSON serialization for card signing
  - Content-Type validation in all adapters
  - Buffer.from for Unicode-safe Basic auth

  Bugs:
  - structuredClone in InMemoryTaskStore.update()
  - Redis SCAN-based key enumeration (was blocking KEYS)
  - Redis mget batch fetch for list operations
  - TTL validation at RedisTaskStore construction
  - SSE multi-line data parsing per spec
  - Race condition fix in streaming (listener before task)
  - Streaming message validation
  - Client agentCard() throws on empty response
  - extractOutputFromTask guards for undefined fields

  Features:
  - allowPrivateUrls config option for local dev/testing
  - InMemoryPushNotificationStore.cleanup() method

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.3.0

### Minor Changes

- Add push notifications, Agent Card signing, and production persistence
  - Push notifications with webhook delivery and HMAC verification
  - Extended Agent Card with authenticated access and capability negotiation
  - Agent Card cryptographic signing and verification
  - RedisTaskStore for production task persistence
  - Token-level streaming in SSE responses

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.2.0

### Minor Changes

- 320fe4d: Add @cogitator-ai/a2a — native A2A Protocol v0.3 implementation

  First TypeScript agent runtime with native Google A2A support.
  Zero external dependencies, own implementation from spec.
  - A2AServer: expose any Cogitator Agent as A2A-compliant service
  - A2AClient: connect to remote A2A agents with discovery and streaming
  - asTool() bridge: wrap remote A2A agents as local Cogitator tools
  - Agent Card auto-generation from Agent metadata
  - Task lifecycle management with pluggable TaskStore
  - JSON-RPC 2.0 over HTTPS with SSE streaming
  - Framework adapters: Express, Hono, Fastify, Koa, Next.js
  - 119 tests, 1500 lines of production code
