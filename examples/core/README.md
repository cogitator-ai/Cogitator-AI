# Core Examples

Core runtime features — agents, tools, streaming, caching, reasoning, reflection, learning, and more.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

## Examples

| #   | File                      | Description                                                        |
| --- | ------------------------- | ------------------------------------------------------------------ |
| 01  | `01-basic-agent.ts`       | Custom tools with Zod schemas, streaming, usage tracking           |
| 02  | `02-built-in-tools.ts`    | Built-in tools: calculator, datetime, filesystem, regex            |
| 03  | `03-tool-caching.ts`      | Cache tool results with TTL, semantic matching, cache invalidation |
| 04  | `04-context-manager.ts`   | Long conversation handling, truncation, sliding windows            |
| 05  | `05-tree-of-thought.ts`   | Tree-of-Thought reasoning for complex problem solving              |
| 06  | `06-reflection.ts`        | Self-analyzing agents that learn from past runs                    |
| 07  | `07-agent-optimizer.ts`   | Auto-optimize agent instructions and few-shot demos                |
| 08  | `08-time-travel.ts`       | Checkpoint, replay, fork, and compare agent runs                   |
| 09  | `09-cost-routing.ts`      | Budget-aware model selection, cost tracking                        |
| 10  | `10-constitutional-ai.ts` | Guardrails, content filtering, critique-and-revise                 |
| 11  | `11-prompt-injection.ts`  | Prompt injection detection and threat analysis                     |
| 12  | `12-causal-reasoning.ts`  | Causal graphs, interventions, counterfactual reasoning             |
| 13  | `13-model-registry.ts`    | Model registry: pricing, filtering, provider discovery             |

## Running

```bash
npx tsx examples/core/01-basic-agent.ts
npx tsx examples/core/02-built-in-tools.ts
# ... etc
```
