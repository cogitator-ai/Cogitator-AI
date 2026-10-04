# Cogitator Gauntlet

An integration proving ground: one application that runs every published Cogitator package together, the way users wire them, against real models, and shows the result live.

Unit and end-to-end tests check each package on its own. The gauntlet checks that they work in practice and together: a memory store a real agent writes to, a workflow a person has to approve, four HTTP servers answering the same requests, a swarm of models from different vendors arguing about a topic. When something only breaks in combination, or only against a real provider, this is where it shows up.

## Run it

```bash
# 1. Services the stages talk to (Postgres with pgvector, Redis, Qdrant, MongoDB)
docker compose -f packages/gauntlet/compose.yml up -d

# 2. An OpenRouter key (https://openrouter.ai/keys)
echo "OPENROUTER_API_KEY=sk-or-..." > packages/gauntlet/.env

# 3. Build the packages, then run the gauntlet
pnpm build
pnpm gauntlet
```

The dashboard opens at <http://localhost:4400>: every stage as a cogitator screen with its status lamp, the checks it made and the evidence behind them, logs, tokens and cost, and a map of which package each stage exercised. The terminal shows the same run as it happens, and `packages/gauntlet/reports/latest.json` keeps the full report.

A full run costs around a cent.

```bash
pnpm gauntlet --list                       # stages and the packages they cover
pnpm gauntlet --only rag,workflow-newsroom # some stages (their dependencies run too)
pnpm gauntlet --no-dashboard --json out.json
pnpm gauntlet --help
```

## Models

Stages run on OpenRouter, registered as a custom backend (`openrouter/<vendor>/<model>`), so the gauntlet also proves that path. Three models from different vendors take part in every run, so multi-agent stages argue across models instead of with one model in three hats:

| Role    | Default model              |
| ------- | -------------------------- |
| Primary | `deepseek/deepseek-v4-pro` |
| Second  | `openai/gpt-6-luna`        |
| Third   | `qwen/qwen3.8-flash`       |

The model matrix stage also runs `xiaomi/mimo-v2.6-flash` and `z-ai/glm-5.3-flash`. Override the three with `GAUNTLET_MODELS=vendor/model,vendor/model,...` (primary first). Prices come from the OpenRouter catalogue, so the cost shown is real.

## What a stage is

A stage proves one thing a user would do, through public package APIs only. It lists the packages it exercises, the stages it needs, and what the machine must have (a service, Docker, Bun, Deno, Playwright, an API key). A missing requirement makes the stage an honest skip with the reason, never a failure.

Each stage records named checks with evidence: the ids, counts, statuses and excerpts it observed. Checks assert mechanics (a tool was called, rows were written and read back, a server answered with the right protocol), and only loosely the wording of model output.

The last stage, **coverage**, fails when a published package is exercised by no stage. A new package cannot be released without being wired into the gauntlet.

## Adding a stage

1. Pick the area file in `src/stages/` (or add one and register it in `src/stages/index.ts`).
2. Export a `StageDefinition` (see `src/runner/types.ts` and `src/stages/core.ts` for a small example).
3. List every package it exercises in `packages`, its requirements in `requires`, and free every resource with `ctx.onCleanup`.
4. Run it alone with `pnpm gauntlet --only <id>`.

When a stage exposes a bug in a package, keep the check that exposes it and fix the package, the stage is the acceptance test.

## Environment

| Variable                | Default                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `OPENROUTER_API_KEY`    | required, also read from `packages/gauntlet/.env`               |
| `GAUNTLET_MODELS`       | `deepseek/deepseek-v4-pro,openai/gpt-6-luna,qwen/qwen3.8-flash` |
| `GAUNTLET_POSTGRES_URL` | `postgresql://gauntlet:gauntlet@127.0.0.1:55432/gauntlet`       |
| `GAUNTLET_REDIS_URL`    | `redis://127.0.0.1:56379`                                       |
| `GAUNTLET_QDRANT_URL`   | `http://127.0.0.1:56333`                                        |
| `GAUNTLET_MONGODB_URL`  | `mongodb://127.0.0.1:57017`                                     |
