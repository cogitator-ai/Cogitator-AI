---
'create-cogitator-app': minor
---

The scaffolder is rebuilt on a spec and feature modules. Pick one of 16 presets or the stack itself with flags (`--app`, `--server`, `--channels`, `--memory`, `--vector-store`, `--features`, `--deploy`, `--agent`), see everything with `--dry-run --json`, and get a project with a registry of its agents in `src/cogitator.ts`, three working tools, tests on a mocked model, CI, Biome, a Zod env schema, `AGENTS.md` with the docs bundled for coding agents, Cogitator Studio (`dev:studio`) and, with `--deploy`, a production Dockerfile. Combinations that cannot work are refused before anything is written. `--example <name>` starts from an example of the repository and `--template github:owner/repo/path#ref` from a GitHub template. `--agent claude|cursor|codex` configures the `cogitator` MCP server and a skill. The programmatic `planProject()` and `scaffold(spec, options)` replace the old `scaffold(options)`, and `planAdd()` / `addToProject()` power `cogitator add`. Scaffolding sends one anonymous telemetry event, off with `--no-telemetry`, `COGITATOR_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, in CI and on `--dry-run`.

Generated projects with pnpm 11 install in CI: the native builds a project needs are allowed and the optional ones (`cpu-features`, `protobufjs`, `ssh2`) declined in `pnpm-workspace.yaml`, so `ERR_PNPM_IGNORED_BUILDS` no longer fails the install. A channels project keeps its gateway in `src/gateway.ts`, so `cogitator assistant`, `cogitator build` and `cogitator daemon` run it as before.

`planAdd()` reports `removedDependencies`, and `changesDependencies(plan)` says whether an addition needs an install in either direction.

**Breaking:** the programmatic API changed.

- `scaffold(options)` is now `scaffold(spec, options)`: build the spec with `parseSpec()` or pass a `ProjectSpecInput`, and `planProject(spec)` shows the plan without writing.
- Removed: `parseArgs`, `collectOptions`, `getTemplate`, `templateChoices`, `devCommand`, `defaultModels`, `providerConfig` and the types `ProjectOptions`, `Template`, `TemplateFile`, `ScaffoldStep`. Use `PRESETS`, `findPreset()`, `defaultModel()`, `PROVIDERS` and the other catalogs instead.
- The old template names keep working as `--template` and `--preset` values. Projects created before are not touched.
