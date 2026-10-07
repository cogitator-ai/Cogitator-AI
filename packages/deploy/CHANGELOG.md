# @cogitator-ai/deploy

## 0.6.1

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/config@0.12.2

## 0.6.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - The generated Dockerfile is a production image: a builder stage with the native toolchain and BuildKit cache mounts, an install from the lockfile, dev dependencies pruned, and a runtime stage on `node:24-alpine` (or Bun) with `tini` as init and the unprivileged `node` user. Start scripts run without their `--env-file` flags, and `file:` / `link:` dependencies are copied in before the install.

  A Node app managed by Bun builds on the Node image with Bun copied in and `node-gyp` installed for native modules, and Bun prunes without `--ignore-scripts`, so native dependencies are built in the image. Yarn Plug'n'Play projects get their package archives in the image and the PnP resolver loaded at start, where the image used to copy a `node_modules` that PnP never creates.

  **Breaking:** the image runs on `node:24-alpine` instead of `node:22-alpine`, as the unprivileged `node` user with `tini` as PID 1, and `CMD` runs the start command directly, without `--env-file`. Pass the environment to the container (`docker run --env-file`, Fly secrets), and make sure the app writes only to its data volume or `/tmp`.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/config@0.12.1

## 0.5.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `cogitator deploy` tells servers from workers. `deploy.kind` is `server` (answers HTTP, gets a health check, may scale to zero on Fly) or `worker` (a channel gateway or queue worker: no health check, a port only when one is set, never stopped by the Fly proxy), detected from the project's dependencies. A project that is neither, such as a script that exits after one call, fails preflight instead of being restarted forever. Tetsu and Next.js join the detected servers, with `/health` as the Tetsu health path, and a server whose health path is unknown gets no failing health check.

  Preflight now starts with project checks every target shares: a missing `package.json` (a `cogitator wizard` assistant runs with `cogitator up`), an unknown project kind, a `start` script that loads `.env` with `--env-file` (the file stays out of the image, use `--env-file-if-exists`), and a project whose `.env` holds variables while no secrets were detected. On Docker, a deploy only succeeds when the app container keeps running for a few seconds after it starts, otherwise it fails with the container's last log lines.

  A SQLite memory keeps its database directory on a Docker named volume or a Fly volume (`deploy.volumes`, created on the first Fly deploy), and the directory stays out of the image. A local Ollama on the docker target is reached on the host through `host.docker.internal` (`deploy.hostGateway`). On Fly, Redis and Postgres are no longer silently dropped: `REDIS_URL` and `DATABASE_URL` become required secrets.

  Secrets follow the runtime: the provider is resolved the way the runtime routes the model (`meta-llama/...` on Together needs `TOGETHER_API_KEY`), Azure needs its endpoint, Bedrock a region, an alias such as `GEMINI_API_KEY` is passed when it is the one set, and values written in `llm.providers` count as provided. Names passed to `requireEnv('NAME')` in `src/` and set variables of `.env.example` are detected too.

  The Dockerfile copies `pnpm-workspace.yaml`, `.npmrc`, `patches/` and the other files the install step reads before it runs, so pnpm's `allowBuilds`, overrides, patches and private registries apply in the image. Yarn Berry installs with `--immutable` (and `workspaces focus` for production on Yarn 4), and Bun projects build on `oven/bun:1-alpine` and start with `bun run start`.

  `DeployOptions` gains `configPath` (the file `cogitator deploy -c` passes, read for the model, memory and deploy section alike) and `env`, `status` and `destroy` take `{ configPath }`, and `PackageManager` gains `yarn-berry` and `bun`.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The generated Dockerfile's `HEALTHCHECK` probes `127.0.0.1` instead of `localhost`. In Alpine images `localhost` resolves to the IPv6 `::1` first, so a server listening on `0.0.0.0` (IPv4 only), as the create-cogitator-app API server does in production, refused the probe and Docker marked a healthy container unhealthy.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/config@0.12.0

## 0.4.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/config@0.11.8

## 0.4.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/config@0.11.7

## 0.4.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/config@0.11.6

## 0.4.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/config@0.11.5
  - @cogitator-ai/types@0.33.1

## 0.4.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/config@0.11.4

## 0.4.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/config@0.11.3

## 0.4.2

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/config@0.11.2
  - @cogitator-ai/types@0.31.0

## 0.4.1

### Patch Changes

- [`26745cd`](https://github.com/cogitator-ai/Cogitator-AI/commit/26745cdeb375bd6193e782b4a6f72d649da1e1d9) - The programmatic `Deployer` now reads the `deploy` section of the project's `cogitator.yml`. Only `cogitator deploy` used to pass it in, so `deployer.plan()` and `deployer.deploy()` ignored a configured `health.path`, `port`, `secrets` and the rest, and the generated Dockerfile `HEALTHCHECK` and Fly.io check probed `/cogitator/health` even on a server mounted elsewhere, which Docker then marked unhealthy. `configOverrides` still win over the file, field by field inside `services`, `env`, `health` and `resources`, and both win over auto-detection.
- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/config@0.11.1

## 0.4.0

### Minor Changes

- 0736823: `Deployer.deploy` built the artifacts with its own generator and never called the target provider's `generate()`, so a custom provider's artifacts were ignored. It now deploys what `provider.generate(config, projectDir)` returns. The built-in Docker and Fly providers' `generate()` now detect the package manager, lockfile, build script and start command (new `ProjectAnalyzer.detectBuild`), so their Dockerfile matches what `deploy` produced before instead of assuming pnpm and `dist/server.js`.

### Patch Changes

- 0736823: The generated `docker-compose.prod.yml` repeated `REDIS_URL`, `DATABASE_URL`, `PORT` or `NODE_ENV` when `env` or `secrets` also set them, which YAML parsers reject or resolve unpredictably. Each variable is now written once: `env` overrides the defaults and the bundled service URLs, and a secret that names a service URL falls back to that URL when unset.
- 7d6952d: Export the `ProjectBuild` type, the return type of the public `ProjectAnalyzer.detectBuild()`, so callers can name it.
- 0736823: The default health check path was `/health`, but the server adapters (Express, Fastify, Hono, Koa) serve it under their default `/cogitator` base path. The Dockerfile `HEALTHCHECK`, the `fly.toml` check and the reported health endpoint now default to `/cogitator/health`; set `health.path` for another base path.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [8bcf914]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/config@0.11.0

## 0.3.4

### Patch Changes

- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0
  - @cogitator-ai/config@0.10.1

## 0.3.3

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/config@0.10.0

## 0.3.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/config@0.9.0

## 0.3.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/config@0.8.0

## 0.3.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/config@0.7.0
  - @cogitator-ai/types@0.24.0

## 0.2.0

### Minor Changes

- The Docker target never started a deployment. It built and pushed the image but never ran compose; the compose file used the wrong build context and passed no secrets; and status/destroy used the legacy docker-compose binary, with destroy silently deleting volumes. Deploy now builds, then runs `docker compose -p <image> up -d` with .env secrets passed through, and destroy keeps volumes. The analyzer dropped detected services and secrets from the plan and swallowed config errors; both now surface as plan.warnings. The registry preflight used a docker flag that does not exist (`docker login --get-login`), so it always failed; it now reads the Docker config and credential helpers. .dockerignore was written where Docker ignores it, so .env secrets and node_modules went into images. The Dockerfile hard-coded pnpm --frozen-lockfile, dist/server.js and the EOL node:20; install steps now follow the lockfile, CMD comes from start/main, and the image is node:22. Fly overwrote the user's fly.toml, ignored failed secret imports, and did not apply `instances`. All commands now run without a shell (execFile), and app/image names default to the package name instead of the shared 'cogitator-app'. railway/k8s/ssh targets that had no provider were removed. Custom providers now work with the typed API via DeployTargetName.

  **Breaking changes**
  - DeployTarget narrowed to 'docker' | 'fly' (railway/k8s/ssh never had providers). Custom providers use Deployer.registerProvider plus DeployTargetName.
  - DockerProvider.deploy now also starts the compose stack. destroy no longer deletes volumes and throws on failure. FlyProvider.destroy throws on failure.
  - Generated artifacts changed: fly.toml now lives in .cogitator/; the Dockerfile uses node:22-alpine and lockfile-based installs; a root .dockerignore is created if missing.
  - The default image/app name is now derived from package.json name instead of 'cogitator-app'.
  - DeployPlan gained `warnings` and `analysis` fields (additive). ProjectAnalyzer.analyze accepts Partial<DeployConfig>.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/config@0.6.0
  - @cogitator-ai/types@0.23.0

## 0.1.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.3
  - @cogitator-ai/config@0.5.6

## 0.1.8

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/config@0.5.5

## 0.1.7

### Patch Changes

- Bound Docker and Fly.io preflight command checks so unavailable CLIs or daemons cannot hang CI or deployment validation.

## 0.1.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/config@0.5.4
  - @cogitator-ai/types@0.22.2

## 0.1.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/config@0.5.3

## 0.1.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/config@0.5.2

## 0.1.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/config@0.5.1

## 0.1.2

### Patch Changes

- Fix 3 bugs: fly.toml memory parsing ("1gb" -> 1mb), docker status/destroy stubs, fly secrets shell injection

## 0.1.1

### Patch Changes

- Add package README with Quick Start, configuration, auto-detection, and architecture docs
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/config@0.4.0
