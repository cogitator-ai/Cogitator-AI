---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

Agents call the bridge with tools of their own, and `cogitator bridge install` sets Claude Code and Codex up.

- **Tools**: `bridgeTools()` in the new `@cogitator-ai/bridge/tools` entry are the bridge as tools of an agent: `delegate`, `ask`, `answer`, `report`, `note`, `inbox`, `job`, `jobs`, `cancel` and `agents`. None waits for another agent. `cogitator bridge mcp` serves them over MCP with `BRIDGE_INSTRUCTIONS`, which say how the tools go together and whose a letter of the bridge is.
- **Sandboxes**: a harness runs a server of tools outside the sandbox of its session, so a Codex thread in `workspace-write` or `read-only` asks, answers and reports where its shell commands cannot reach the bridge's socket. The tools say they destroy nothing and stay on this machine, so Codex runs them without an approval.
- **Which session calls** is read from every tool call, not once: the thread Codex names in `_meta`, or for Claude Code, which keeps one server across `/clear`, the session a `PreToolUse` hook adds to the arguments (`cogitator bridge caller`, `claudeToolsHook()`).
- **Sessions the bridge starts** get the tools with them: pass `toolsServer` to `claudeCodeAdapter()` and `codexAdapter()`. `bridge serve` and `daemon start --bridge` do.
- **Setup**: `cogitator bridge install [claude|codex|all]` lists every change and makes them after a yes: the server of tools, the hooks and the rule for the tools in the project's `.claude/settings.local.json`, the notes in `CLAUDE.md` and `AGENTS.md`. `--user`, `--take-jobs`, `--no-notes`, `--no-allow`, `--dry-run`, `--yes`. `cogitator bridge uninstall` takes it out again. `claudeSetup()` and `codexSetup()` are the same as steps to show and apply.
- **Doctor** shows whether the sessions of a folder have the tools and the hook that names them.
- `bridge wait --tools` tells a woken session to reply with the tools. A folder of the bridge that is not the default one is written into the command of the server and the hooks.
- `@cogitator-ai/bridge/testing`: the stand-ins of `claude` and `codex` run MCP servers the way the real ones were measured to, and keep the commands of a sandboxed Codex thread from sockets and from writing outside its folder.

`DispatcherStatus` has a new `startable` field and `FakeTurn` a new `tools` field: code that builds either by hand adds them. `@cogitator-ai/bridge/tools` needs `@cogitator-ai/core`, an optional peer of the package.
