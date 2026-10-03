# create-cogitator-app

Interactive scaffolder for [Cogitator](https://cogitator.app) — creates a ready-to-run TypeScript AI agent project from one of six templates.

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
```

Prompts are shown only for values not given on the command line: project directory, template, provider, package manager, Docker Compose and git. With `-y` / `--yes` nothing is asked and the defaults fill the gaps: `my-agents`, `basic`, `ollama`, the detected package manager, Docker Compose on, git on. The target directory must be empty or not exist. After writing the files the scaffolder runs `<pm> install` and, unless disabled, creates a git repository with an initial commit.

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
| `--pm <name>`              |           | Package manager (`pnpm`, `npm`, `yarn`, `bun`)            |
| `--docker` / `--no-docker` |           | Include Docker Compose (Redis, Postgres, plus Ollama)     |
| `--git` / `--no-git`       |           | Initialize git repository                                 |
| `--yes`                    | `-y`      | Don't prompt; use the defaults for every missing value    |

Unknown values for `--template`, `--provider` and `--pm` are ignored and asked for interactively (or replaced by the default with `--yes`). The package manager prompt defaults to the one that invoked the scaffolder (`npm_config_user_agent`), falling back to `pnpm`.

## Providers

| Provider    | Default Model       | Requires                                                                           |
| ----------- | ------------------- | ---------------------------------------------------------------------------------- |
| `ollama`    | `qwen3:8b`          | [Ollama](https://ollama.com) (`OLLAMA_BASE_URL`, default `http://localhost:11434`) |
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
├── cogitator.yml        # provider and default model
├── .env.example         # the provider's key (and REDIS_URL for memory)
├── .gitignore
├── README.md
├── pnpm-workspace.yaml  # pnpm only
└── docker-compose.yml   # with --docker
```

Template-specific sources:

| Template     | Files                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `basic`      | `src/index.ts`, `src/tools.ts`                                                                     |
| `memory`     | `src/index.ts`, `src/tools.ts`                                                                     |
| `swarm`      | `src/index.ts`, `src/tools.ts`, `src/agents/{researcher,writer,reviewer}.ts`                       |
| `workflow`   | `src/index.ts`, `src/agents.ts`                                                                    |
| `api-server` | `src/index.ts`, `src/agents.ts`                                                                    |
| `nextjs`     | `src/lib/agent.ts`, `src/app/api/chat/route.ts`, `src/app/{page,layout}.tsx`, Next/Tailwind config |

The generated code configures `Cogitator` in `src/` itself, reading the provider key from the environment. Copy `.env.example` to `.env` and fill it in, then run `pnpm dev` (or `npm run dev`, `yarn dev`, `bun dev`).

## Programmatic API

```ts
import { scaffold, parseArgs, collectOptions } from 'create-cogitator-app';
import type { ProjectOptions } from 'create-cogitator-app';

const options: ProjectOptions = {
  name: 'my-agent',
  path: '/path/to/my-agent',
  template: 'basic',
  provider: 'ollama',
  packageManager: 'pnpm',
  docker: false,
  git: true,
};

await scaffold(options);

// or: parse CLI arguments and prompt for the rest
const fromCli = await collectOptions(parseArgs(process.argv.slice(2)));
await scaffold(fromCli);
```

`scaffold()` writes the files, installs dependencies with `packageManager` and initializes git when `git` is `true`; it throws when `path` exists and is not empty.

Other exports: `getTemplate(name)` and `templateChoices` (template generators and their labels), `detectPackageManager()`, `devCommand(pm)`, `defaultModels`, `providerConfig(provider)` and `providerEnvKey(provider)`, and the types `ProjectOptions`, `Template`, `LLMProvider`, `PackageManager` and `TemplateFile`.

## License

MIT
