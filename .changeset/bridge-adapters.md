---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

The agent bridge reaches sessions where they live: adapters for Claude Code, Codex and for agents the bridge hosts itself.

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
