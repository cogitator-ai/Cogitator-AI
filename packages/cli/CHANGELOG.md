# @cogitator-ai/cli

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
