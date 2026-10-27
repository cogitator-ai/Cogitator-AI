---
'@cogitator-ai/types': minor
'@cogitator-ai/sandbox': minor
'@cogitator-ai/core': minor
---

Local commands inside the operating system's sandbox, and deletions an agent can take back.

OS sandbox (sandbox, types):

- `OsSandbox` runs a workspace's commands under Seatbelt (`sandbox-exec` with a generated profile) on macOS and bubblewrap (`bwrap --unshare-net --unshare-pid --die-with-parent --new-session`, with `socat` bridging the proxy) on Linux, with the semantics of Claude Code's sandboxed Bash tool. Writes only in the workspace root, `filesystem.allowWrite` and a temporary directory of its own (`TMPDIR`), never in the protected paths (settings, hooks, skills, agents, commands and plugins of `.claude` and `.cogitator` in the root and above, `~/.claude`, `~/.cogitator`, `~/.claude.json`, the root's `.cogitator`, `.mcp.json`, shell startup files, `.gitconfig`, `.gitmodules`, `.vscode`, `.idea`, the repository's `.git/hooks` and `.git/config`, and a `HEAD` at the root so no command makes it a bare repository), a symlink at a protected path closing its target too. Reads everywhere but `filesystem.denyRead`, the narrower of a deny and an allow winning. `credentials.envVars` and `credentials.files` hide secrets.
- Network only through an in-process HTTP `CONNECT` and SOCKS5 proxy for each command: `deniedDomains` wins, then `allowedDomains` (`host`, `*.domain`, `*`, IPv4, bracketed IPv6, optional `:port`), then the hosts the call lists for itself, then a decider (`onUnknownHost` of the call, else of the sandbox), else refused. A host name resolving only to loopback, link-local, a cloud metadata endpoint or an address of this machine is refused, `localhost` aside, and the address that passed is the one dialed. `strictAllowlist` refuses unknown hosts and per-command lists.
- Proxy refusals and the file accesses the system refused are attributed to the command, in `result.sandbox.violations` and a sanitized `<sandbox_violations>` block appended to its stderr. `ignoreViolations` silences expected ones.
- `failIfUnavailable` (default true) fails with `SANDBOX_UNAVAILABLE` and the reason instead of running unprotected, `excludedCommands` (Bash rule patterns, every command of the line must match, redirections, `cd` and substitutions stay sandboxed) and an honored `dangerouslyDisableSandbox` (only with `allowUnsandboxed`, default false) run outside it, and each result says how its command ran.
- The `SandboxManager` has an `os` type (`SandboxConfig.os` is its policy, `isOsAvailable()`), with no fallback: `allowNativeFallback` keeps applying to Docker only, as before.
- New types: `OsSandboxPolicy` and its parts, `OsSandboxKind`, `OsSandboxAvailability`, `SandboxViolation`, `SandboxHostRequest`, `SandboxHostDecider`, `WorkspaceSandbox`, `WorkspaceCommandSandbox`, `WorkspaceSandboxRoute`, `WorkspaceExecSandbox`, `WorkspaceLaunch` (moved from core, still exported there), `WorkspaceLaunchOverride`, `WorkspaceLaunchReport`, `SandboxSettingsFile`. `SandboxType` gained `os`, `PermissionDecider` gained `sandbox`.

Workspace and permissions (core):

- `LocalWorkspace` takes `exec.sandbox`, checked when the workspace starts (code `UNAVAILABLE`, caused by `SANDBOX_UNAVAILABLE`) and exposed as `workspace.sandbox`. `exec.launch` may now return a promise, a whole environment and a `cleanup(result)` whose report sets `result.sandbox` and appends to stderr. The old synchronous `{ file, args }` form works as before.
- `exec()` takes `dangerouslyDisableSandbox`, `allowedDomains` and `onUnknownHost`, and `run_command` takes `allowedDomains` and `dangerouslyDisableSandbox` from the model.
- A command that runs in the workspace's sandbox skips `run_command`'s own approval and a bare `Bash` ask rule (`decidedBy: 'sandbox'`, also in a run without permission setup). Deny rules, ask rules with a pattern, plan mode, the guardrails, commands with a variable in front, `eval` or `make X=y`, and commands that list hosts of their own keep the normal flow.
- A host a sandboxed command connects to that no list decides is decided as a `WebFetch(domain:...)` call: rules first, `bypassPermissions` allows, `auto` and `dontAsk` refuse, other modes ask a person through `onApproval`, and an allowed host stays allowed for the session (`ToolPermissionsView.decideHost`, `allowHost`).
- `loadSandboxPolicy(root)` reads the `sandbox` section of Claude Code's settings files as they are (lists merged across layers, booleans from the highest, managed locks such as `allowManagedDomainsOnly`, `allowManagedReadPathsOnly` and the admin-required sandbox applied, `Edit`, `Read` and `WebFetch(domain:...)` rules added), `sandboxPolicyOf(layers)` merges layers yourself. `readPermissionLayer` now also returns a layer for a file with only a `sandbox` section.
- RT24: `listTrash()`, `restoreFromTrash(id, { to, overwrite })` and `emptyTrash({ olderThan })` on `LocalWorkspace` (a record per trashed entry, older entries listed by their folder) and `DockerWorkspace` (through its host), and a `delete_file` workspace tool that always moves to the trash.

Behavior changes:

- `rm` and `rmdir` of a critical path (the workspace root or above it, `~`, `/`, `.git`, a path the shell expands, a wildcard over those) now ask in every permission mode, `bypassPermissions` and `acceptEdits` included, over any allow rule. A removal outside the workspace by a command without a sandbox, and `file_delete` of a path outside it, now ask in every mode but `bypassPermissions`.
- `workspaceTools()` returns `delete_file` too (an edit, so it asks in `default` mode unless allowed), and harness agents get it.
- Deviations from Claude Code, on the safe side: `failIfUnavailable` defaults to true once the sandbox is enabled, `allowUnsandboxedCommands` to false. Not supported and left out with a warning: TLS termination and credential masking (a `mask` entry is denied instead), custom proxy ports, the weaker isolation switches, Apple Events. A shell `rm` deletes for good, the trash is `delete_file`'s.
