# create-cogitator-app

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
