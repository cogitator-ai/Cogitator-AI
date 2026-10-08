# create-cogitator-app

## 0.6.1

### Patch Changes

- [#151](https://github.com/cogitator-ai/Cogitator-AI/pull/151) [`90a5055`](https://github.com/cogitator-ai/Cogitator-AI/commit/90a50551e802a308655b46ad50547856f1e420cd) - The install runs with the package manager that launched the scaffolder, from the `npm_execpath` it sets, and falls back to the one on PATH. A pnpm started by its full path or as a standalone binary, which is not on PATH, failed the install with "pnpm is not installed". `cogitator add` installs the same way.

- [#151](https://github.com/cogitator-ai/Cogitator-AI/pull/151) [`6ff6a3f`](https://github.com/cogitator-ai/Cogitator-AI/commit/6ff6a3f8a2b6a617bc04007ff46908e30c81cc2f) - pnpm projects decline the build of better-sqlite3 unless a feature needs it. Every project gets better-sqlite3 through `@cogitator-ai/cli`, and pnpm 11.0 failed the install over its build nobody approved (`ERR_PNPM_IGNORED_BUILDS`). better-sqlite3 ships prebuilt binaries, so the build is not needed. SQLite memory and the assistant harness still allow it.

- [#151](https://github.com/cogitator-ai/Cogitator-AI/pull/151) [`398426b`](https://github.com/cogitator-ai/Cogitator-AI/commit/398426b3fb620937e94535c3a66e18b1fb330b38) - `sendTelemetry` sends nothing for a payload that is not exactly an event: the documented fields and no other, each a short value of letters, digits and `._,-`. It is exported, so a JavaScript caller could hand it anything, and analysis sandboxes that call every export with test values sent them to the project's analytics.

## 0.6.0

### Minor Changes

- [#150](https://github.com/cogitator-ai/Cogitator-AI/pull/150) [`73237de`](https://github.com/cogitator-ai/Cogitator-AI/commit/73237de96e86412051697491c8109a5887eb564a) - The telemetry event of a failed scaffold says where and why it failed. `failedStep` is `create` (the options, the directory, downloading or writing files) or `install`, and `errorCode` is the code it failed with: the package manager's own from a closed set of known codes (`ERR_PNPM_NO_MATCHING_VERSION`, npm's `ETARGET`, Yarn's `YN0035`, a code for the messages of Bun and Yarn 1, `ERR_PNPM_OTHER` or `NPM_OTHER` for any other, since install scripts print into the same output), a Node network or file system code (`ENOTFOUND`), or the scaffolder's (`DIRECTORY_NOT_EMPTY`, `HTTP_404`). Both are `none` on success. The event never holds the error message or the install output, which can contain paths and package names.

  An `--example` or `--template` whose install failed was counted as a success. It is a failure now, like a generated project.

  In the library, `payloadFor(spec, failure?, kind)` takes a `ScaffoldFailure` (`{ step, error }`) in place of the outcome, and `installFailure(result)` gives the one of a scaffold whose install failed. `telemetryErrorCode`, `installErrorCode` and `CodedError`, the error with a code the scaffolder throws, are exported too.

## 0.5.2

### Patch Changes

- [#148](https://github.com/cogitator-ai/Cogitator-AI/pull/148) [`559e443`](https://github.com/cogitator-ai/Cogitator-AI/commit/559e44375cbf18ae9f0d3d018155e5a237f85d27) - Telemetry events reach Umami. The event's User-Agent ended in `Node/<major>`, which Umami's bot filter takes for a server client, so every event was answered with 200 and dropped. The Node version stays in the event data, and the platform is written the way browsers do, so Umami also shows the OS.

## 0.5.1

### Patch Changes

- [#146](https://github.com/cogitator-ai/Cogitator-AI/pull/146) [`c08bd77`](https://github.com/cogitator-ai/Cogitator-AI/commit/c08bd77e37789ed261d055061c560672a09d98c3) - Projects created with 0.5.0 pinned `@cogitator-ai/cli` 0.5 and `@cogitator-ai/core` 0.34, the versions of the release before it, because the scaffolder was built before the version bump. `npm run dev:studio`, `npm run doctor`, `cogitator add` and `cogitator mcp` failed with an unknown command. New projects pin the current packages again, and the scaffolder reports its own version. A project created with 0.5.0 works again once its `@cogitator-ai/*` dependencies are on the latest versions, for example `npm install -D @cogitator-ai/cli@latest @cogitator-ai/test-utils@latest` and `npm install @cogitator-ai/core@latest @cogitator-ai/config@latest`.

## 0.5.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - The scaffolder is rebuilt on a spec and feature modules. Pick one of 16 presets or the stack itself with flags (`--app`, `--server`, `--channels`, `--memory`, `--vector-store`, `--features`, `--deploy`, `--agent`), see everything with `--dry-run --json`, and get a project with a registry of its agents in `src/cogitator.ts`, three working tools, tests on a mocked model, CI, Biome, a Zod env schema, `AGENTS.md` with the docs bundled for coding agents, Cogitator Studio (`dev:studio`) and, with `--deploy`, a production Dockerfile. Combinations that cannot work are refused before anything is written. `--example <name>` starts from an example of the repository and `--template github:owner/repo/path#ref` from a GitHub template. `--agent claude|cursor|codex` configures the `cogitator` MCP server and a skill. The programmatic `planProject()` and `scaffold(spec, options)` replace the old `scaffold(options)`, and `planAdd()` / `addToProject()` power `cogitator add`. Scaffolding sends one anonymous telemetry event, off with `--no-telemetry`, `COGITATOR_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, in CI and on `--dry-run`.

  Generated projects with pnpm 11 install in CI: the native builds a project needs are allowed and the optional ones (`cpu-features`, `protobufjs`, `ssh2`) declined in `pnpm-workspace.yaml`, so `ERR_PNPM_IGNORED_BUILDS` no longer fails the install, also in projects started from an example. A channels project keeps its gateway in `src/gateway.ts`, so `cogitator assistant`, `cogitator build` and `cogitator daemon` run it as before.

  The CI of a Yarn project turns on corepack and installs with `--immutable` on Yarn 2 and later and `--frozen-lockfile` on Yarn 1. `planAdd()` reports `removedDependencies`, and `changesDependencies(plan)` says whether an addition needs an install in either direction.

  **Breaking:** the programmatic API changed.

  - `scaffold(options)` is now `scaffold(spec, options)`: build the spec with `parseSpec()` or pass a `ProjectSpecInput`, and `planProject(spec)` shows the plan without writing.
  - Removed: `parseArgs`, `collectOptions`, `getTemplate`, `templateChoices`, `devCommand`, `defaultModels`, `providerConfig` and the types `ProjectOptions`, `Template`, `TemplateFile`, `ScaffoldStep`. Use `PRESETS`, `findPreset()`, `defaultModel()`, `PROVIDERS` and the other catalogs instead.
  - The old template names keep working as `--template` and `--preset` values. Projects created before are not touched.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/deploy@0.6.0

## 0.4.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A freshly scaffolded project now runs on the first try. The `dev` and `start` scripts load `.env` (`tsx --env-file-if-exists=.env`), so a key copied from `.env.example` reaches the app instead of failing with `OpenAI API key is required`, and a missing key stops the app with its name and a pointer to `.env.example`. `npx create-cogitator-app` now picks npm instead of pnpm. The default Ollama model is `qwen3.5:9b`, the prompt lists the models already pulled, `--model` and `ProjectOptions.model` choose another one, a missing model is offered for download, and the compose file pulls it into the Ollama container. The printed next steps and the generated README include `cp .env.example .env` or `ollama pull <model>` when the first run needs them.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The project name is validated as an npm package name before anything is written, both by the CLI and by `scaffold()`, and `validateProjectName(name)` is exported to check it up front. `.` names the project after the current directory instead of `"."`, and the name is quoted in the generated code, so a name like `bob's agents` is reported instead of producing code that does not compile.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Generated projects pin the `@cogitator-ai/*` packages with a caret to the versions released together with the scaffolder (for example `^0.33.0`) instead of `latest`, so an older cached scaffolder keeps generating code that compiles and a reinstall without a lockfile does not pull in an incompatible release.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Generated scripts exit with code 1 when the run fails, so CI no longer reports a failed run as a success, and `workflow` also fails on an error in the workflow result. `memory` and `swarm` close their connections on failure too. The `workflow` template prints the report and each node's output instead of `nodeResults: {}`. The generated ignore file now covers every `.env.*` except `.env.example`, `*.tsbuildinfo`, and for `nextjs` the `.next/`, `out/` and `next-env.d.ts` build output.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The `api-server` and `nextjs` templates keep the conversation: they configure in-process memory, so the next message in a thread sees the earlier ones and the thread routes of `api-server` answer instead of `503 Memory not configured`. `api-server` no longer serves unauthenticated runs to every origin on every interface: it listens on `127.0.0.1` in development, checks `Authorization: Bearer $API_TOKEN` on everything but health and docs, refuses to start in production without a token, enables CORS only for the origins in `CORS_ORIGIN`, and its `cogitator.yml` lists the provider key and `API_TOKEN` as deploy secrets. The `nextjs` chat shows run errors and a Stop button, and its `lint: next lint` script, which prompts in CI and is gone in Next 16, is replaced by `typecheck`.

## 0.3.1

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.

## 0.3.0

### Minor Changes

- [`26745cd`](https://github.com/cogitator-ai/Cogitator-AI/commit/26745cdeb375bd6193e782b4a6f72d649da1e1d9) - Generated servers now deploy healthy, and `scaffold()` can be embedded.

  - The `api-server` template mounts its routes at `/api` but `cogitator deploy` probed `/cogitator/health`, so its containers were marked unhealthy. Its `cogitator.yml` now sets `deploy.health.path: /api/health`. The `nextjs` template gets a `/api/health` route and the same setting.
  - `scaffold()` takes `install: false` to write the files without running `<pm> install`, and the CLI takes `--no-install`. It now resolves to a `ScaffoldResult` with the generated files and the outcome of the install and git steps, so a failed install is reported (`{ status: 'failed', error }`) instead of being swallowed. The CLI prints the error and adds the install command to the next steps.
  - The `api-server` template installs express 5, matching its `@types/express` 5 typings and the express version `@cogitator-ai/express` is built against.

## 0.2.1

### Patch Changes

- 63489f0: Generated projects now work with the current packages: `cogitator.yml` uses the `llm.defaultProvider` / `llm.defaultModel` (and `memory`) layout `@cogitator-ai/config` loads instead of top-level keys it dropped, templates depend on zod ^4 like `@cogitator-ai/core`, the workflow template's state type satisfies the workflow `WorkflowState` constraint, and the swarm template no longer reads a nonexistent `result.strategy`. Docs links point to https://cogitator.app, the repository link to cogitator-ai/Cogitator-AI, and the banner shows the installed version instead of v0.1.0.
- 63489f0: `-y`/`--yes` was parsed but ignored, so the CLI still asked every question. It now runs without prompts, using the given flags and the defaults for the rest (`my-agents`, basic template, Ollama, the package manager it was launched with, Docker Compose and git on). Provider hints in the prompts now show the models the templates actually use.
- 4b45676: The initial scaffold commit is now authored by your own git identity instead of a hard-coded `Cogitator <init@cogitator.dev>` address. A neutral `create-cogitator-app@localhost` identity is used only when no `user.name`/`user.email` is configured, so the commit still succeeds on fresh machines.

## 0.2.0

### Minor Changes

- pnpm projects get a `pnpm-workspace.yaml` allowing the native builds pnpm 10.26+/11 would otherwise refuse, so a fresh project installs again; current default models.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

## 0.1.1

### Patch Changes

- fix: audit — 10 bugs fixed, +112 tests added

  Key fixes:
  - Fix gemini-2.0-flash → gemini-2.5-flash (model was returning 404)
  - Fix array bounds crash when --template/--provider/--pm flags have no value
  - Fix workflow template to use correct agentNode/functionNode API
  - Fix swarm template hierarchical config (remove invalid coordination wrapper)
  - Fix git initial commit to configure identity (prevents failure on unconfigured git)
  - Fix docker-compose Postgres credentials to use env var defaults
  - Add REDIS_URL to .env.example for memory template
  - Add non-empty directory check before scaffolding (prevents silent overwrite)
  - Fix project name trimming before path resolution
  - Add lib.ts export for programmatic usage

  New: 100 unit tests, 12 e2e tests, package README, docs page
