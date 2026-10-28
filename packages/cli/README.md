# @cogitator-ai/cli

Command-line interface for the Cogitator AI agent runtime. Scaffold projects and grow them with `cogitator add`, debug them in Cogitator Studio, give coding agents the docs over MCP, check that a project can run, score it with evals, run assistants in the foreground or as a background service, chat with agents from the terminal, manage Ollama models and Docker services, and deploy.

## Installation

```bash
# Global installation (recommended)
pnpm add -g @cogitator-ai/cli

# Or use with npx
npx @cogitator-ai/cli <command>
```

Requires Node.js 22.12+.

Full reference: [cogitator.app/docs/cli](https://cogitator.app/docs/cli)

## Quick Start

There are two ways to build an assistant:

```bash
# A) Config-driven personal assistant (no code)
cogitator wizard        # answers → cogitator.yml + .env
cogitator up            # run it

# B) Code-first project
npx create-cogitator-app my-assistant   # or: cogitator init my-assistant for a messaging bot
cd my-assistant
pnpm dev
cogitator dev           # Cogitator Studio: chat, traces, approvals, workflows, forks
```

Quick one-off chat with any model:

```bash
cogitator run -m ollama/llama3.1:8b "What is the capital of France?"
```

---

## Commands

| Command                    | Description                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cogitator init [name]`    | Scaffold a messaging assistant project (the `channels` preset of create-cogitator-app)                          |
| `cogitator add [features]` | Add rag, mcp, workflows, evals, memory, deploy and the other generated features to a project                    |
| `cogitator dev`            | Open Cogitator Studio for the project                                                                           |
| `cogitator mcp`            | Serve the Cogitator docs and the project to coding agents over MCP (stdio)                                      |
| `cogitator doctor`         | Check that a project can run: Node, packages, config, keys, models and services                                 |
| `cogitator eval [files]`   | Run the eval suites and fail when an assertion fails                                                            |
| `cogitator wizard`         | Interactive setup that writes `cogitator.yml` + `.env`                                                          |
| `cogitator up`             | Run the assistant from `cogitator.yml`, or start Docker services                                                |
| `cogitator down`           | Stop Docker Compose services                                                                                    |
| `cogitator assistant`      | Run a gateway module (`src/gateway.ts`) with a live dashboard                                                   |
| `cogitator run [msg]`      | Chat with an agent (one-shot or interactive REPL), or run headless with `-p` (text, JSON or stream-json)        |
| `cogitator app-server`     | Serve the typed JSON-RPC app-server on stdio, write its client (`generate-ts`) and JSON Schema                  |
| `cogitator build`          | Bundle a gateway into a self-starting `dist/cogitator.mjs`                                                      |
| `cogitator daemon <cmd>`   | Run in the background / install as a launchd or systemd service                                                 |
| `cogitator skill <cmd>`    | Create, validate, install and remove skills                                                                     |
| `cogitator models`         | List or pull Ollama models                                                                                      |
| `cogitator status`         | Show Docker Compose and Ollama status (alias: `ps`)                                                             |
| `cogitator logs`           | View Docker Compose service logs                                                                                |
| `cogitator deploy`         | Deploy with Docker or Fly.io (see [`@cogitator-ai/deploy`](https://www.npmjs.com/package/@cogitator-ai/deploy)) |
| `cogitator rewind`         | Rewind a thread's conversation, memory and files to an entry, a dry run first                                   |
| `cogitator plugin <cmd>`   | Install, update, enable, disable and validate plugins and marketplaces, run plugin evals (experimental)         |
| `cogitator schedule <cmd>` | List, add, run now, pause, resume and remove the schedules of routines (experimental)                           |
| `cogitator inbox`          | Read the inbox of routines: results, failures and questions (experimental)                                      |
| `cogitator trigger <cmd>`  | Fire an API trigger of a running server, issue a trigger token (experimental)                                   |

Every command ends with examples in its `--help`.

### Output and exit codes

Every command exits with `0` when it did what was asked, `1` when it could not (a failed check, deploy or install, a missing service) and `2` when the command line is wrong (an unknown option, command or value, with the closest valid name). Failures print the message and what to do about it on stderr; `COGITATOR_DEBUG=1` adds the stack trace. With `--json` (`add`, `doctor`, `eval`, `models`, `status`, `deploy`) the result goes to stdout as JSON, and a failure as `{ "ok": false, "error": { "message", "exitCode", "hints" } }`.

---

### cogitator init

Creates a messaging assistant project: the `channels` preset of [create-cogitator-app](https://www.npmjs.com/package/create-cogitator-app), generated by the same engine, with the provider, model, channels and memory you choose.

```bash
cogitator init my-assistant            # prompts for provider, model, channels, memory
cogitator init my-assistant --no-install --no-git --no-telemetry
```

The prompts cover the LLM provider (Anthropic, OpenAI, Google or Ollama) and model, channels (Telegram, Discord, Slack, WebChat, Bluesky, Threads, GitHub, email, Microsoft Teams) with their tokens, and the memory adapter (SQLite, in-memory or Postgres). Tokens and keys go to `.env` (mode 600). The project is the same as `npx create-cogitator-app my-assistant --preset channels`: the registry in `src/cogitator.ts`, tests on a mocked model, `cogitator.yml`, `AGENTS.md`, Cogitator Studio and the rest. The assistant is `src/gateway.ts`, the `gateway` export that `cogitator assistant`, `cogitator build` and `cogitator daemon` run, and `src/index.ts` starts it for `dev` and `start`. When the project has compose services (Postgres memory, the Ollama container) and Docker is running, it offers to start them the way create-cogitator-app does, before it prints the next steps. A Postgres URL of your own leaves the compose Postgres out.

---

### cogitator add

```bash
cogitator add rag                       # answers grounded in docs/
cogitator add workflows evals           # two features at once
cogitator add --memory postgres         # switch the memory adapter
cogitator add --deploy docker --dry-run # every diff, nothing written
cogitator add --agent claude            # MCP config and skill for Claude Code
```

Grows a project created by create-cogitator-app or `cogitator init` with the same feature modules that generated it: the project and its extended spec are both planned, and what the addition changes between them is merged into the files on disk. Files still as generated (by the hashes in `.cogitator/scaffold.json`) take the change; `package.json`, `cogitator.yml`, `docker-compose.yml` and `pnpm-workspace.yaml` merge key by key, keeping your values and comments; the managed block of `AGENTS.md` is rewritten and the rest kept; `.gitignore` gains missing lines; an edited README is left with a note. Any other file you edited that the addition changes is a conflict: nothing is written, and the change is printed as a diff. Adding what the project has is a no-op. New dependencies are installed (`--no-install` skips it), the written files formatted, and the new spec and command recorded in `package.json`.

---

### cogitator dev

```bash
cogitator dev                         # http://localhost:4321, opens the browser
cogitator dev --port 4400 --no-open
cogitator dev --host 0.0.0.0          # reachable from your network, with a token in the URL
```

Opens [Cogitator Studio](https://www.npmjs.com/package/@cogitator-ai/studio) for the project in the current directory: chat with every agent of `src/cogitator.ts` (streamed answers, reasoning, tool calls, stop, threads), approve tool calls that need it, read the waterfall trace of each run with nested agents, tokens and cost per model call, run workflows with live node statuses and rerun them from a node, and fork a run from any step with a changed input or tool result. The project runs in a child process that reloads when you save (`--no-watch` turns it off). History lives in `.cogitator/studio/`.

---

### cogitator mcp

A stdio MCP server for Claude Code, Cursor and Codex, configured by `create-cogitator-app --agent` or `cogitator add --agent`:

| Tool              | What it does                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `search_docs`     | Searches the docs bundled with the installed `@cogitator-ai/core`, best passages first     |
| `read_doc`        | Reads a page, or one section with `path#section`                                           |
| `inspect_project` | The agents (model, instructions, tool schemas), workflows and swarms of `src/cogitator.ts` |
| `check_project`   | Runs `cogitator doctor`, offline unless asked                                              |

The registry loads in a child process, so the agent always sees the current code and the project's own output never reaches the MCP stream. The server finds the project from a subdirectory, or takes `--project <dir>`.

---

### cogitator doctor

```bash
cogitator doctor            # Node, packages, cogitator.yml, keys, services, models
cogitator doctor --offline  # no provider or service probes
cogitator doctor --json
```

Checks the Node version against `engines`, the installed `@cogitator-ai/*` packages, `cogitator.yml`, the variables `src/env.ts` requires, the provider key (with a cheap call), Redis, Postgres and the other services the config uses, and the Ollama models. Each problem comes with the fix; it exits `1` when one fails.

---

### cogitator eval

```bash
cogitator eval                                   # every evals/*.eval.ts
cogitator eval evals/answers.eval.ts --max-cases 5
cogitator eval --json --report eval-report.json  # for CI
cogitator eval --skip-without-key                # exit 0 on forks without the key
```

Runs eval suites (files exporting an `EvalSuite` from `@cogitator-ai/evals` as default) and exits `1` when an assertion fails or every case errored.

---

### cogitator wizard

Interactive setup for the config-driven personal assistant run by `cogitator up`.

```bash
cogitator wizard          # create cogitator.yml (+ .env)
cogitator wizard --edit   # edit an existing cogitator.yml, pre-filling current values
```

The wizard asks for your name and the assistant's name, the LLM provider and model (models are fetched live from the provider registry or your Ollama server), channels (Telegram, Discord, Slack, Bluesky, Threads, GitHub, email, Microsoft Teams with owner IDs), capabilities (web search, file system, GitHub, device tools, browser, scheduler, RAG, self-config, self-tools), MCP servers (quoted arguments are supported), the SQLite memory path and the assistant's personality. A terminal channel is always available.

Secrets are merged into `.env` without touching your other variables or comments. In `--edit` mode, leaving a secret blank keeps the current value, and existing MCP servers and advanced settings (security, rate limits, …) are preserved. The wizard does not ask about WhatsApp, WebChat or Postgres memory, but keeps them: `channels.whatsapp` / `channels.webchat` entries stay as they are, and a `memory.adapter: postgres` config is kept (the SQLite path prompt is skipped).

See the [wizard guide](https://cogitator.app/docs/channels/wizard) for the generated `cogitator.yml`.

---

### cogitator up / down

```bash
cogitator up                       # ./cogitator.yml (or .yaml) → run the assistant
cogitator up -c path/to/assistant.yml
cogitator up --no-restart-loop     # run in-process, without the restart supervisor
```

When a `cogitator.yml` exists, `up` validates it (errors list the offending fields), loads the `.env` next to it into `process.env` without overriding variables that are already set (so tools that read `process.env`, such as `web_search` and `github_api`, see the wizard's keys) and starts the assistant. Unless `--no-restart-loop` is given, `up` runs the assistant in a child process and starts it again whenever it exits with code `78` — the owner `/restart` command and self-config updates; `SIGINT`/`SIGTERM` are forwarded for a graceful shutdown. With `--no-restart-loop` the assistant runs in the `up` process and simply stops on `/restart`.

A `cogitator.yml` made only of [`@cogitator-ai/config`](https://www.npmjs.com/package/@cogitator-ai/config) runtime keys (`llm.defaultModel`, `memory`, `sandbox`, … — the file create-cogitator-app generates) is not an assistant config: your project's code loads it. `up` then starts the project's Docker Compose services, or, without a compose file, exits explaining that you start the project itself (e.g. `pnpm dev`). `up -c` with such a file fails with the same explanation, and `cogitator daemon` skips it when auto-detecting what to run.

Without an assistant config, `up` manages the Docker Compose project found in the current or a parent directory (`docker-compose.yml`, `compose.yml`, …):

| Option         | Default | Description                        |
| -------------- | ------- | ---------------------------------- |
| `-d, --detach` | `true`  | Run services in background         |
| `--no-detach`  | -       | Run services in foreground         |
| `--pull`       | `false` | Pull latest images before starting |

After starting, the published ports of every service are printed.

```bash
cogitator down             # stop services (keep data)
cogitator down --volumes   # stop and delete volumes
```

---

### cogitator assistant

Runs a module that exports a `gateway` (as generated by `init`) with a live dashboard.

```bash
cogitator assistant                    # src/gateway.ts
cogitator assistant -c src/my-gw.ts
cogitator assistant --quiet            # no banner, status line or hotkeys (used by the daemon)
```

TypeScript modules are loaded through [`tsx`](https://tsx.is), resolved from your project first. `.env` in the working directory is loaded before the module. Hotkeys (interactive terminals only): `s` sessions, `c` channels, `h` help, `q` quit.

---

### cogitator run

Run an agent with a message, or start an interactive REPL when no message is given.

```bash
cogitator run "Explain quantum computing in simple terms"
cogitator run -m openai/gpt-6.1-sol "Analyze this code..."
cogitator run --no-stream "Hello"
cogitator run            # interactive
```

| Option                | Default     | Description                         |
| --------------------- | ----------- | ----------------------------------- |
| `-c, --config <path>` | auto        | Config file (must exist when given) |
| `-m, --model <model>` | auto-detect | Model, e.g. `ollama/qwen3:8b`       |
| `-i, --interactive`   | `false`     | Force interactive mode              |
| `-s, --stream`        | `true`      | Stream response tokens              |
| `--no-stream`         | -           | Disable streaming                   |

**Config resolution:** `-c` → `COGITATOR_CONFIG` → `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml`, `.cogitator.yaml`, `cogitator.json`. The `.env` next to the file (or in the working directory without one) is loaded first, without overriding variables already set. The file is loaded with [`@cogitator-ai/config`](https://www.npmjs.com/package/@cogitator-ai/config), so `${ENV}` references and `COGITATOR_*` / provider environment variables apply even without a file. An assistant config from `cogitator wizard` is not a runtime config: `run` takes its `llm.provider` and `llm.model` as the model and everything else from the environment (`cogitator up` runs the assistant itself).

**Model resolution:** `-m` → `COGITATOR_MODEL` → `llm.defaultModel` from the config → the model of an assistant config → first installed Ollama model (preferring qwen3:8b, qwen3.5:9b, llama3.1:8b, llama3:8b, gemma3:4b, gemma2:9b, mistral:7b). Ollama is reached at `llm.providers.ollama.baseUrl`, `OLLAMA_URL` or `OLLAMA_HOST`.

Interactive commands: `/model [name]`, `/clear`, `/help`, `exit` / `quit` (Ctrl+D also exits).

#### Headless: `cogitator run -p`

`-p` (`--print`) runs one session without a terminal, for scripts, CI and other programs. Only the answer, or protocol lines, reach stdout: the CLI's messages and the runtime's logs go to stderr.

```bash
cogitator run -p "Name three primary colors"
git diff | cogitator run -p "Review this diff"
cogitator run -p --output-format json "Summarize README.md"
cogitator run -p --json-schema '{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}' "Capital of France?"
cogitator run -p --resume <session-id> "And of Italy?"
cogitator run -p --resume <session-id> --fork "Try another answer"
cogitator run -p --input-format stream-json --output-format stream-json < turns.ndjson
```

| Option                     | Default | Description                                                                    |
| -------------------------- | ------- | ------------------------------------------------------------------------------ |
| `-p, --print`              | -       | Run headless: the prompt from the argument, stdin after it when piped          |
| `--output-format <format>` | `text`  | `text` (the answer), `json` (one result object), `stream-json` (NDJSON events) |
| `--input-format <format>`  | `text`  | `stream-json` reads turns as NDJSON lines on stdin (needs stream-json output)  |
| `--resume <session-id>`    | -       | Continue a kept session                                                        |
| `--fork`                   | -       | With `--resume`: continue in a new session forked from it                      |
| `--session-id <id>`        | new     | The id of the new session (with `--resume`, only together with `--fork`)       |
| `--json-schema <schema>`   | -       | JSON Schema, inline or a file, the answer must match: printed as that JSON     |
| `--no-session-persistence` | -       | Keep the session in this process only, over `memory.adapter` too               |

A stream-json line is a `StreamEvent` of the stream protocol (`start`, `text-delta`, `tool-call-start`, `tool-result`, `finish` and the others) with `session_id` and `parent_tool_use_id`, which names the tool call of a subagent's run and is `null` at the top. Each turn ends with a `result` line: `subtype` `success`, `paused`, `interrupted` or `error`, `is_error`, `session_id`, `result`, `structured_output`, `usage`, `total_cost_usd`, `duration_ms`, and `pending_approvals` with `interrupts` for a paused turn. `--output-format json` prints that result line alone.

stream-json input takes one line per message:

```json
{"type":"user","message":{"role":"user","content":"Plan the release"}}
{"type":"user","message":{"role":"user","content":"Skip the changelog"},"delivery":"steer"}
{"type":"resume","decisions":{"call_1":{"approved":true}}}
{"type":"interrupt"}
```

A `user` line without `delivery` is a turn of its own, run after the turns before it. With `delivery` (`steer`, `followUp` or `inject`) it reaches the turn going on or starting, and starts a turn when there is none. `content` is text or parts (`{"type":"text"}`, images as `{"type":"image","url"}` or Claude Code's `{"type":"image","source":{"type":"base64",...}}`). `resume` answers a paused turn, `interrupt` stops the turn going on. A line that cannot be read is skipped with a note on stderr.

Exit codes: `0` when the last turn completed, `1` when it failed, was interrupted or missed `--json-schema`, `2` for a wrong command line, `3` when it was left paused (approve with a `resume` line).

Without `memory.adapter` in the config, sessions are kept in SQLite at `~/.cogitator/sessions.db` (`COGITATOR_SESSIONS_DB` names another file), so `--resume` works across runs. A config with `memory.adapter` keeps them there. `--no-session-persistence` keeps the session in the process alone, also over a configured `memory.adapter`, and does not go with `--resume`.

---

### cogitator app-server

Serves the JSON-RPC app-server of [`@cogitator-ai/app-server`](https://www.npmjs.com/package/@cogitator-ai/app-server) on stdin and stdout as NDJSON: threads, turns, steering, approvals (`approval/request`), reviews and the `_cogitator/*` extensions, with the agent of `cogitator run` (`-c`, `-m` and the session store work the same). Logs go to stderr. When stdin ends the turns going on are interrupted and the process exits.

```bash
cogitator app-server -m ollama/qwen3:8b
cogitator app-server generate-ts --out src/generated          # cogitator-app-server.ts, the typed client
cogitator app-server generate-json-schema --out schema        # cogitator-app-server.schema.json
```

---

### cogitator build

Bundles a gateway module with [esbuild](https://esbuild.github.io) into a single self-starting ES module. The bundle starts the exported `gateway` and stops it gracefully on `SIGINT`/`SIGTERM`. esbuild ships with the CLI, so the project needs no extra dependency.

```bash
cogitator build                     # src/gateway.ts → dist/cogitator.mjs
cogitator build -c src/gw.ts -o out/bot.mjs --minify --no-sourcemap
node dist/cogitator.mjs
```

| Option                 | Default              |
| ---------------------- | -------------------- |
| `-c, --config <path>`  | `src/gateway.ts`     |
| `-o, --outfile <path>` | `dist/cogitator.mjs` |
| `--target <version>`   | `node22`             |
| `--sourcemap`          | `true`               |
| `--minify`             | `false`              |
| `-q, --quiet`          | `false`              |

Only the project's own code is bundled: every package stays an import resolved from `node_modules` at runtime, since packages ship native addons (`better-sqlite3`, the `ssh2` behind the Docker sandbox) and optional drivers loaded on demand. Run the bundle where the project's dependencies are installed.

---

### cogitator daemon

Runs your assistant in the background. The entry is auto-detected in this order: `dist/cogitator.mjs` (from `cogitator build`), an assistant `cogitator.yml` / `cogitator.yaml` (via `cogitator up`; a runtime config is skipped), `src/gateway.ts` (via `cogitator assistant --quiet`). Use `-c` to choose explicitly.

```bash
cogitator daemon start [-c <entry>]
cogitator daemon status          # PID, uptime, memory
cogitator daemon logs -f -n 100  # .cogitator/daemon.log
cogitator daemon restart [-c <entry>]
cogitator daemon stop            # SIGTERM, then SIGKILL after ~10s

cogitator daemon install [-c <entry>]   # launchd (macOS) or systemd --user (Linux)
cogitator daemon uninstall
```

The PID file (`.cogitator/daemon.pid`) records the launched script, so `stop` never signals an unrelated process that reused the PID. Service definitions use absolute paths, the current `PATH`, and start on login (`loginctl enable-linger` keeps a systemd user service running after logout).

---

### cogitator rewind

```bash
cogitator rewind thread_42                                  # the active branch, entries with a file checkpoint marked [files]
cogitator rewind thread_42 entry_abc --files --dry-run      # what would change
cogitator rewind thread_42 entry_abc --files                # shows the plan, asks, rewinds conversation, memory and files
cogitator rewind thread_42 entry_abc --files --no-memory -y # restore the files only, without a prompt
```

Loads the runtime and agents the registry exports (`src/cogitator.ts`, `--registry` for another) and calls `cog.rewind()`. `--agent <key>` picks the agent whose workspace to restore (the thread's agent by default), `--force` aborts the runs going on in the thread, `--json` prints the report. Without a terminal it needs `--yes`, and `--json` needs `--dry-run` or `--yes`. A thread whose agent has no configured `id` falls back to the only registry agent with a workspace. It sees runs of other processes only when they are durable, and warns when runs are not durable by default. See [File Checkpoints and Rewind](https://cogitator.app/docs/core/file-checkpoints).

---

### cogitator plugin

Manage [plugins](https://cogitator.app/docs/core/plugins) in the format of Claude Code's plugins and the marketplaces they come from (experimental). Plugins are kept under `COGITATOR_PLUGINS_DIR` (default `~/.cogitator/plugins`), and every install is pinned to the exact commit, npm version and integrity or archive digest it fetched.

```bash
cogitator plugin marketplace add your-org/claude-plugins
cogitator plugin install formatter@your-org --scope project
cogitator plugin install npm:@acme/review-kit@^2.0.0
cogitator plugin install git+https://git.example.com/tools.git#v1.2.0
cogitator plugin configure formatter@your-org --set endpoint=https://x.example --secret token
cogitator plugin list --json
cogitator plugin update
cogitator plugin disable formatter@your-org
cogitator plugin uninstall formatter@your-org --prune --yes
cogitator plugin validate ./my-plugin --strict
cogitator plugin eval ./my-plugin
```

| Subcommand                                                                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install <plugin>` (`i`)                                                    | From a marketplace (`name@marketplace`), npm (`npm:<package>[@version]`) or git (`git+<url>[#ref]`, `github:<owner>/<repo>[#ref]`). `-s, --scope user\|project\|local` picks the settings file that enables it, `--config key=value` sets options, `--secret key` reads a secret from the terminal, `--marketplace <source>` adds the marketplace first, `-y, --yes` grants the permissions the plugin asks for and runs a `command` source without asking                                                                                                                                      |
| `uninstall <plugin>` (`remove`, `rm`)                                       | Removes its files, data (`--keep-data` keeps it), options, secrets and `enabledPlugins` entries, `--prune` also the dependencies nothing needs. Refused while an installed plugin depends on it                                                                                                                                                                                                                                                                                                                                                                                                 |
| `enable <plugin>`, `disable <plugin>`                                       | Writes `enabledPlugins` of the scope, without `--scope` of the settings file that decides now (local, project, user), else the user's, and warns when a higher layer still decides otherwise. Enabling needs the dependencies installed, disabling is refused while an enabled plugin depends on it, managed settings win                                                                                                                                                                                                                                                                       |
| `update [plugin]`                                                           | Fetches the source again and installs a new version only when its version changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `list`                                                                      | The installed plugins, enabled or not, with load errors. `--available --json` adds what the marketplaces offer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `configure <plugin>`                                                        | `--set key=value`, `--secret key`, `--unset key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `validate <path>`                                                           | As `claude plugin validate`: exit 0 passed, 1 failed, 2 when the check itself failed, `--strict` fails on warnings                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `marketplace add <source>`, `list`, `remove <name>` (`rm`), `update [name]` | `owner/repo`, a git URL, an https link to a `marketplace.json` or a local folder or file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `eval [target]`                                                             | Runs the plugin's eval cases in the format of `claude plugin eval`, with and without the plugin, and prints `CASE WITH W/OUT Δ RUNS COST NOTES`. `--runs`, `-j, --concurrency`, `--model`, `--judge-model`, `--ablation none\|with-without`, `--threshold`, `--max-cost-usd`, `--allow-tools`, `--scaffold`, `--case`, `--tag`, `--eval-dir`, `--json [path]`, `--output-dir`, `--keep-temp`, `--verbose`, and Claude Code's `--trust-plugin`, `--no-publish`, `--publish-report` and `--mocks record`, which change nothing. See [Plugin evals](https://cogitator.app/docs/evals/plugin-evals) |

Every subcommand that changes something takes `--json` and then prints one object with `command`, `outcome` (`ok` or `failed`), `message` and, on a failure, `failureCode`.

`plugin eval` writes `aggregate-result.json` and a self-contained `report.html` under `<eval dir>/results/<timestamp>/` and exits as `claude plugin eval` does: `0` when every case met `--threshold`, `1` for a case below it, a case that failed to load or a run that ended on a provider error, `2` for a partial run (the `--max-cost-usd` ceiling), `130` when interrupted and `143` when terminated. A command-line error (an unknown option, a wrong value) exits `1`, not `2`, and `--mocks off` and `--allow-real-servers` exit `1` since real plugin MCP servers are not started. `--json` prints its result document instead of the object above.

### cogitator schedule, inbox and trigger

Manage the [routines](https://cogitator.app/docs/core/triggers) a runtime keeps in files (experimental): `experimental_fileTriggerStores()` puts the routine store, the schedules and the inbox in `.cogitator/triggers` (`COGITATOR_TRIGGERS_DIR`, `--dir`), the runtime polls them while the CLI changes them, and file locks keep the two from losing each other's writes.

```bash
cogitator schedule add digest --cron "0 9 * * 1-5" --timezone Europe/Moscow --agent assistant --prompt "Summarize the news"
cogitator schedule list
cogitator schedule run digest         # due now: the runtime runs it on its next poll
cogitator schedule pause digest.cron  # one trigger, or a whole routine by its id
cogitator schedule resume digest
cogitator schedule rm digest
cogitator inbox --unread
cogitator inbox show inbox_abc
cogitator inbox archive inbox_abc
cogitator trigger token digest.api    # shown once, the store keeps its SHA-256
cogitator trigger fire digest.api --text "Breaking news" --url http://localhost:3000/cogitator
```

| Subcommand                                            | Description                                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule list` (`ls`)                                | The routines of the store with their triggers, and every pending schedule, those of routines in code and the tasks agents gave themselves included   |
| `schedule add <id>`                                   | A routine of the store on `--cron` (5 or 6 fields or a preset), `--timezone`, `--agent` or `--workflow`, `--prompt`, `--catch-up`, `--overlap`       |
| `schedule run <id>`                                   | Makes the schedule due now. Triggers without a schedule fire through their API                                                                       |
| `schedule pause <id>`, `resume <id>`                  | A schedule, a routine or `<routine>.<trigger>`, kept in the trigger state so a restart keeps it. A resumed schedule goes on from its next occurrence |
| `schedule rm <id>`                                    | A routine of the store with its schedules, or a schedule entry. Routines in code are paused, not removed                                             |
| `inbox [--unread\|--all\|--archived] [--kind <kind>]` | Unread and read items by default, newest first                                                                                                       |
| `inbox show\|read\|unread\|archive <id>`              | One item in full, or its status                                                                                                                      |
| `trigger fire <id>`                                   | `POST /triggers/<id>/fire` with `--text`, `--url` or `COGITATOR_URL`, `--token` or `COGITATOR_TRIGGER_TOKEN`, `--idempotency-key`                    |
| `trigger token <id>`                                  | A new token for an API trigger of a routine of the store, the one before stops working                                                               |

Every subcommand takes `--json`.

### cogitator skill

```bash
cogitator skill create weather-api --template api   # basic | device | api; --global for ~/.cogitator/skills
cogitator skill validate skills/weather-api         # defaults to the current directory
cogitator skill list
cogitator skill add ./path/to/skill [--global]
cogitator skill remove weather-api [--global]
```

Local skills live in `./skills`, global ones in `~/.cogitator/skills`. Skill names must be kebab-case. `validate` loads `skill.ts`/`skill.js`/`skill.mjs`, checks the `defineSkill` shape and every tool, required environment variables (`env`) and that `dependencies` resolve from the skill's location; it exits non-zero on problems.

---

### cogitator models

```bash
cogitator models                       # list installed models
cogitator models --pull qwen2.5:0.5b   # pull with progress
cogitator models --url http://gpu-box:11434
cogitator models --json                # name, size and date of each model
```

The Ollama URL is chosen in this order: an explicit `--url`, the configured `llm.providers.ollama.baseUrl`, `OLLAMA_BASE_URL` (then the `OLLAMA_URL` and `OLLAMA_HOST` aliases Ollama itself reads, port 11434 when none is given and `0.0.0.0` as `localhost`), and finally `http://localhost:11434`. An explicit `--url` uses that server's own connection, so the configured server's `apiKey` and `headers` are never sent to it. `OLLAMA_API_KEY` is sent as a bearer token. Custom headers in `llm.providers.ollama.headers` are sent with model discovery, pulls, `run` model detection, `doctor` and `status` probes, `Content-Type` and the API key's `Authorization` take precedence. Pull errors reported by Ollama (e.g. unknown model) fail the command.

---

### cogitator status / logs

```bash
cogitator status          # compose services (state, health) + Ollama reachability
cogitator status --json
cogitator logs ollama -f -t -n 50
cogitator logs -n all
```

| Option               | Default | Description                       |
| -------------------- | ------- | --------------------------------- |
| `[service]`          | all     | Service name (redis, postgres, …) |
| `-f, --follow`       | `false` | Follow log output                 |
| `-n, --tail <lines>` | `100`   | Number of lines, or `all`         |
| `-t, --timestamps`   | `false` | Show timestamps                   |

`status` still reports Ollama when Docker is not running.

---

### cogitator deploy

```bash
cogitator deploy --dry-run          # analyze + preflight only
cogitator deploy --dry-run --json   # the plan for scripts and CI: secrets, services, warnings, checks
cogitator deploy                    # docker: build image, start compose stack
cogitator deploy --target fly --region ord
cogitator deploy --registry ghcr.io/acme   # build + push (use --no-push to skip)
cogitator deploy status
cogitator deploy logs -f            # stream the logs (docker compose logs / flyctl logs)
cogitator deploy logs ollama-pull   # docker: one compose service, the last 100 lines
cogitator deploy destroy
```

| Option                  | Description                              |
| ----------------------- | ---------------------------------------- |
| `-t, --target <target>` | `docker` (default) or `fly`              |
| `-c, --config <path>`   | Config file to deploy from               |
| `--registry <url>`      | Container registry to push to            |
| `--no-push`             | Skip pushing even when a registry is set |
| `--dry-run`             | Show the plan without executing          |
| `--region <region>`     | Deploy region (Fly.io)                   |
| `--json`                | The plan, result or status as JSON       |
| `-f, --follow`          | `logs`: keep streaming new lines         |
| `-n, --tail <lines>`    | `logs`: lines to show or `all` (docker)  |
| `--timestamps`          | `logs`: prefix lines with time (docker)  |

The model, memory and `deploy:` section all come from one config file: the `-c` file, else the first of `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml`, `.cogitator.yaml`. The plan lists the kind (server or worker), detected services (marked as not provisioned on Fly, where `REDIS_URL` / `DATABASE_URL` are required instead), volumes, required secrets (read from the environment or the project's `.env`), warnings and preflight checks. On Docker the deploy only succeeds when the app container keeps running after it starts, otherwise its last log lines are shown. A project whose models run on a local Ollama gets an `ollama` service in the compose stack that pulls them on the first start. `deploy logs [service]` runs `docker compose logs` for the deployed stack (every service, or `app`, `ollama`, `ollama-pull`, `redis`, `postgres`) and `flyctl logs --app <app>` on Fly, where the app is `deploy.app` (else the image name) and a new app is created in `deploy.org`. `--timestamps` has no short flag, `-t` is `--target`. A flag that does not apply to the action, such as `--follow` on `deploy status` or `--json` on `deploy logs`, and the docker-only service name, `--tail` and `--timestamps` on Fly are refused as usage errors (exit code 2). See [`@cogitator-ai/deploy`](https://www.npmjs.com/package/@cogitator-ai/deploy) and the [deploy guide](https://cogitator.app/docs/deployment/deploy-package) for details.

---

## Environment Variables

| Variable                                                | Used by                                 | Description                                |
| ------------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| `COGITATOR_CONFIG`                                      | `run`                                   | Config file path                           |
| `COGITATOR_MODEL`                                       | `run`                                   | Default model                              |
| `COGITATOR_SESSIONS_DB`                                 | `run -p`, `app-server`                  | SQLite file of the sessions                |
| `COGITATOR_PLUGINS_DIR`                                 | `plugin`, runtime                       | Where installed plugins are kept           |
| `COGITATOR_TRIGGERS_DIR`                                | `schedule`, `inbox`, `trigger`, runtime | Where the file stores of routines are kept |
| `COGITATOR_URL`, `COGITATOR_TRIGGER_TOKEN`              | `trigger fire`                          | The server and the trigger's token         |
| `OLLAMA_URL` / `OLLAMA_HOST`                            | `run`, `models`, `status`               | Ollama endpoint                            |
| `OLLAMA_API_KEY`                                        | `run`, `models`, `wizard`               | Ollama Cloud / authenticated Ollama        |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` | `run`, `init`, `wizard`                 | Provider keys                              |
| `COGITATOR_DEBUG`                                       | all                                     | Print stack traces                         |
| `COGITATOR_TELEMETRY_DISABLED`, `DO_NOT_TRACK`          | `init`                                  | Send no anonymous usage event              |

See [`@cogitator-ai/config`](https://www.npmjs.com/package/@cogitator-ai/config) and the [configuration guide](https://cogitator.app/docs/getting-started/configuration) for every `COGITATOR_*` variable.

## License

MIT
