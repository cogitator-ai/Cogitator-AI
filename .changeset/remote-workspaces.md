---
'@cogitator-ai/sandbox': minor
'@cogitator-ai/types': minor
'@cogitator-ai/core': patch
---

Remote workspaces: an agent's whole workspace, files and commands, in a cloud sandbox on E2B, Daytona or Vercel Sandbox, with the same behavior on every provider.

- `E2BWorkspace`, `DaytonaWorkspace` and `VercelSandboxWorkspace` (sandbox) create their sandbox on first use, or reuse one by `sandboxId`, `sandbox` (id or name) or `name`, and release it in `dispose()` as `onDispose` says: `destroy`, `stop` (Daytona, Vercel) or `keep`. Their SDKs (`e2b`, `@daytona/sdk`, `@vercel/sandbox`) are optional peer dependencies loaded on first use. Without the SDK, without credentials (`E2B_API_KEY`, `DAYTONA_API_KEY`, `VERCEL_OIDC_TOKEN` or `VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`) or when the sandbox cannot be created, the first operation fails with a `WorkspaceError` of code `UNAVAILABLE` that says which.
- `RemoteShellWorkspace` (sandbox) is what they share, over a small `RemoteShellDriver` (connect, read and write bytes, run a program, start one with streamed output and stdin, release), so another provider is one driver away. Everything else runs as shell scripts in the sandbox: paths normalized against the root and resolved with `realpath -m`, so a symlink out of the root is refused with `OUTSIDE_ROOT`, atomic writes that keep the file's mode, `maxFileBytes`, listings sorted like `LocalWorkspace` with `includeHidden`, `skipDirs`, `glob` and `limit`, the trash in `.cogitator/trash`, the `rename` rules for `overwrite`, and `BUSY` while a command runs or kept background processes. Commands run under `setsid` in their own process group, reported with marker lines whose token comes on stdin: a timeout returns exit code 124 and kills the group, an abort rejects with `ABORTED`, `background: 'keep'` leaves background processes until `dispose()`.
- Remote workspaces implement snapshots: `snapshot({ label, metadata, exclude })`, `restore(id)`, `listSnapshots()` and `deleteSnapshot(id)` keep tar archives in `.cogitator/snapshots` inside the sandbox, `.cogitator/**` left out by default, and a restore removes what was made since and leaves the excluded paths alone.
- `shellQuote` and `shellCommand` (sandbox) build a shell line that passes every argument as it is, quotes, newlines, globs and leading dashes included.
- `workspaceGlobMatcher` (types) is the glob matcher of `WorkspaceListOptions.glob`, now shared by every workspace. `LocalWorkspace` and `workspaceTools` (core) use it, with no change in what they match.
