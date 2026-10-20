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
| Third   | `z-ai/glm-5.3-flash`       |

The model matrix stage also runs `xiaomi/mimo-v2.6-flash` and `qwen/qwen3.8-flash`. The decisions stage asks TypeSafe's Jev (`typesafe/jev-1.13`), a decision model, through `cog.decide()` on OpenRouter's Decisions API and as a tool of an agent. Override the three with `GAUNTLET_MODELS=vendor/model,vendor/model,...` (primary first). The cost shown is what OpenRouter reports for every call. OpenRouter spreads a model across providers whose prices differ several times over, so the catalogue price is only the fallback for a call that reports none.

## Local model lane

The `scaffold-ollama` stage runs generated projects on a small model of your own Ollama instead of OpenRouter: the `basic` and `assistant` presets of create-cogitator-app answer from their entry point, and Cogitator Studio runs the assistant with a trace of its model calls. It needs Ollama with the model pulled and costs nothing:

```bash
ollama pull qwen2.5:0.5b                  # or set GAUNTLET_OLLAMA_MODEL to another model
pnpm gauntlet --only scaffold-ollama
```

Without Ollama or the model the stage is skipped with the reason. `OLLAMA_BASE_URL` points it at another server.

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

## Memory benchmarks

`pnpm memory-bench` measures the runtime's memory on long-memory datasets. Each conversation goes into a thread once, then every question runs as a real `cog.run` on that thread (not saved), on `claude-haiku-5-5` with a fixed context budget, and its answer is scored the dataset's own way.

```bash
pnpm memory-bench --estimate                                   # questions, tokens and cost, no calls
pnpm memory-bench --datasets longmemeval-s --sample longmemeval-s=100 --strategies recent,hybrid
pnpm memory-bench --consistency-only                           # fork and rewind checks, free
```

| Dataset                             | Source and license                                       | Scored by                                            |
| ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `longmemeval-s`                     | `xiaowu0162/longmemeval-cleaned`, MIT                    | the LongMemEval yes/no judge prompts                 |
| `beam-100k`, `beam-500k`, `beam-1m` | `Mohammadta/BEAM`, CC BY-SA 4.0                          | the BEAM rubric judge, one call per rubric item      |
| `mab-conflict`                      | `ai-hyz/MemoryAgentBench` Conflict_Resolution, MIT       | normalized substring match                           |
| `lme-v2-small`                      | `xiaowu0162/longmemeval-v2`, Apache-2.0 (text questions) | the LongMemEval-V2 evaluators, LLM checkers included |
| `locomo`                            | `snap-research/locomo`, CC BY-NC 4.0, smoke only         | token F1                                             |

Read the numbers as a comparison of the runtime's own strategies, not as leaderboard figures: the judge is `claude-haiku-5-5`, not the model each benchmark's paper used, and it judges answers of the same model. The adaptations to the runtime are part of the method: every turn carries its session's date, the dataset's answering rules and "today" go to the agent's instructions so retrieval searches the question alone, MemoryAgentBench facts go in as messages of about 4096 tokens, LongMemEval-V2 trajectories go in as notes of earlier sessions with accessibility trees cut to 4000 characters, its questions with screenshots are left out, and BEAM event ordering is scored by its rubric judge without the Kendall tau alignment. `relevant` and `hybrid` score only the newest 200 turns of a thread (the context builder's `MAX_SCORED_ENTRIES`), so older evidence is out of their reach, which the baseline shows on purpose. Prompts and evaluators taken from the benchmarks are listed with their licenses in `src/memory-bench/THIRD_PARTY_NOTICES.md`.

The datasets are downloaded into `~/.cache/cogitator/memory-bench` (`MEMORY_BENCH_CACHE`) on first use and never committed. Every answer records its tokens, cache hits, latency, the time spent building the context and the share of the dataset's marked evidence that reached the model, through a run middleware that sees each model call. The history's embeddings are computed before the questions, so every strategy's context build time is measured on a warm cache. An answer whose retrieval failed (the strategy fell back to the newest turns) counts as failed, and a failed answer is asked again when the run resumes. Accuracy intervals resample whole conversations, and every strategy is also compared with `recent` on the same questions. Samples are stratified by category and seeded (`--sample`, `--seed`). Embeddings for `relevant` and `hybrid` go through a SQLite cache, so a rerun pays only for texts it has not embedded. The judge goes out as Message Batches (`--no-batch` for one by one). Spending is capped per run (`--anthropic-budget` for answers and the judge, `--budget` for embeddings) and kept in ledgers in the cache. A run resumes from its results when started again with the same `--run` (with the same context budget, model and seed), the judge's replies and open batches included, so nothing paid for is asked again. Reports land in `reports/memory/<run>.json` and `.md`.

It needs `ANTHROPIC_API_KEY` (and `ANTHROPIC_WORKSPACE_ID` for a key that is not scoped to a workspace), and `GOOGLE_API_KEY` for the embeddings of `relevant` and `hybrid`, from the environment or the repository's `.env`.

## Environment

| Variable                | Default                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `OPENROUTER_API_KEY`    | required, also read from `packages/gauntlet/.env`               |
| `GAUNTLET_MODELS`       | `deepseek/deepseek-v4-pro,openai/gpt-6-luna,z-ai/glm-5.3-flash` |
| `GAUNTLET_POSTGRES_URL` | `postgresql://gauntlet:gauntlet@127.0.0.1:55432/gauntlet`       |
| `GAUNTLET_REDIS_URL`    | `redis://127.0.0.1:56379`                                       |
| `GAUNTLET_QDRANT_URL`   | `http://127.0.0.1:56333`                                        |
| `GAUNTLET_MONGODB_URL`  | `mongodb://127.0.0.1:57017`                                     |
