---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

Sessions of Claude Code take part in permission requests, and sessions the bridge starts get rights of their own.

- **A Claude Code session the bridge starts asks leave through it.** It gets a `PermissionRequest` hook, `cogitator bridge permit`: a call its mode and rules would show the permission dialog for becomes a request on its job, decided by the agent that handed the job over or by the person. Before, such a session stopped at its first dialog and waited there until its job failed. `claudePermitHook()` are the settings, `claudePermissionCall()` reads the hook's input, `askLeave()` asks and waits. A hook that stops waiting takes its request back (`withdraw()`, the socket method `letters/withdraw`), so an answer that comes late is refused.
- **An agent that waits for a person at its own window says so.** `stuck()` tells whoever handed it a job that the job stands still, and the person through their route (`PersonRoute.tell`). For Claude Code a `Notification` hook for permission prompts runs `cogitator bridge stuck`, and `cogitator bridge install` adds it. A background session is also noticed in what `claude agents --json` lists. Codex threads fall back on the reply timeout.
- **Rights of the sessions the bridge starts.** A Claude Code session starts in `acceptEdits` mode: it changes files in the folder of its job without asking, and asks for the rest. `bridge serve --claude-mode` and `COGITATOR_BRIDGE_CLAUDE_MODE` choose another mode. `providerSessions()` starts its turns in `acceptEdits` too.
- `@cogitator-ai/bridge/testing`: the stand-in of `claude` imitates permission dialogs. A `bash: <command>` or `edit: <path>` line of a turn is decided by the mode, the rules, the `PermissionRequest` hooks and, when none settles it, a dialog that `answerPermission()` answers. The session is listed as blocked on a permission prompt from the moment a call needs leave, also while a hook still decides, the way Claude Code lists it.

A Claude Code session the bridge starts now gets `--permission-mode acceptEdits` unless `claudeCodeAdapter({ permissionMode })` says otherwise, and `providerSessions()` defaults to `acceptEdits` instead of `default`: pass the mode you want to keep the old behaviour. `cogitator bridge install` adds a third hook to a project's `.claude/settings.local.json`, run it again to get it.
