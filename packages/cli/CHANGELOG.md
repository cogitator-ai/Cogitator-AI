# @cogitator-ai/cli

## 0.6.3

### Patch Changes

- [#150](https://github.com/cogitator-ai/Cogitator-AI/pull/150) [`73237de`](https://github.com/cogitator-ai/Cogitator-AI/commit/73237de96e86412051697491c8109a5887eb564a) - The telemetry event of a failed scaffold says where and why it failed. `failedStep` is `create` (the options, the directory, downloading or writing files) or `install`, and `errorCode` is the code it failed with: the package manager's own from a closed set of known codes (`ERR_PNPM_NO_MATCHING_VERSION`, npm's `ETARGET`, Yarn's `YN0035`, a code for the messages of Bun and Yarn 1, `ERR_PNPM_OTHER` or `NPM_OTHER` for any other, since install scripts print into the same output), a Node network or file system code (`ENOTFOUND`), or the scaffolder's (`DIRECTORY_NOT_EMPTY`, `HTTP_404`). Both are `none` on success. The event never holds the error message or the install output, which can contain paths and package names.

  An `--example` or `--template` whose install failed was counted as a success. It is a failure now, like a generated project.

  In the library, `payloadFor(spec, failure?, kind)` takes a `ScaffoldFailure` (`{ step, error }`) in place of the outcome, and `installFailure(result)` gives the one of a scaffold whose install failed. `telemetryErrorCode`, `installErrorCode` and `CodedError`, the error with a code the scaffolder throws, are exported too.

- Updated dependencies [[`73237de`](https://github.com/cogitator-ai/Cogitator-AI/commit/73237de96e86412051697491c8109a5887eb564a)]:
  - create-cogitator-app@0.6.0

## 0.6.2

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/config@0.13.0
  - @cogitator-ai/channels@0.9.3
  - @cogitator-ai/mcp@19.3.3
  - @cogitator-ai/studio@0.1.2
  - @cogitator-ai/deploy@0.6.2
  - @cogitator-ai/memory@0.12.3

## 0.6.1

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/config@0.12.2
  - @cogitator-ai/channels@0.9.2
  - @cogitator-ai/mcp@19.3.2
  - @cogitator-ai/studio@0.1.1
  - @cogitator-ai/deploy@0.6.1
  - @cogitator-ai/memory@0.12.2

## 0.6.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - New commands: `cogitator add` grows a scaffolded project with rag, mcp, workflows, evals, memory, deploy and the rest, merging into files you changed and refusing with a diff when it cannot; `cogitator dev` opens Cogitator Studio; `cogitator mcp` serves the bundled docs and the project's registry to Claude Code, Cursor and Codex; `cogitator doctor` checks that a project can run; `cogitator eval` runs eval suites for CI. `cogitator init` generates the `channels` preset of create-cogitator-app. Every command now exits `0`, `1` or `2` (wrong command line), reports failures with hints on stderr (stack traces with `COGITATOR_DEBUG`), prints JSON with `--json` (now also on `models`, `status` and `deploy`), and ends its help with examples.

  `cogitator mcp --project <path>` serves another project, and `cogitator add` installs when an addition removes dependencies too, so the lockfile follows package.json. `cogitator doctor` finds packages installed with Yarn Plug'n'Play and packages hoisted to a parent node_modules.

  **Breaking:**

  - Errors and warnings go to stderr, and a wrong command line (unknown option, missing argument, invalid value) exits with `2` instead of `1`. Scripts that read errors from stdout or check for `1` need to follow.
  - `cogitator init` generates a different project: the agent moves from `src/agent.ts` to `src/agents/assistant.ts` and the registry `src/cogitator.ts`, and `src/index.ts` starts the gateway for `dev` and `start`. `src/gateway.ts` still exports `gateway`, so `cogitator assistant`, `build` and `daemon` work as before. Existing projects are not touched.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/deploy@0.6.0
  - create-cogitator-app@0.5.0
  - @cogitator-ai/memory@0.12.1
  - @cogitator-ai/channels@0.9.1
  - @cogitator-ai/studio@0.1.0
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/mcp@19.3.1
  - @cogitator-ai/config@0.12.1

## 0.5.20

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Projects from `cogitator init` deploy as they are. `init` writes a runtime `cogitator.yml` with the provider, model and memory, and a `deploy` section that runs the gateway as a worker, publishes the WebChat port and lists the API key and channel tokens as secrets, so `cogitator deploy` no longer ships a container without them that restarts forever. The SQLite memory directory is created at start (the first `pnpm dev` failed without it) and lives on a volume when deployed, and `package.json` pins the pnpm, Yarn or Bun version that ran `init` in `packageManager`.

  `cogitator deploy -c <file>` reads the model, memory and deploy section from that file instead of mixing it with the default one, finds `.cogitator.yml` like `loadConfig` does, and shows the project kind, volumes and which services Fly does not provision.

  `cogitator run` loads the `.env` next to the config file, and with an assistant config from `cogitator wizard` runs its `llm.provider` and `llm.model` instead of silently falling back to a local Ollama model.

  `cogitator build` bundles only the project's own code and leaves every package to `node_modules`, so a project with the Docker sandbox (whose `ssh2` dependency ships a native addon) or optional media dependencies builds again.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `CompactionConfig.threshold` means tokens everywhere. The Gateway compared it with the number of messages while `CompactionService` compared it with tokens, so `threshold: 8000` from the memory docs waited for 8000 messages in a channel. The new `messageThreshold` counts messages, and a thread is compacted once either limit is reached (`threshold` is now optional, at least one is required). Gateway configs that meant messages should switch to `messageThreshold`. The `memory.compaction.threshold` of an assistant YAML config still counts messages, and `cogitator init` generates `messageThreshold`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `OLLAMA_HOST`, `OLLAMA_URL` and the new `OLLAMA_BASE_URL` are read the way Ollama reads `OLLAMA_HOST`. `OLLAMA_HOST=0.0.0.0`, set so `ollama serve` listens on every interface, used to send every call to port 80 and fail with `ECONNREFUSED`. Now a value without a scheme gets port 11434 and a wildcard address is reached as `localhost`, in `loadConfig` and in the CLI alike (`resolveOllamaHost()`). These variables also no longer replace an explicit `llm.providers.ollama.baseUrl` from cogitator.yml, they apply only when the file sets none (`loadEnvDefaults()`), while `COGITATOR_OLLAMA_BASE_URL` still overrides it. `loadEnvConfig()` therefore no longer returns them.

  `loadConfig` looks for `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml` and `.cogitator.yaml` in that order, the same order `cogitator run` and `cogitator deploy` use (`findConfigFile()`).

- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/models@18.3.0
  - @cogitator-ai/config@0.12.0
  - @cogitator-ai/channels@0.9.0
  - @cogitator-ai/memory@0.12.0
  - @cogitator-ai/deploy@0.5.0

## 0.5.19

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/channels@0.8.6
  - @cogitator-ai/config@0.11.8
  - @cogitator-ai/deploy@0.4.8
  - @cogitator-ai/memory@0.11.8

## 0.5.18

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0
  - @cogitator-ai/channels@0.8.5
  - @cogitator-ai/config@0.11.7
  - @cogitator-ai/deploy@0.4.7
  - @cogitator-ai/memory@0.11.7

## 0.5.17

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/channels@0.8.4
  - @cogitator-ai/config@0.11.6
  - @cogitator-ai/deploy@0.4.6
  - @cogitator-ai/memory@0.11.6

## 0.5.16

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4
  - @cogitator-ai/channels@0.8.3

## 0.5.15

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3
  - @cogitator-ai/channels@0.8.2

## 0.5.14

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/channels@0.8.1
  - @cogitator-ai/config@0.11.5
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/deploy@0.4.5
  - @cogitator-ai/memory@0.11.5
  - @cogitator-ai/models@18.2.1
  - @cogitator-ai/types@0.33.1

## 0.5.13

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/channels@0.8.0
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/config@0.11.4
  - @cogitator-ai/core@0.30.1
  - @cogitator-ai/deploy@0.4.4
  - @cogitator-ai/memory@0.11.4

## 0.5.12

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/channels@0.7.6
  - @cogitator-ai/config@0.11.3
  - @cogitator-ai/deploy@0.4.3
  - @cogitator-ai/memory@0.11.3

## 0.5.11

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0
  - @cogitator-ai/channels@0.7.5

## 0.5.10

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/config@0.11.2
  - @cogitator-ai/deploy@0.4.2
  - @cogitator-ai/memory@0.11.2
  - @cogitator-ai/types@0.31.0
  - @cogitator-ai/channels@0.7.4

## 0.5.9

### Patch Changes

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`26745cd`](https://github.com/cogitator-ai/Cogitator-AI/commit/26745cdeb375bd6193e782b4a6f72d649da1e1d9), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7), [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6), [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36), [`5caa2aa`](https://github.com/cogitator-ai/Cogitator-AI/commit/5caa2aa17e737fb7c5fcd56f3acab57744af7217), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/deploy@0.4.1
  - @cogitator-ai/memory@0.11.1
  - @cogitator-ai/models@18.2.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/channels@0.7.3
  - @cogitator-ai/config@0.11.1

## 0.5.8

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2
  - @cogitator-ai/channels@0.7.2

## 0.5.7

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1
  - @cogitator-ai/channels@0.7.1

## 0.5.6

### Patch Changes

- d626dfb: Fix `cogitator up` and `cogitator wizard --edit`:

  - `up` loads `.env` into `process.env` (without overriding variables already set), so tools that read it, such as `web_search` and `github_api`, see keys written by the wizard.
  - `up` supervises the assistant for restarts even without `selfConfig`, so the owner `/restart` command (exit code 78) restarts it instead of stopping it.
  - `wizard --edit` keeps a postgres memory config and the WhatsApp/WebChat channels instead of overwriting them.

- cee7c73: The `cogitator up` startup summary listed every configured channel, including ones skipped because their token (e.g. `WEBCHAT_TOKEN`) is missing. It now lists the channels the gateway actually runs, and warns when none are running.
- cee7c73: `cogitator up` treated every `./cogitator.yml` as an assistant config, so in a project from create-cogitator-app (whose `cogitator.yml` is an `@cogitator-ai/config` runtime config) it failed with assistant validation errors. A runtime config is now recognised: `up` starts the project's Docker Compose services, or explains what the file is when there are none, and `cogitator daemon` no longer picks it as the entry to run.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8963e1e]
- Updated dependencies [1df914a]
- Updated dependencies [f43f6af]
- Updated dependencies [8d520c0]
- Updated dependencies [a3c2ee1]
- Updated dependencies [8bcf914]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [e7925d5]
- Updated dependencies [b8c9eca]
- Updated dependencies [0736823]
- Updated dependencies [7d6952d]
- Updated dependencies [0736823]
- Updated dependencies [0736823]
- Updated dependencies [bb17767]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [e7925d5]
- Updated dependencies [d35ef2a]
- Updated dependencies [4a2925f]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/channels@0.7.0
  - @cogitator-ai/memory@0.11.0
  - @cogitator-ai/config@0.11.0
  - @cogitator-ai/deploy@0.4.0

## 0.5.5

### Patch Changes

- Updated dependencies [e211b6a]
- Updated dependencies [333e4ad]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [1368ff8]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [e561607]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/memory@0.10.0
  - @cogitator-ai/types@0.28.0
  - @cogitator-ai/channels@0.6.1
  - @cogitator-ai/config@0.10.1
  - @cogitator-ai/deploy@0.3.4

## 0.5.4

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/models@18.1.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/config@0.10.0
  - @cogitator-ai/channels@0.6.0
  - @cogitator-ai/deploy@0.3.3
  - @cogitator-ai/memory@0.9.1

## 0.5.3

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0
  - @cogitator-ai/config@0.9.0
  - @cogitator-ai/memory@0.9.0
  - @cogitator-ai/channels@0.5.1
  - @cogitator-ai/deploy@0.3.2

## 0.5.2

### Patch Changes

- 9eae101: Slack: answer @mentions in channels. The adapter only listened to `message` events, so a mention delivered as `app_mention` (the documented subscription) was dropped. Mentions are now handled, the `<@bot>` token is stripped from the text, a message that arrives both as `message` and `app_mention` is handled once, and the new `mentionOnly` option ignores channel messages that do not mention the bot. `RuntimeBuilder` now passes `SLACK_APP_TOKEN` (Socket Mode) and `SLACK_PORT`, and warns when Slack falls back to HTTP mode; `cogitator wizard` and `cogitator init` ask for the app token.
- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [9eae101]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/config@0.8.0
  - @cogitator-ai/channels@0.5.0
  - @cogitator-ai/deploy@0.3.1
  - @cogitator-ai/memory@0.8.1

## 0.5.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1
  - @cogitator-ai/channels@0.4.1

## 0.5.0

### Minor Changes

- `cogitator init` writes a `pnpm-workspace.yaml` that allows the native builds pnpm 10.26+/11 would otherwise refuse; generated projects require Node 22.12+ and `build` targets node22.
- Prompts (clack 1): pressing Enter on an empty field no longer saves the grey placeholder as the value. Extra positional arguments are now an error instead of being silently dropped (commander 15).
- Current model lists and Ollama defaults (`qwen3:8b`).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/channels@0.4.0
  - @cogitator-ai/config@0.7.0
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/deploy@0.3.0
  - @cogitator-ai/memory@0.8.0
  - @cogitator-ai/models@18.0.0
  - @cogitator-ai/types@0.24.0

## 0.4.0

### Minor Changes

- Several CLI flows did not work and are now fixed. init pinned @cogitator-ai/\* to ^0.1.0 (which resolves to 0.1.x), ignored the memory choice, never loaded .env, and suggested a `cogitator up` that fails. The daemon ran `node src/gateway.ts`, which never started anything; piped its logs through the exiting parent; could SIGKILL an unrelated process when a PID was reused; and installed a systemd unit with WantedBy=multi-user.target, which never starts in the user manager. build produced a bundle that did not start the gateway. up started HeartbeatScheduler twice (duplicate reminders) and did not forward SIGTERM to the restart child. models --pull reported Ollama errors as success and dropped NDJSON lines split across chunks. run ignored -c precedence and llm.defaultModel. skill create/remove allowed path traversal, so remove could rm -rf outside the skills dir. wizard --edit lost .env comments, MCP servers and other settings. Removed @ts-expect-error in favour of a type-guarded optional module loader. Removed the assistant 'pause' hotkey, which did nothing. All shell-string docker/launchctl calls now go through execFile. README, docs page, wizard docs and examples were rewritten.

  **Breaking changes**
  - `run`: an explicit -c now wins over COGITATOR_CONFIG, and a missing explicit or env config file is an error instead of a silent fallback.
  - `daemon start/restart/install`: -c no longer defaults to src/gateway.ts. The entry is auto-detected (dist/cogitator.mjs, then cogitator.yml, then src/gateway.ts). The PID file is now JSON (legacy plain PIDs are still read).
  - `daemon logs --json` was removed (it did nothing).
  - The `assistant` 'p' (pause) hotkey was removed (it did nothing).
  - `skill create` requires kebab-case names. Generated tool names are snake_case.
  - `up` without cogitator.yml and with no Docker running exits with 'No cogitator.yml or docker-compose.yml found' as before. `up` gained -c/--config, and --no-restart-loop is now a documented option.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/channels@0.3.0
  - @cogitator-ai/config@0.6.0
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/deploy@0.2.0
  - @cogitator-ai/memory@0.7.0
  - @cogitator-ai/types@0.23.0

## 0.3.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/memory@0.6.22
  - @cogitator-ai/types@0.22.3
  - @cogitator-ai/channels@0.2.5
  - @cogitator-ai/config@0.5.6
  - @cogitator-ai/deploy@0.1.9

## 0.3.15

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/channels@0.2.4
  - @cogitator-ai/config@0.5.5
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/deploy@0.1.8
  - @cogitator-ai/memory@0.6.21

## 0.3.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/deploy@0.1.7

## 0.3.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/channels@0.2.3
  - @cogitator-ai/config@0.5.4
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/models@17.1.8
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/deploy@0.1.6
  - @cogitator-ai/memory@0.6.20

## 0.3.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/channels@0.2.2
  - @cogitator-ai/config@0.5.3
  - @cogitator-ai/deploy@0.1.5
  - @cogitator-ai/memory@0.6.19

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.3.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5
  - @cogitator-ai/config@0.5.2
  - @cogitator-ai/deploy@0.1.4

## 0.3.7

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.3.6

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.3.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
  - @cogitator-ai/config@0.5.1
  - @cogitator-ai/deploy@0.1.3

## 0.3.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/deploy@0.1.2

## 0.3.3

### Patch Changes

- fix(cli): exclude test files from compiled dist

## 0.3.2

### Patch Changes

- fix(cli): audit — 5 bugs & improvements
  - Fix: `loadConfig()` in `run.ts` now passes `configPath` for YAML config files (was ignoring user config)
  - Fix: `printBanner()` reads version from package.json dynamically (was hardcoded as v0.1.0)
  - Refactor: extract shared `findDockerCompose()` and `checkDocker()` to `utils/docker.ts`
  - Fix: parent dir traversal in `findDockerCompose()` now checks both `.yml` and `.yaml`
  - Add `vitest.config.ts` to restrict test discovery to `src/` only
  - Add 22 new unit tests covering `docker.ts`, `models.ts`, and `run.ts` utilities

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.3.0

### Minor Changes

- Add one-command deployment engine (`cogitator deploy`)
  - New deploy types: `DeployTarget`, `DeployConfig`, `DeployResult`, `DeployPlan`
  - Deploy section in `cogitator.yml` schema with target, port, region, instances, registry, services, secrets
  - CLI `deploy` command with `--target`, `--dry-run`, `--push`, `status`, and `destroy` subcommands

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/config@0.4.0
  - @cogitator-ai/deploy@0.1.1

## 0.2.25

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/config@0.3.13

## 0.2.24

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/config@0.3.12

## 0.2.23

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2

## 0.2.22

### Patch Changes

- @cogitator-ai/config@0.3.11
- @cogitator-ai/core@0.17.1

## 0.2.21

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/config@0.3.10

## 0.2.20

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/config@0.3.9

## 0.2.19

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/config@0.3.8

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/config@0.3.7

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/config@0.3.6

## 0.2.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/config@0.3.5

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/config@0.3.4
  - @cogitator-ai/core@0.11.5

## 0.2.14

### Patch Changes

- @cogitator-ai/config@0.3.3
- @cogitator-ai/core@0.11.4

## 0.2.13

### Patch Changes

- @cogitator-ai/config@0.3.2
- @cogitator-ai/core@0.11.3

## 0.2.12

### Patch Changes

- @cogitator-ai/config@0.3.1
- @cogitator-ai/core@0.11.2

## 0.2.11

### Patch Changes

- @cogitator-ai/core@0.11.1

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0
  - @cogitator-ai/config@0.3.0

## 0.2.9

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/config@0.2.8

## 0.2.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.9.0
  - @cogitator-ai/config@0.2.7

## 0.2.7

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/config@0.2.6

## 0.2.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/config@0.2.5

## 0.2.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/config@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/config@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/config@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.3.0
  - @cogitator-ai/config@0.2.1

## 0.2.0

### Features

- **New command: `cogitator status`** - Show status of Docker services and Ollama
- **New command: `cogitator logs`** - View Docker service logs with follow mode
- **New command: `cogitator models`** - List and pull Ollama models
- **Environment variables**: `COGITATOR_MODEL` and `COGITATOR_CONFIG` support
- **Interactive mode improvements**:
  - `/model <name>` - Switch models mid-conversation
  - `/clear` - Reset conversation history
  - `/help` - Show available commands
  - Message counter in prompt

### Fixes

- Version now reads from package.json instead of hardcoded value
- Config loading errors are now logged as warnings instead of silently ignored

## 0.1.1

### Patch Changes

- @cogitator-ai/config@0.1.1
- @cogitator-ai/core@0.1.1

## 0.1.0

### Initial Release

- `cogitator init <name>` - Create new project with Docker setup
- `cogitator up` - Start Docker services (Redis, PostgreSQL, Ollama)
- `cogitator down` - Stop Docker services
- `cogitator run [message]` - Run agent with streaming support
