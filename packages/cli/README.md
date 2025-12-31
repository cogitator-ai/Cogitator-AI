# @cogitator/cli

Command-line interface for the Cogitator AI agent runtime.

## Installation

```bash
pnpm add -g @cogitator/cli
```

## Commands

### Initialize a new project

```bash
cogitator init my-project
cd my-project
```

### Start development services

```bash
cogitator up
```

Starts Redis, PostgreSQL, and Ollama via Docker Compose.

### Stop services

```bash
cogitator down
```

### Run an agent

```bash
cogitator run "Hello, what can you help me with?"
```

With a specific model:

```bash
cogitator run -m ollama/gemma3:4b "Explain quantum computing"
```

Interactive mode:

```bash
cogitator run
```

## Project Structure

After `cogitator init`, your project will have:

```
my-project/
├── package.json
├── cogitator.yml      # Configuration
├── agent.ts           # Your agent definition
└── docker-compose.yml # Local services
```

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
