# Workflows Examples

DAG-based workflow engine — sequential pipelines, conditional routing, human-in-the-loop approvals, and parallel map-reduce patterns.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

## Examples

| #   | File                   | Description                                              |
| --- | ---------------------- | -------------------------------------------------------- |
| 01  | `01-basic-workflow.ts` | Sequential pipeline with agent, tool, and function nodes |
| 02  | `02-human-in-loop.ts`  | Approval gates, multi-choice decisions, free-form input  |
| 03  | `03-map-reduce.ts`     | Parallel document analysis with map-reduce aggregation   |

## Running

```bash
npx tsx examples/workflows/01-basic-workflow.ts
npx tsx examples/workflows/02-human-in-loop.ts
npx tsx examples/workflows/03-map-reduce.ts
```

Workflow examples involve multiple LLM calls and may take 30-60 seconds each depending on the model and API speed.
