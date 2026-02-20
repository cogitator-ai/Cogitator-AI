# Core Examples

Core runtime features — agents, tools, streaming, caching, reasoning, reflection, learning, and more.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

## Examples

| #   | File                       | Description                                                        |
| --- | -------------------------- | ------------------------------------------------------------------ |
| 01  | `01-basic-agent.ts`        | Custom tools with Zod schemas, streaming, usage tracking           |
| 02  | `02-built-in-tools.ts`     | Built-in tools: calculator, datetime, filesystem, regex            |
| 03  | `03-structured-output.ts`  | JSON output with Zod validation, typed responses                   |
| 04  | `04-tool-caching.ts`       | Cache tool results with TTL, semantic matching, cache invalidation |
| 05  | `05-tree-of-thought.ts`    | Tree-of-Thought reasoning for complex problem solving              |
| 06  | `06-reflection.ts`         | Self-analyzing agents that learn from past runs                    |
| 07  | `07-agent-optimization.ts` | Auto-optimize agent instructions and few-shot demos                |
| 08  | `08-constitutional-ai.ts`  | Guardrails, content filtering, critique-and-revise                 |
| 09  | `09-cost-routing.ts`       | Budget-aware model selection, cost tracking                        |
| 10  | `10-security.ts`           | Prompt injection detection, input/output sanitization              |
| 11  | `11-context-management.ts` | Long conversation handling, sliding window, summarization          |
| 12  | `12-multi-provider.ts`     | Using multiple LLM providers with fallback chains                  |

## Running

```bash
npx tsx examples/core/01-basic-agent.ts
npx tsx examples/core/02-built-in-tools.ts
# ... etc
```
