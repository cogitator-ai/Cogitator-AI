# @cogitator-ai/app-server

## 0.3.1

### Patch Changes

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

- Updated dependencies [[`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c), [`25087c3`](https://github.com/cogitator-ai/Cogitator-AI/commit/25087c3b0cac1340a9a3a9d9823045ed0c5a580c)]:
  - @cogitator-ai/server-shared@0.17.0
  - @cogitator-ai/types@0.89.0
  - @cogitator-ai/core@0.78.0

## 0.3.0

### Minor Changes

- [#317](https://github.com/cogitator-ai/Cogitator-AI/pull/317) [`ac89cec`](https://github.com/cogitator-ai/Cogitator-AI/commit/ac89cec9ea8d288afd58f7dbbe1531f8425d757a) - The Agent Client Protocol, both ways: Cogitator agents now work inside Zed, JetBrains, Neovim, VS Code and every other ACP editor, and Claude Code, Codex, Gemini CLI or any agent of the ACP registry can run as an agent of your own app-server.

  New package `@cogitator-ai/acp`, built on the official SDK `@agentclientprotocol/sdk` (ACP v1):

  - `createAcpAgent({ host, cogitator })` serves the agent of an app-server `SessionHost` to an editor, `serveAcpStdio()` over stdio. A thread is an ACP session: `session/new`, `load` (replaying the conversation), `resume`, `list`, `close`, `delete`, `set_mode`, `set_config_option` and `prompt` and `cancel` all map onto the host. `initialize` offers an auth method, which the ACP registry asks of its agents.
  - The turn streams as `session/update`: message and thought chunks, tool calls with a title from the tool's presentation, their kind, the files they touch, the diff of an edit and the terminal a command ran in, the plan from `write_todos`, the session's title, and compaction notices (`compaction_update`, a notice or a thought, as the editor takes them).
  - Tool approvals ask with `session/request_permission`, with the diff of an edit in the question. `allow_always` and `reject_always` save the rule the request suggests as an allow or a deny rule. A plan of `plan` mode is approved in the editor ("Ready to code?"), a budget raised, and the questions of tools are asked as forms (`elicitation/create`) or answered by the next prompt.
  - Configuration options for the permission mode, the model and the reasoning effort, next to the session modes. The `/` menu lists the runtime's commands and the agent's `SKILL.md` skills.
  - `AcpClientWorkspace` is a `Workspace` over the editor: files read and written through `fs/*`, so the agent sees unsaved changes and the editor follows its edits, commands run in the editor's `terminal/*`, each as the editor advertised it, everything else and every path check on the session's directory. The MCP servers the editor gives a session connect through `MCPClient`.
  - `AcpAgentProvider` runs an external ACP agent as a session provider: a command it launches (`resolveAcpAgent()` knows `claude`, `codex`, `gemini`, `registry:<id>` and command lines) or an `AgentApp` in the process. Each thread is a session of the agent, kept across launches. Its `session/update` stream becomes stream events, so app-server clients see its turns as any other. Every `session/request_permission` is decided by `resolvePermission` in the thread's mode, a command as `run_command`, an edit as `edit_file`, its own tools as `acp__<agent>__<tool>`, and what would ask goes to the client of the turn. Its file and terminal requests are served from the provider's workspace with the same checks.
  - `registry/cogitator/` holds the card of `cogitator acp` for the ACP registry, ready to submit.

  App-server:

  - `SessionHost` takes `providers`, agents that run outside the runtime (`SessionProvider`), next to `agents`. `initialize` lists them with `external: true`. The host keeps their threads, messages and turns, their threads cannot be forked, rewound or reviewed and their turns take no steering.
  - `startTurn()` takes `run`: the workspace, reasoning and middleware of the turn, an agent made from the thread's, and listeners of the todo list and the tool results. `runOptions` passes options to every run, `updateThread()`, `getThread()` and `deleteThread()` are new.
  - `approval/request` offers `reject_always`, and a decision of a paused turn takes `remember` on a rejection too.

  CLI:

  - `cogitator acp` serves the `coding` harness agent to the editor that launches it, on the model of `-m`, the config or a local Ollama, the sessions in the session store. `--models` adds models a session may pick, `--trust` trusts the project, so its own definitions and allow rules apply and "always" answers are saved to `.cogitator/settings.local.json`. It starts without a model too, and `authenticate` then says how to set one up.
  - `cogitator app-server --acp-agent <spec...>` serves external ACP agents next to the agent.

  Runtime:

  - An approval that rejects with `remember` ("always reject") saves the suggested rule as a deny rule, for the session or to a settings file as "always allow" does, and the decision event says so with `remembered.behavior`. `addPermissionRule()` writes allow and deny rules, `skillLoadersOf()` is exported.

### Patch Changes

- Updated dependencies [[`ac89cec`](https://github.com/cogitator-ai/Cogitator-AI/commit/ac89cec9ea8d288afd58f7dbbe1531f8425d757a)]:
  - @cogitator-ai/core@0.77.0
  - @cogitator-ai/types@0.88.0
  - @cogitator-ai/server-shared@0.16.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`e2f1c87`](https://github.com/cogitator-ai/Cogitator-AI/commit/e2f1c8793df4d1fdb06e9d8a5d0e8be984cbd2d2)]:
  - @cogitator-ai/types@0.87.0
  - @cogitator-ai/core@0.76.0
  - @cogitator-ai/server-shared@0.16.1

## 0.2.0

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
  - @cogitator-ai/server-shared@0.16.0
  - @cogitator-ai/core@0.75.0
  - @cogitator-ai/types@0.86.0
