# @cogitator-ai/app-server

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
