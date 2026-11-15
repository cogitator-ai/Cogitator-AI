---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

The agent bridge (experimental): Claude Code, Codex and other agents hand each other jobs, ask questions on the way and report back, each staying in its own window. Nobody waits: a job is handed over, its number comes back at once, and whatever comes later arrives as a letter.

New package `@cogitator-ai/bridge` with the core of it:

- **A dispatcher, not a model.** `BridgeDispatcher` keeps jobs, letters and the address book, finds who a letter is for and applies the limits. It never calls a model. One runs per machine and serves every project: `hostBridge()` opens the store, takes its lease and serves a unix socket (a named pipe on Windows), and `BridgeClient` talks to it.
- **Jobs are A2A tasks.** A job runs on the `TaskManager` of `@cogitator-ai/a2a`: `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, plus whether its checks confirmed the result (`recordVerification`). It carries who handed it over, who carries it out, the project, the folder, a worktree, checks, a budget and its depth.
- **Letters.** A `task`, `question`, `answer`, `report`, `note` or `permission` request, moving `queued`, `delivered`, `read`, `handled`. A letter sent again under the same id is not delivered twice. Every letter starts with a line saying which job it belongs to and who wrote it, since in a harness window it looks like the user typed it.
- **An address book.** A session registers itself from what its harness put in the environment (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`) and is reached by name: `codex` for the only Codex session of the project, `codex:reviewer` for one of several, `codex:new` for a fresh one.
- **Limits.** Jobs nest three deep at most, a job has a budget of letters and time, a letter that repeats the previous one is held back, and a letter nobody reacts to gets a reminder and then fails the job.
- **A journal.** Every letter, delivery and change of a job is appended to a journal the database keeps from being changed.
- **One writer.** Which dispatcher owns the store is decided by the store: a lease taken in a transaction and checked inside every write. The second dispatcher to start is refused, one whose process is gone is replaced at once.
- **Adapters.** `BridgeAdapter` is how the bridge reaches the sessions of a harness: push a letter, start a session for a job. Without one a session reads its inbox itself.

In the CLI:

- `cogitator bridge serve` runs the dispatcher, `cogitator bridge status` shows it with its sessions and jobs, `cogitator bridge log [--job N] [--follow]` reads the journal.
- `cogitator daemon start|restart|install --bridge` makes the assistant daemon host the dispatcher too.

The state is kept in SQLite: install `better-sqlite3` next to `@cogitator-ai/bridge` (the CLI already has it).
