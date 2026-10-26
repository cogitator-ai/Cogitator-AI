# Core Examples

Core runtime features — agents, tools, streaming, caching, reasoning, reflection, learning, and more.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

`17-provider-surface.ts` to `23-skills-and-todos.ts` need no API key: they run on a local Ollama (`OLLAMA_URL`, model `OLLAMA_MODEL`, default `qwen2.5:0.5b`). `18-tool-contract.ts` runs its sandboxed command in Docker when Docker is up, on the host otherwise.

## Examples

| #   | File                      | Description                                                                                     |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| 01  | `01-basic-agent.ts`       | Custom tools with Zod schemas, streaming, usage tracking                                        |
| 02  | `02-built-in-tools.ts`    | Built-in tools: calculator, datetime, filesystem, regex                                         |
| 03  | `03-tool-caching.ts`      | Cache tool results with TTL, semantic matching, cache invalidation                              |
| 04  | `04-context-manager.ts`   | Long conversation handling, truncation, sliding windows                                         |
| 05  | `05-tree-of-thought.ts`   | Tree-of-Thought reasoning for complex problem solving                                           |
| 06  | `06-reflection.ts`        | Self-analyzing agents that learn from past runs                                                 |
| 07  | `07-agent-optimizer.ts`   | Auto-optimize agent instructions and few-shot demos                                             |
| 08  | `08-time-travel.ts`       | Checkpoint, replay, fork, and compare agent runs                                                |
| 09  | `09-cost-routing.ts`      | Budget-aware model selection, cost tracking                                                     |
| 10  | `10-constitutional-ai.ts` | Guardrails, content filtering, critique-and-revise                                              |
| 11  | `11-prompt-injection.ts`  | Prompt injection detection and threat analysis                                                  |
| 12  | `12-causal-reasoning.ts`  | Causal graphs, interventions, counterfactual reasoning                                          |
| 13  | `13-model-registry.ts`    | Model registry: pricing, filtering, provider discovery                                          |
| 14  | `14-approvals.ts`         | Pause before a sensitive tool, resume after a person decides                                    |
| 15  | `15-handoffs.ts`          | A triage agent hands the conversation to billing or tech support                                |
| 16  | `16-decisions.ts`         | Decision models: typed answers with probabilities, a routing tool                               |
| 17  | `17-provider-surface.ts`  | `llm.pricing`, OpenAI-compatible server profiles, `error.kind`                                  |
| 18  | `18-tool-contract.ts`     | Tool names, `json` and `resource` parts, result size, cancelling                                |
| 19  | `19-model-fallback.ts`    | `fallbackModels`, circuit breakers, every failed attempt reported                               |
| 20  | `20-tool-deps.ts`         | Typed per-request `deps` for tools, kept out of the prompt                                      |
| 21  | `21-run-middleware.ts`    | Middleware around model and tool calls, tripwire guards                                         |
| 22  | `22-workspace.ts`         | A workspace for files and commands, long tool results saved there                               |
| 23  | `23-skills-and-todos.ts`  | `SKILL.md` skills (sample in `skills/`), `write_todos`, `tool_search`                           |
| 24  | `24-run-control.ts`       | `cog.start()` steering, a tool that asks a person, double-texting                               |
| 25  | `25-tool-execution.ts`    | Parallel safe tools and a barrier, `toolOutput()`, progress, streamed tool input, timeouts      |
| 26  | `26-permissions.ts`       | Claude Code rules from `.claude/settings.json`, plan mode, the audit log, a session budget      |
| 27  | `27-hooks.ts`             | Claude Code hooks from `.claude/settings.json`, `AGENTS.md` in the system prompt                |
| 28  | `28-subagents.ts`         | `.claude/agents` subagents, an approval that bubbles up, a `.claude/commands` command           |
| 29  | `29-harness-agent.ts`     | `createHarnessAgent()`: the `coding` preset fixes a bug with approvals, the `assistant` preset  |
| 30  | `30-durable-runs.ts`      | A durable run killed with `SIGKILL` mid-tool, recovered by another process with `recoverRuns()` |

## Running

```bash
npx tsx examples/core/01-basic-agent.ts
npx tsx examples/core/02-built-in-tools.ts
# ... etc
```
