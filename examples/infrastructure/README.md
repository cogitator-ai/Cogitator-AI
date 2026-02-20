# Infrastructure Examples

Redis-backed memory, PostgreSQL persistence, distributed job queues, and deployment automation.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

### Infrastructure services

```bash
docker-compose up -d
```

Or run individual services:

```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine
docker run -d --name postgres -p 5432:5432 -e POSTGRES_PASSWORD=cogitator postgres:16-alpine
```

### Environment variables

```env
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://postgres:cogitator@localhost:5432/cogitator
```

## Examples

| #   | File                    | Requires   | Description                                                  |
| --- | ----------------------- | ---------- | ------------------------------------------------------------ |
| 01  | `01-redis-memory.ts`    | Redis      | Redis memory adapter, thread persistence, multi-turn chatbot |
| 02  | `02-postgres-memory.ts` | PostgreSQL | PostgreSQL memory with facts, long-term persistence          |
| 03  | `03-worker-queue.ts`    | Redis      | BullMQ job queue, worker pool, Prometheus metrics            |
| 04  | `04-deploy-docker.ts`   | Docker     | Project analysis, deployment planning, dry-run deploy        |

## Running

```bash
npx tsx examples/infrastructure/01-redis-memory.ts
npx tsx examples/infrastructure/02-postgres-memory.ts
npx tsx examples/infrastructure/03-worker-queue.ts
npx tsx examples/infrastructure/04-deploy-docker.ts
```
