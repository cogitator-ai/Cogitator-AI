# CLI Examples

These examples show common `cogitator` CLI workflows.

## Prerequisites

```bash
pnpm add -g @cogitator-ai/cli
# or: npx @cogitator-ai/cli <command>
```

## Scaffold and run a new project

```bash
cogitator init my-agent
cd my-agent
cogitator up          # start Redis, PostgreSQL, Ollama
pnpm dev              # run the generated agent
```

## Run a quick message

```bash
# auto-detects an Ollama model
cogitator run "What is the capital of France?"

# specify a model
cogitator run -m ollama/gemma3:4b "Write a haiku about TypeScript"

# use OpenAI
OPENAI_API_KEY=sk-... cogitator run -m openai/gpt-4o "Explain monads"

# disable streaming
cogitator run --no-stream "Hello"
```

## Interactive REPL

```bash
cogitator run         # starts interactive mode when no message given
cogitator run -i      # force interactive mode

# inside the REPL:
# > /model gemma3:4b    — switch model
# > /clear              — new conversation
# > exit                — quit
```

## Service management

```bash
cogitator up           # start services in background
cogitator status       # check what's running
cogitator logs -f      # follow all service logs
cogitator logs ollama  # logs for a specific service
cogitator down         # stop services (keeps data)
cogitator down -v      # stop and delete all data
```

## Model management

```bash
cogitator models                       # list installed Ollama models
cogitator models --pull llama3.1:8b   # pull a model
cogitator models --pull gemma3:4b
```

## Deploy

```bash
cogitator deploy --dry-run             # preview deploy plan
cogitator deploy --target fly          # deploy to Fly.io
cogitator deploy status                # check deployment
cogitator deploy destroy               # tear down
```
