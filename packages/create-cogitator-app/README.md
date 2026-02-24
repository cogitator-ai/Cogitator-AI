# create-cogitator-app

Interactive CLI scaffolder for [Cogitator](https://cogitator.dev) — creates production-ready AI agent projects in seconds.

## Usage

```bash
# Interactive mode
npx create-cogitator-app

# With arguments
npx create-cogitator-app my-project --template basic --provider openai

# Skip prompts with flags
npx create-cogitator-app my-project -t swarm -p ollama --pm pnpm --docker --no-git
```

## Templates

| Template     | Description                               |
| ------------ | ----------------------------------------- |
| `basic`      | Single agent with tools                   |
| `memory`     | Agent with Redis-backed persistent memory |
| `swarm`      | Multi-agent hierarchical swarm            |
| `workflow`   | DAG workflow with sequential agent nodes  |
| `api-server` | Express REST API with Cogitator backend   |
| `nextjs`     | Next.js chat app with streaming UI        |

## CLI Flags

| Flag                       | Shorthand | Description                                              |
| -------------------------- | --------- | -------------------------------------------------------- |
| `--template <name>`        | `-t`      | Template to use                                          |
| `--provider <name>`        | `-p`      | LLM provider (`ollama`, `openai`, `anthropic`, `google`) |
| `--pm <name>`              |           | Package manager (`pnpm`, `npm`, `yarn`, `bun`)           |
| `--docker` / `--no-docker` |           | Include Docker Compose                                   |
| `--git` / `--no-git`       |           | Initialize git repository                                |

## Providers

| Provider    | Default Model              | Requires                                       |
| ----------- | -------------------------- | ---------------------------------------------- |
| `ollama`    | `qwen2.5:7b`               | [Ollama](https://ollama.com) installed locally |
| `openai`    | `gpt-4o`                   | `OPENAI_API_KEY`                               |
| `anthropic` | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY`                            |
| `google`    | `gemini-2.5-flash`         | `GOOGLE_API_KEY`                               |

## Programmatic API

```ts
import { scaffold, parseArgs } from 'create-cogitator-app';
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
```

## Generated Project Structure

```
my-project/
├── src/
│   ├── index.ts      # Main entry point
│   └── tools.ts      # Tool definitions
├── package.json
├── tsconfig.json
├── cogitator.yml     # Cogitator configuration
├── .env.example
├── .gitignore
└── README.md
```

## License

MIT
