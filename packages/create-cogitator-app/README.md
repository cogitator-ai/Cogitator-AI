# create-cogitator-app

Scaffolder for [Cogitator](https://cogitator.app): a working TypeScript agent project in one command, from a preset or a stack you pick, with tests on a mocked model, a registry of agents, Cogitator Studio, coding-agent setup and a production Dockerfile.

Guide: [cogitator.app/docs/getting-started/scaffolding](https://cogitator.app/docs/getting-started/scaffolding)

## Usage

```bash
# Ask for everything
npx create-cogitator-app

# A preset with a provider
npx create-cogitator-app my-bot --preset rag --provider openai

# Pick the stack yourself, ask nothing
npx create-cogitator-app api --app server --server fastify --memory postgres --features rag,evals --yes

# Look before writing anything
npx create-cogitator-app demo --preset nextjs --dry-run --json

# Start from an example of the repository or from a GitHub template
npx create-cogitator-app tutor --example core/basic-agent
npx create-cogitator-app bot --template github:acme/agent-templates/support-bot#v2
```

Anything the flags leave out is asked for at a terminal. With `--yes`, `--json`, without a TTY or with `CI` set nothing is asked and the defaults fill the gaps: the `my-agents` directory, the `basic` preset, Ollama with `qwen3.5:9b`, the package manager that runs the scaffolder, Docker Compose on, git on. A typo in a flag or a value is an error with the closest valid name, never a silent default.

After writing the files the scaffolder installs the dependencies, formats the code with the project's Biome, writes `.cogitator/scaffold.json` (hashes of what it generated, for `cogitator add`) and commits everything to a new git repository, unless the project is inside one already. With Ollama it offers to pull a missing model, with a cloud provider it checks the key you pass with `--api-key` (written to `.env`, mode 600, never printed).

Requires Node.js 22.12+.

## Presets

| Preset             | What you get                                                            |
| ------------------ | ----------------------------------------------------------------------- |
| `basic`            | One agent with real tools in your terminal, the best place to start     |
| `assistant`        | Workspace files with approvals, long-term memory, a scheduler and evals |
| `memory`           | Conversations that survive restarts, in SQLite                          |
| `api-server`       | Express with Swagger UI, token auth and persistent threads              |
| `hono`             | Agents behind a small, fast HTTP API                                    |
| `tetsu`            | Bun-native controller with OpenAPI and WebSocket                        |
| `nextjs`           | Streaming chat with tool calls, approvals and saved threads             |
| `channels`         | One assistant on Telegram, Discord, Slack, WebChat, Bluesky or Threads  |
| `rag`              | Answers grounded in the files of `docs/`                                |
| `mcp`              | Tools from an MCP server, your agents served over MCP                   |
| `swarm`            | A researcher and a writer under a reviewing supervisor                  |
| `workflow`         | A multi-step pipeline of agents                                         |
| `durable-workflow` | A saga with compensation, an approval step and crash recovery           |
| `a2a`              | An agent other frameworks call over the Agent-to-Agent protocol         |
| `voice-realtime`   | Speech in, speech out over WebSocket                                    |
| `evals`            | Measure an agent on a dataset and gate CI on the score                  |

`--list-templates` prints them, `--template <name>` is an alias of `--preset`. A preset is only a starting point: every flag below changes it.

## Flags

| Flag                                  | What it does                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `[directory]`                         | Where the project goes; its last segment becomes the package name                                                          |
| `-t, --preset <name>`                 | A preset from the table above                                                                                              |
| `--template <name\|repo>`             | A preset, or `github:owner/repo[/path][#ref]` to copy a repository                                                         |
| `--example <name[#ref]>`              | A runnable example of the Cogitator repository, see `--list-examples`                                                      |
| `--app <kind>`                        | `script`, `server`, `next`, `channels`, `worker`                                                                           |
| `--server <framework>`                | `hono`, `express`, `fastify`, `koa`, `tetsu`                                                                               |
| `--channels <list>`                   | `telegram`, `discord`, `slack`, `webchat`                                                                                  |
| `--memory <kind>`                     | `none`, `memory`, `sqlite`, `postgres`, `redis`, `mongodb`                                                                 |
| `--vector-store <store>`              | For RAG: `memory`, `postgres`, `qdrant`                                                                                    |
| `--features <list>`                   | Add-ons: `harness`, `mcp`, `rag`, `workflows`, `durable`, `swarms`, `evals`, `otel`, `langfuse`, `voice`, `sandbox`, `a2a` |
| `--deploy <target>`                   | `none`, `docker`, `fly`                                                                                                    |
| `--[no-]docker`                       | `docker-compose.yml` for the local services (default on)                                                                   |
| `-p, --provider <name>`               | `ollama`, `openai`, `anthropic`, `google`                                                                                  |
| `-m, --model <id>`                    | The model at the provider, the provider's default otherwise                                                                |
| `--api-key <key>`                     | Written to `.env` and checked against the provider                                                                         |
| `--pm <name>`                         | `pnpm`, `npm`, `yarn`, `bun` (default: the one running the scaffolder)                                                     |
| `--agent <list>`                      | Coding-agent setup: `claude`, `cursor`, `codex`, `none`                                                                    |
| `--[no-]git`, `--[no-]install`        | Create the git repository, install the dependencies (both on by default)                                                   |
| `--no-telemetry`                      | Send no anonymous usage event, see [Telemetry](https://cogitator.app/docs/getting-started/telemetry)                       |
| `-y, --yes`                           | Ask nothing                                                                                                                |
| `--dry-run`                           | Show the files, dependencies, services and variables without writing anything                                              |
| `--json`                              | Machine-readable output, implies `--yes`                                                                                   |
| `--list-templates`, `--list-examples` | List the presets or the examples                                                                                           |

Combinations that cannot work are refused before anything is written, with how to fix them: a Tetsu server needs Bun, voice needs a provider with realtime speech, A2A needs a server or Next.js, and so on.

## What a project contains

Every project, whatever the stack:

- `src/cogitator.ts`, the registry: the runtime configured by `cogitator.yml` and every agent, workflow and swarm by name. The entry points, the tests, `cogitator dev` and `cogitator mcp` find them there.
- Three working tools in `src/tools/`: `fetch_url` with an SSRF guard, `current_time`, and a `calculator` that parses instead of evaluating.
- Tests that run offline on `mockCogitator`, a scripted model with tool calls, and a CI workflow running typecheck, lint and tests.
- `src/env.ts`, a Zod schema of every variable the project reads, matching `.env.example`.
- `AGENTS.md` with a managed block of rules for coding agents and `CLAUDE.md` pointing at it, and the Cogitator docs of the installed version in `node_modules/@cogitator-ai/core/docs/`.
- Scripts: `dev`, `build`, `start`, `test`, `typecheck`, `lint`, `format`, `doctor` and `dev:studio`.
- With `--deploy`, a production Dockerfile from `@cogitator-ai/deploy` (multi-stage, lockfile install, non-root user, only production dependencies) and `fly.toml` for Fly.io.
- With `--agent`, the `cogitator` MCP server and a skill for Claude Code (`.mcp.json`, `.claude/skills`), Cursor (`.cursor/mcp.json`, `.cursor/skills`) or Codex (`.codex/config.toml`, `.agents/skills`).

The `@cogitator-ai/*` packages are pinned with a caret to the versions released with the scaffolder, and `package.json` records the spec and the command that recreate the project under `cogitator`.

## Growing a project

`cogitator add` brings what the scaffolder generates into an existing project, with the same code a new project would get:

```bash
npx cogitator add rag
npx cogitator add --memory postgres --dry-run
```

It merges into files you changed where it can (package.json, cogitator.yml, docker-compose.yml, the managed block of AGENTS.md, .gitignore), and refuses with a diff when it cannot. See the [CLI](https://www.npmjs.com/package/@cogitator-ai/cli).

## Examples and templates

`--example core/basic-agent` turns a runnable example of the repository into a project: the example and the files it imports are fetched at the tag of the scaffolder version (`#main` or any ref after the name picks another), with a package.json, tsconfig, `.env.example` and README around them. `--list-examples` lists them.

`--template github:owner/repo/path#ref` copies a repository or a directory of one. Only regular files are extracted, `workspace:` ranges of `@cogitator-ai/*` become the released versions, and a template that depends on its own monorepo is refused before anything is installed. `GITHUB_TOKEN` reaches private repositories.

## Programmatic API

```ts
import { planProject, scaffold, type ScaffoldLogger } from 'create-cogitator-app';

const spec = {
  name: 'my-agent',
  preset: 'basic',
  app: 'script',
  memory: 'sqlite',
  provider: 'ollama',
  model: 'qwen3.5:4b',
  packageManager: 'pnpm',
} as const;

const plan = planProject(spec);
console.log(plan.files.length, plan.command);

const log: ScaffoldLogger = {
  start: (message) => console.log(`... ${message}`),
  done: (message) => console.log(`ok  ${message}`),
  fail: (message) => console.log(`!!  ${message}`),
  warn: (message) => console.log(`??  ${message}`),
};
const result = await scaffold(spec, { directory: './my-agent', install: true, git: true, log });
if (result.install.status === 'failed') console.error(result.install.error.message);
```

`planProject(spec)` is pure: it validates the spec, refuses combinations that cannot work (`IncompatibleSpecError` with the issues) and returns the files, dependencies, scripts, environment, services and the command that recreates the project. `scaffold(spec, options)` writes the plan, installs, formats, writes the lock and commits; the `log` option replaces the CLI's spinners, and a failed install, format or git step is reported in the result (`{ status: 'done' | 'skipped' | 'failed' }`) instead of thrown.

Also exported: `planAdd` and `addToProject` behind `cogitator add`, `createFromExample` and `createFromTemplate`, the catalogs (`PRESETS`, `FEATURE_CHOICES` and the rest), `compatibilityIssues`, `checkApiKey`, the Ollama helpers and the telemetry functions.

## License

MIT
