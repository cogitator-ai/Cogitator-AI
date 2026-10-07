# create-cogitator-app

Interactive scaffolder for [Cogitator](https://cogitator.app) - creates a ready-to-run TypeScript AI agent project from one of six templates.

Guide: [cogitator.app/docs/getting-started/scaffolding](https://cogitator.app/docs/getting-started/scaffolding)

## Usage

```bash
# Interactive mode
npx create-cogitator-app

# With arguments
npx create-cogitator-app my-project --template basic --provider openai

# Skip every prompt with flags
npx create-cogitator-app my-project -t swarm -p ollama --pm pnpm --docker --no-git

# Accept the defaults for everything not given
npx create-cogitator-app -y
npx create-cogitator-app my-project -p openai --yes

# Use a local model you already have
npx create-cogitator-app my-project -p ollama --model llama3.2:3b -y
```

Prompts are shown only for values not given on the command line: project directory, template, provider, the Ollama model (when Ollama is running), package manager, Docker Compose and git. With `-y` / `--yes` nothing is asked and the defaults fill the gaps: `my-agents`, `basic`, `ollama` with `qwen3.5:9b`, the detected package manager, Docker Compose on, git on. The target directory must be empty or not exist. After writing the files the scaffolder runs `<pm> install` (skip it with `--no-install`) and, unless disabled, creates a git repository with an initial commit. A failed install or git step is reported and left for you to run by hand.

The last segment of the directory becomes the package name, so it has to be a valid npm package name: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. `.` creates the project in the current (empty) directory and names it after that directory. An invalid name stops the scaffolder before anything is written.

With Ollama the scaffolder checks whether the model is pulled. At the prompt it offers to pull it right away, otherwise the next steps it prints include `ollama pull <model>`. With a cloud provider they include `cp .env.example .env` and the key to set.

Requires Node.js 22.12+.

## Templates

| Template     | Description                                                              |
| ------------ | ------------------------------------------------------------------------ |
| `basic`      | Single agent with tools                                                  |
| `memory`     | Agent with Redis-backed persistent memory (`@cogitator-ai/redis`)        |
| `swarm`      | Hierarchical swarm of researcher, writer and reviewer agents             |
| `workflow`   | DAG workflow (`@cogitator-ai/workflows`) with sequential agent nodes     |
| `api-server` | Express REST API with `CogitatorServer` from `@cogitator-ai/express`     |
| `nextjs`     | Next.js App Router chat app with a streaming `/api/chat` route, Tailwind |

## CLI Flags

| Flag                       | Shorthand | Description                                               |
| -------------------------- | --------- | --------------------------------------------------------- |
| `[name]`                   |           | Project directory (its basename becomes the package name) |
| `--template <name>`        | `-t`      | Template to use                                           |
| `--provider <name>`        | `-p`      | LLM provider (`ollama`, `openai`, `anthropic`, `google`)  |
| `--model <name>`           |           | Model the agents use (default: the provider's, below)     |
| `--pm <name>`              |           | Package manager (`pnpm`, `npm`, `yarn`, `bun`)            |
| `--docker` / `--no-docker` |           | Include Docker Compose (Redis, Postgres, plus Ollama)     |
| `--git` / `--no-git`       |           | Initialize git repository                                 |
| `--no-install`             |           | Write the files without running `<pm> install`            |
| `--yes`                    | `-y`      | Don't prompt; use the defaults for every missing value    |

Unknown values for `--template`, `--provider` and `--pm` are ignored and asked for interactively (or replaced by the default with `--yes`). The package manager defaults to the one that invoked the scaffolder (`npm_config_user_agent`: npm under `npx` and `npm create`, pnpm under `pnpm create`, and so on), falling back to `pnpm`.

## Providers

| Provider    | Default Model       | Requires                                                                           |
| ----------- | ------------------- | ---------------------------------------------------------------------------------- |
| `ollama`    | `qwen3.5:9b`        | [Ollama](https://ollama.com) (`OLLAMA_BASE_URL`, default `http://localhost:11434`) |
| `openai`    | `gpt-6.1-sol`       | `OPENAI_API_KEY`                                                                   |
| `anthropic` | `claude-sonnet-5-5` | `ANTHROPIC_API_KEY`                                                                |
| `google`    | `gemini-3.8-flash`  | `GOOGLE_API_KEY`                                                                   |

## Generated Project Structure

Every project gets these files (shown for the `basic` template):

```
my-project/
├── src/
│   ├── index.ts         # Main entry point
│   └── tools.ts         # Tool definitions
├── package.json         # dev / start / build / typecheck scripts
├── tsconfig.json        # not for nextjs, which ships its own
├── cogitator.yml        # provider, model, memory and deploy settings
├── .env.example         # the provider's key (REDIS_URL for memory, API_TOKEN for api-server)
├── .gitignore           # also .env.* and, for nextjs, .next/ and next-env.d.ts
├── README.md
├── pnpm-workspace.yaml  # pnpm only
└── docker-compose.yml   # with --docker
```

Template-specific sources:

| Template     | Files                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `basic`      | `src/index.ts`, `src/tools.ts`                                                                              |
| `memory`     | `src/index.ts`, `src/tools.ts`                                                                              |
| `swarm`      | `src/index.ts`, `src/tools.ts`, `src/agents/{researcher,writer,reviewer}.ts`                                |
| `workflow`   | `src/index.ts`, `src/agents.ts`                                                                             |
| `api-server` | `src/index.ts`, `src/agents.ts`                                                                             |
| `nextjs`     | `src/lib/agent.ts`, `src/app/api/{chat,health}/route.ts`, `src/app/{page,layout}.tsx`, Next/Tailwind config |

With a cloud provider the script templates also get `src/env.ts`, whose `requireEnv()` stops the app at startup with the name of a missing key and a pointer to `.env.example`.

### Environment

The `dev` and `start` scripts of the script templates run `tsx --env-file-if-exists=.env`, so the variables in `.env` reach the app (Next.js loads `.env*` itself). Copy `.env.example` to `.env`, fill it in, then run `pnpm dev` (or `npm run dev`, `yarn dev`, `bun dev`). Generated projects declare Node.js 22.12+ in `engines`.

### Dependency versions

The `@cogitator-ai/*` packages are pinned with a caret to the versions released together with the scaffolder (for example `^0.33.0`, never `latest`), so an older cached scaffolder keeps generating projects that compile. The ranges come from the scaffolder's own manifest, where `pnpm publish` writes the versions of the packages released alongside it.

### Runtime behavior

- The script templates (`basic`, `memory`, `swarm`, `workflow`) set a non-zero exit code when the run fails, and `workflow` also fails on an error in the workflow result. `memory` and `swarm` close their connections either way.
- `api-server` and `nextjs` keep conversations in in-process memory (`memory: { adapter: 'memory' }`), so a thread remembers earlier turns and the thread routes of `api-server` answer. Switch the adapter to Redis, Postgres or SQLite to keep them across restarts.
- `api-server` listens on `127.0.0.1` in development and on `0.0.0.0` with `NODE_ENV=production` (`HOST` overrides both). With `API_TOKEN` set, every route except `/api/health`, `/api/ready`, `/api/docs` and `/api/openapi.json` needs `Authorization: Bearer <token>`, and in production the server refuses to start without it. CORS stays off unless `CORS_ORIGIN` lists the allowed origins, comma-separated.
- `nextjs` shows run errors in the chat and offers Stop while a reply streams. Its scripts are `dev`, `build`, `start` and `typecheck`.

### cogitator.yml

`cogitator.yml` is read by `cogitator run` and `cogitator deploy`, not by the generated code, which configures `Cogitator` in `src/` itself, so keep the provider, model and memory in both places in sync. It holds `llm.defaultProvider` and `llm.defaultModel`, the `memory` adapter (`redis` for `memory`, `memory` for `api-server` and `nextjs`) and for the servers a `deploy` section: `health.path: /api/health`, so `cogitator deploy` produces a container that reports healthy, and for `api-server` `secrets` (the provider key and `API_TOKEN`), so deploy checks they are set.

### Docker Compose

`docker-compose.yml` runs Redis and Postgres, plus Ollama when it is the provider. A one-shot `ollama-pull` service pulls the project's model into the Ollama volume once the server is healthy, so the first run does not fail on a missing model.

## Programmatic API

```ts
import { scaffold, parseArgs, collectOptions } from 'create-cogitator-app';
import type { ProjectOptions } from 'create-cogitator-app';

const options: ProjectOptions = {
  name: 'my-agent',
  path: '/path/to/my-agent',
  template: 'basic',
  provider: 'ollama',
  model: 'qwen3.5:9b', // optional, default: defaultModels[provider]
  packageManager: 'pnpm',
  docker: false,
  git: true,
  install: false, // optional, default true
};

const result = await scaffold(options);
// { files: ['package.json', 'src/index.ts', ...], install: { status: 'skipped' }, git: { status: 'done' } }
if (result.install.status === 'failed') console.error(result.install.error);

// or: parse CLI arguments and prompt for the rest
const fromCli = await collectOptions(parseArgs(process.argv.slice(2)));
await scaffold(fromCli);
```

`scaffold()` writes the files, installs dependencies with `packageManager` unless `install` is `false`, and initializes git when `git` is `true`. It throws when `name` is not a valid package name (`validateProjectName(name)` returns the reason, or `undefined`) or when `path` exists and is not empty. A failed install or git step does not throw: the returned `ScaffoldResult` lists the generated `files` and reports each step as `{ status: 'done' }`, `{ status: 'skipped' }` or `{ status: 'failed', error }`, and the project stays on disk.

Other exports: `getTemplate(name)` and `templateChoices` (template generators and their labels), `detectPackageManager()`, `devCommand(pm)`, `validateProjectName(name)`, `defaultModels`, `providerConfig(provider, access?)` (the generated `llm` block, reading the key through `requireEnv` or `process.env`) and `providerEnvKey(provider)`, and the types `ProjectOptions`, `ScaffoldResult`, `ScaffoldStep`, `Template`, `LLMProvider`, `PackageManager` and `TemplateFile`.

## License

MIT
