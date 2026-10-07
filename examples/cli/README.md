# CLI Examples

These examples show common `cogitator` CLI workflows.

## Prerequisites

```bash
pnpm add -g @cogitator-ai/cli
# or: npx @cogitator-ai/cli <command>
```

## Personal assistant from YAML (no code)

```bash
mkdir jarvis && cd jarvis
cogitator wizard          # writes cogitator.yml + .env
cogitator up              # run in the foreground
cogitator wizard --edit   # change settings later
```

## Scaffold a code-first project

```bash
cogitator init my-agent   # provider, model, channels, memory adapter
cd my-agent
pnpm dev                  # hot reload (src/index.ts starts src/gateway.ts)
cogitator assistant       # or run src/gateway.ts with the live dashboard
pnpm dev:studio           # chat with the agents in Cogitator Studio
```

## Run in the background

```bash
cogitator build                 # optional: bundle src/gateway.ts → dist/cogitator.mjs (needs esbuild)
cogitator daemon start          # auto-detects dist/cogitator.mjs, cogitator.yml or src/gateway.ts
cogitator daemon status
cogitator daemon logs -f
cogitator daemon stop

cogitator daemon install        # launchd (macOS) / systemd --user (Linux)
cogitator daemon uninstall
```

## Run a quick message

```bash
# uses COGITATOR_MODEL, llm.defaultModel from cogitator.yml, or an installed Ollama model
cogitator run "What is the capital of France?"

cogitator run -m ollama/qwen3:8b "Write a haiku about TypeScript"
OPENAI_API_KEY=sk-... cogitator run -m openai/gpt-6.1-sol "Explain monads"
cogitator run --no-stream "Hello"
```

## Interactive REPL

```bash
cogitator run         # starts interactive mode when no message given
cogitator run -i      # force interactive mode

# inside the REPL:
# > /model gemma3:4b    — switch model
# > /clear              — new conversation
# > exit                — quit (or Ctrl+D)
```

## Skills

```bash
cogitator skill create weather-api --template api
WEATHER_API_API_KEY=... cogitator skill validate skills/weather-api
cogitator skill list
cogitator skill remove weather-api
```

## Docker Compose services

```bash
cogitator up           # in a directory with docker-compose.yml (and no cogitator.yml)
cogitator status       # compose services + Ollama
cogitator logs -f      # follow all service logs
cogitator logs ollama  # logs for a specific service
cogitator down         # stop services (keeps data)
cogitator down -v      # stop and delete all data
```

## Model management

```bash
cogitator models                        # list installed Ollama models
cogitator models --pull qwen2.5:0.5b    # pull a model
cogitator models --url http://gpu-box:11434
```

## Deploy

```bash
cogitator deploy --dry-run             # preview deploy plan
cogitator deploy                       # build + start with Docker Compose
cogitator deploy --target fly          # deploy to Fly.io
cogitator deploy status                # check deployment
cogitator deploy destroy               # tear down
```
