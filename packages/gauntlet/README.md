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

Without Ollama or the model the stage is skipped with the reason. `OLLAMA_BASE_URL` points it at another server. A small model may call a tool that needs approval out of the blue: the stage refuses such calls through the Studio API, so the run goes on, and lists them in the evidence of its check.

## Session protocols

Two stages drive the session protocols the way an editor or a desktop app does, each agent in a child process on stdio:

- **app-server** spawns `fixtures/protocols/app-server.ts`, a `SessionHost` served by `serveStdio`, and drives it with the generated client: a request before `initialize` is refused, a turn answers before its `turn/started`, a tool that needs approval pauses the turn and `resume.decisions` finishes it, `_cogitator/trace/get` returns its model spans, `turn/interrupt` stops a long tool call, and a second process on the same SQLite file resumes the thread.
- **acp** launches `fixtures/protocols/acp-agent.ts`, an agent of `createAcpAgent` served by `serveAcpStdio`, through `AcpAgentProvider` as an external agent of another host, and drives that host through the app-server: the agent's stream arrives as turn events, the permission rules allow one command and refuse another, its reads and commands go through the provider's workspace and never leave its root, and after both sides restart its session loads with what it read before.

## What a stage is

A stage proves one thing a user would do, through public package APIs only. It lists the packages it exercises, the stages it needs, and what the machine must have (a service, Docker, BuildKit for an image build, Bun, Deno, Playwright, an API key). A missing requirement makes the stage an honest skip with the reason, never a failure.

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
pnpm memory-bench --consistency-only                           # fork and rewind, compaction loss, free
pnpm memory-bench --datasets beam-100k --turns 3               # two follow-ups per question, for the prompt cache
pnpm memory-bench --datasets longmemeval-s --strategies recent,compacted --estimate
pnpm memory-bench --datasets longmemeval-s --sample longmemeval-s=40 --strategies recent,extracted
```

| Dataset                             | Source and license                                       | Scored by                                            |
| ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `longmemeval-s`                     | `xiaowu0162/longmemeval-cleaned`, MIT                    | the LongMemEval yes/no judge prompts                 |
| `beam-100k`, `beam-500k`, `beam-1m` | `Mohammadta/BEAM`, CC BY-SA 4.0                          | the BEAM rubric judge, one call per rubric item      |
| `mab-conflict`                      | `ai-hyz/MemoryAgentBench` Conflict_Resolution, MIT       | normalized substring match                           |
| `lme-v2-small`                      | `xiaowu0162/longmemeval-v2`, Apache-2.0 (text questions) | the LongMemEval-V2 evaluators, LLM checkers included |
| `locomo`                            | `snap-research/locomo`, CC BY-NC 4.0, smoke only         | token F1                                             |

Read the numbers as a comparison of the runtime's own strategies, not as leaderboard figures: the judge is `claude-haiku-5-5`, not the model each benchmark's paper used, and it judges answers of the same model. The adaptations to the runtime are part of the method: every turn carries its session's date, the dataset's answering rules and "today" go to the agent's instructions so retrieval searches the question alone, MemoryAgentBench facts go in as messages of about 2048 tokens (the input limit of the embedding model), LongMemEval-V2 trajectories go in as notes of earlier sessions with accessibility trees cut to 4000 characters, its questions with screenshots are left out, and BEAM event ordering is scored by its rubric judge without the Kendall tau alignment. `relevant` and `hybrid` score only the newest 200 turns of a thread (the context builder's `MAX_SCORED_ENTRIES`), so older evidence is out of their reach, which the baseline shows on purpose. Prompts and evaluators taken from the benchmarks are listed with their licenses in `src/memory-bench/THIRD_PARTY_NOTICES.md`.

The datasets are downloaded at pinned revisions into `~/.cache/cogitator/memory-bench` (`MEMORY_BENCH_CACHE`) on first use and never committed. Every answer records its tokens, cache hits, latency, the time spent building the context and the share of the dataset's marked evidence that reached the model, through a run middleware that sees each model call. The history the strategy scores and every question are embedded before the questions run, so each strategy's context build time is measured on a warm cache, without the embedding provider's latency. An answer whose retrieval failed (the strategy fell back to the newest turns) counts as failed, and a failed answer is asked again when the run resumes. Accuracy intervals resample whole conversations, and every strategy is also compared with `recent` on the same questions. Samples are stratified by category and seeded (`--sample`, `--seed`). Embeddings for `relevant` and `hybrid` go through a SQLite cache, so a rerun pays only for texts it has not embedded. The judge goes out as Message Batches (`--no-batch` for one by one). Spending is capped per run (`--anthropic-budget` for answers and the judge, `--budget` for embeddings) and kept in ledgers in the cache. A run resumes from its results when started again with the same `--run` (with the same method version, context budget, model and seed), the judge's replies and open batches included, so nothing paid for is asked again. Reports land in `reports/memory/<run>.json` and `.md`, with the count of answers not judged yet when a run stopped early.

Besides cache hits, every answer records the tokens written to the prompt cache, and the report has a `Cache write/query` column and an `Input cost vs uncached` column: what the input cost with cache reads and writes priced as the bench model prices them, as a multiple of the same input at the plain input price (below `1.00x` the cache saved money, above it the writes cost more than the reads saved). `--turns <n>` (default 1) measures how the cache carries over from one turn to the next: each question opens a chain on a branch of its conversation's thread that leaves the thread's active leaf alone, saved turn after turn, whose follow-ups are the next questions of the same conversation, then, once those run out or for a conversation with one question (LongMemEval-S), a neutral request to restate the answer. Follow-ups are not judged. They get their own `Follow-up turns` table with input tokens, cache hits, cache writes and the input cost ratio of the first turns beside those of the later ones. A resumed run asks a chain with a turn missing again whole, and `--estimate` prices follow-ups like first turns.

`--strategies compacted` (opt-in, not in the default set) measures the runtime's own compaction (`memory.compaction`, hierarchical): after a conversation goes in, a closing turn ("That is all for now, thank you.") is saved on its thread, and the runtime compacts the thread after that run once its conversation passed the context budget, keeping the newest quarter of the budget verbatim, in chapters of 4000 tokens written by the bench model. The questions then run on `recent` over the summary and the kept tail. The closing turn and the chapter calls (made by the runtime outside any run) are metered at the backend and charged to the Anthropic budget as the `compaction` stage, and `--estimate` prices them roughly: the closing turn plus one chapter call per 4000 tokens of conversation. A compaction the runtime started and did not finish fails the conversation's questions, since answers on the whole thread would not measure compaction, and a conversation under the budget is answered as it is.

`--strategies extracted` (opt-in too) measures extraction (`MemoryExtractor`, phase 10e): once a conversation goes in, its memory items are extracted window by window (4000 tokens, the bench model, dates resolved from each window's own date), scoped to its thread so no other conversation sees them, and the questions run on `recent` with the items that hold as the facts of the context (`includeFacts`). The extraction calls are charged as the `extraction` stage, and `--estimate` prices one call per 4000 tokens of conversation. An extraction that fails fails the conversation's questions.

Every run starts with two free suites on stubs, also run alone with `--consistency-only`. The fork and rewind suite: for each strategy, under a context budget the history does not fit, a branch must see its own turns and the shared history but never another branch's turns, and a deleted turn must reach the model before the deletion and never after. A memory error fails the suite, since a fallback would test something else. The compaction loss suite: a scripted session with planted control items (open tasks, a decision, constraints, a failing tool call, files written through tool calls, an open question) is compacted after each of its three rounds by `CompactionService` (`hierarchical`, small chapters, two chapters to an arc and two arcs to the saga), once with a tail of entries and once with a tail of tokens. Its chapter model is a deterministic stub that names an item only the first time it reads it, misquotes some, claims a task done that no message supports and answers junk every fourth call. The final summary must still list every open control item in its handoff and as an open atom of its levels, show the task closed with evidence that holds as done, keep the task claimed done without evidence open, mark the atoms whose quotes do not hold `(unverified)` and no others, and be followed by the end of the session verbatim. Both suites land in the report (`consistency`, `compactionLoss`).

It needs `ANTHROPIC_API_KEY` (and `ANTHROPIC_WORKSPACE_ID` for a key that is not scoped to a workspace), and a key for the embeddings of `relevant`, `hybrid` and `extracted`, from the environment, `packages/gauntlet/.env` or the repository's `.env`. Embeddings are always `gemini-embedding-001`, served by Google (`GOOGLE_API_KEY`) or by OpenRouter (`OPENROUTER_API_KEY`), which return the same vectors, so both share one cache and a run can switch midway. `--embeddings google|openrouter` picks one, and by default Google is used when its key is set. A conversation whose history cannot be indexed fails its questions instead of answering from part of it, and a resumed run asks them again.

## Environment

| Variable                | Default                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `OPENROUTER_API_KEY`    | required, also read from `packages/gauntlet/.env`               |
| `GAUNTLET_MODELS`       | `deepseek/deepseek-v4-pro,openai/gpt-6-luna,z-ai/glm-5.3-flash` |
| `GAUNTLET_POSTGRES_URL` | `postgresql://gauntlet:gauntlet@127.0.0.1:55432/gauntlet`       |
| `GAUNTLET_REDIS_URL`    | `redis://127.0.0.1:56379`                                       |
| `GAUNTLET_QDRANT_URL`   | `http://127.0.0.1:56333`                                        |
| `GAUNTLET_MONGODB_URL`  | `mongodb://127.0.0.1:57017`                                     |
