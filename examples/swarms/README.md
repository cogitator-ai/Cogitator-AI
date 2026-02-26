# Swarms Examples

Multi-agent coordination with different strategies — debate, pipeline, hierarchical delegation, and negotiation.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

## Examples

| #   | File                       | Description                                                 |
| --- | -------------------------- | ----------------------------------------------------------- |
| 01  | `01-debate-swarm.ts`       | Multi-agent debate with advocates, critics, and a moderator |
| 02  | `02-pipeline-swarm.ts`     | Sequential processing: researcher, writer, editor           |
| 03  | `03-hierarchical-swarm.ts` | Supervisor delegating tasks to specialist workers           |
| 04  | `04-negotiation-swarm.ts`  | Two-party negotiation with offers, convergence, agreements  |

## Running

```bash
npx tsx examples/swarms/01-debate-swarm.ts
npx tsx examples/swarms/02-pipeline-swarm.ts
npx tsx examples/swarms/03-hierarchical-swarm.ts
npx tsx examples/swarms/04-negotiation-swarm.ts
```

Swarm examples involve multiple agent runs and may take 30-60 seconds each depending on the model and API speed.
