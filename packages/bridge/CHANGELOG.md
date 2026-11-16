# @cogitator-ai/bridge

## 0.4.0

### Minor Changes

- [#362](https://github.com/cogitator-ai/Cogitator-AI/pull/362) [`b108f58`](https://github.com/cogitator-ai/Cogitator-AI/commit/b108f5808a94769e3bfb8b657735ebed0747cc9c) - Agents call the bridge with tools of their own, and `cogitator bridge install` sets Claude Code and Codex up.

  - **Tools**: `bridgeTools()` in the new `@cogitator-ai/bridge/tools` entry are the bridge as tools of an agent: `delegate`, `ask`, `answer`, `report`, `note`, `inbox`, `job`, `jobs`, `cancel` and `agents`. None waits for another agent. `cogitator bridge mcp` serves them over MCP with `BRIDGE_INSTRUCTIONS`, which say how the tools go together and whose a letter of the bridge is.
  - **Sandboxes**: a harness runs a server of tools outside the sandbox of its session, so a Codex thread in `workspace-write` or `read-only` asks, answers and reports where its shell commands cannot reach the bridge's socket. The tools say they destroy nothing and stay on this machine, so Codex runs them without an approval.
  - **Which session calls** is read from every tool call, not once: the thread Codex names in `_meta`, or for Claude Code, which keeps one server across `/clear`, the session a `PreToolUse` hook adds to the arguments (`cogitator bridge caller`, `claudeToolsHook()`).
  - **Sessions the bridge starts** get the tools with them: pass `toolsServer` to `claudeCodeAdapter()` and `codexAdapter()`. `bridge serve` and `daemon start --bridge` do.
  - **Setup**: `cogitator bridge install [claude|codex|all]` lists every change and makes them after a yes: the server of tools, the hooks and the rule for the tools in the project's `.claude/settings.local.json`, the notes in `CLAUDE.md` and `AGENTS.md`. `--user`, `--take-jobs`, `--no-notes`, `--no-allow`, `--dry-run`, `--yes`. `cogitator bridge uninstall` takes it out again. `claudeSetup()` and `codexSetup()` are the same as steps to show and apply.
  - **Doctor** shows whether the sessions of a folder have the tools and the hook that names them.
  - `bridge wait --tools` tells a woken session to reply with the tools. A folder of the bridge that is not the default one is written into the command of the server and the hooks.
  - `@cogitator-ai/bridge/testing`: the stand-ins of `claude` and `codex` run MCP servers the way the real ones were measured to, and keep the commands of a sandboxed Codex thread from sockets and from writing outside its folder.

  `DispatcherStatus` has a new `startable` field and `FakeTurn` a new `tools` field: code that builds either by hand adds them. `@cogitator-ai/bridge/tools` needs `@cogitator-ai/core`, an optional peer of the package.

## 0.3.0

### Minor Changes

- [#357](https://github.com/cogitator-ai/Cogitator-AI/pull/357) [`0ceef78`](https://github.com/cogitator-ai/Cogitator-AI/commit/0ceef7830a095120438e9de551177078da83a599) - The agent bridge reaches sessions where they live: adapters for Claude Code, Codex and for agents the bridge hosts itself.

  - **Claude Code**: `claudeCodeAdapter()` starts a background session for a job (`claude --bg`) after checking that Claude Code trusts the folder. A session wakes for its mail through a hook of its own: after every turn a background `Stop` hook waits at the bridge (`cogitator bridge wait`) and wakes the session with the letter, so the session stays free to talk to. `claudeWaitHook()` is the hook for the sessions you open yourself.
  - **Codex**: `codexAdapter()` hands letters to the queue of a thread (`codex queue --resume`) and starts threads with `codex exec`. A letter queued while no Codex daemon runs is noted in the journal with the command that starts it, the bridge never starts it. A thread the bridge starts works in the `workspace-write` sandbox and cannot reach the bridge from there, so the bridge reports its final answer for it. `bridge serve --codex-sandbox` or `COGITATOR_BRIDGE_CODEX_SANDBOX` names another sandbox.
  - **Hosted agents**: `hostedAdapter()` runs sessions in the host. `cogitatorSessions()` hosts an agent of the runtime on any model, with steering in the middle of a turn, `providerSessions()` an agent behind a session provider such as `AcpAgentProvider`, bound to the folder it works in. The agent's answer is the job's report, a canceled job stops its run, and a run that pauses for an approval fails its job.
  - **Waiting for mail**: `BridgeDispatcher.wait()`, `BridgeClient.wait()` and `waitForMail()` resolve the moment a letter is queued for a session. A letter stays queued until `delivered()` confirms it.
  - **Presence**: a session its harness lists as running is not retired for being silent, and one that was listed and is missing two checks in a row fails its jobs then, not after the reply timeout.
  - **Adapter port**: `deliver` is optional and may return a note for the journal, and an adapter can add `identify`, `liveSessions`, `health`, `attach` and `close`. The port types moved to their own module and are still exported from the package root.
  - **`@cogitator-ai/bridge/testing`**: `adapterConformanceCases()` is the adapter contract as test cases, `installFakeHarnesses()` puts stand-ins of the `claude` and `codex` commands on a `PATH`.
  - **CLI**: `cogitator bridge doctor` checks the dispatcher and both harnesses and says what to fix, `bridge wait` is what a wake hook runs, `bridge delegate`, `bridge send`, `bridge inbox` and `bridge cancel` call the bridge from inside a session. `bridge serve` and `daemon start --bridge` run the Claude Code and Codex adapters.
  - Folders are compared by their real path, so a project reached through a symlink is one project. `CLAUDE_CONFIG_DIR` is honored.
  - A letter with a NUL character is refused: no harness can be handed one.

  `DispatcherStatus` has a new `waiting` field and `BridgeLimits` a new `presenceCheckMs`: code that builds either by hand adds them.

## 0.2.0

### Minor Changes

- [#356](https://github.com/cogitator-ai/Cogitator-AI/pull/356) [`531fc88`](https://github.com/cogitator-ai/Cogitator-AI/commit/531fc881e170d3420892f9a1246bea4e79dd6b16) - The agent bridge (experimental): Claude Code, Codex and other agents hand each other jobs, ask questions on the way and report back, each staying in its own window. Nobody waits: a job is handed over, its number comes back at once, and whatever comes later arrives as a letter.

  New package `@cogitator-ai/bridge` with the core of it:

  - **A dispatcher, not a model.** `BridgeDispatcher` keeps jobs, letters and the address book, finds who a letter is for and applies the limits. It never calls a model. One runs per machine and serves every project: `hostBridge()` opens the store, takes its lease and serves a unix socket (a named pipe on Windows), and `BridgeClient` talks to it.
  - **Jobs are A2A tasks.** A job runs on the `TaskManager` of `@cogitator-ai/a2a`: `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, plus whether its checks confirmed the result, which only the process hosting the dispatcher can record (`recordVerification`), never an agent over the socket. It carries who handed it over, who carries it out, the project, the folder, checks, a budget and its depth.
  - **Letters.** A `task`, `question`, `answer`, `report`, `note` or `permission` request, moving `queued`, `delivered`, `read`, `handled`. A letter sent again under the same id is not delivered twice. Every letter starts with a line saying which job it belongs to and who wrote it, since in a harness window it looks like the user typed it.
  - **An address book.** A session registers itself from what its harness put in the environment (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`) and is reached by name: `codex` for the only Codex session of the project, `codex:reviewer` for one of several, `codex:new` for a fresh one. A session that has been silent for 12 hours with no job in progress is taken for gone, and is back the moment it calls again.
  - **Limits.** Jobs nest three deep at most, a job has a budget of letters and time, a letter that repeats the previous one is held back, and so is a job the same agent already has. An agent has 20 jobs out and hands over 60 an hour at most. A letter nobody reacts to gets a reminder and then fails the job, and a job that is over takes the jobs handed over from inside it along.
  - **A signature nobody can fake.** Only the first line of a letter is a signature: a title cannot add fields to it, a body line that looks like one is quoted, and what the bridge repeats of an agent's words is quoted too.
  - **A journal.** Every letter, delivery and change of a job is appended to a journal the database keeps from being changed.
  - **One writer.** Which dispatcher owns the store is decided by the store: a lease taken in a transaction and checked inside every write. The second dispatcher to start is refused, one whose process is gone is replaced at once.
  - **Adapters.** `BridgeAdapter` is how the bridge reaches the sessions of a harness: push a letter, start a session for a job. Without one a session reads its inbox itself.

  In the CLI:

  - `cogitator bridge serve` runs the dispatcher, `cogitator bridge status` shows it with its sessions and jobs, `cogitator bridge log [--job N] [--follow]` reads the journal.
  - `cogitator daemon start|restart|install --bridge` makes the assistant daemon host the dispatcher too. A restart keeps it, `restart --no-bridge` stops it.

  The state is kept in SQLite: install `better-sqlite3` next to `@cogitator-ai/bridge` (the CLI already has it).

### Patch Changes

- Updated dependencies [[`5456d74`](https://github.com/cogitator-ai/Cogitator-AI/commit/5456d7425d4e846041d8d4b015fb0b0c22926b94)]:
  - @cogitator-ai/a2a@0.12.0
