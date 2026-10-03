# Docker Setup Guide

This guide explains how to run Cogitator's backing services with Docker for local development. For a production image of your own project, see [DEPLOY.md](./DEPLOY.md) and [Docker Deployment](https://cogitator.app/docs/deployment/docker).

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (20.10+)
- [Docker Compose](https://docs.docker.com/compose/install/) — `scripts/setup.sh` and the `Makefile` use the `docker compose` plugin and fall back to the standalone `docker-compose` binary (override with `make COMPOSE=...`)
- [Node.js](https://nodejs.org/) (22.12+)
- [pnpm](https://pnpm.io/) (11+)

## Quick Start

### Option 1: Using Make (Recommended)

```bash
# Full setup - starts services, pulls models, installs deps, builds packages
make setup

# Start the docs site (landing + docs)
make dev
```

### Option 2: Manual Setup

```bash
# Start Docker services
docker compose up -d

# ollama-init pulls the models in the background; follow it with:
docker compose logs -f ollama-init

# Or pull them yourself
docker compose exec ollama ollama pull nomic-embed-text-v2-moe
docker compose exec ollama ollama pull llama3.2:3b

# Install dependencies and build
pnpm install
pnpm build

# Start the docs site (landing + docs)
cd packages/dashboard && pnpm dev
```

The CLI does the same from any directory below the compose file: `cogitator up` runs `docker compose up -d` when the current directory has no assistant `cogitator.yml` (a runtime config for `@cogitator-ai/config`, such as the one create-cogitator-app generates, does not count), and `cogitator down` stops the services (`-v` also deletes the volumes). See [cogitator up / down](https://cogitator.app/docs/cli#cogitator-up--down).

### Option 3: CPU Only (No GPU)

If you don't have an NVIDIA GPU:

```bash
docker compose -f docker-compose.cpu.yml up -d
```

> The CPU variant pulls `nomic-embed-text` instead of `nomic-embed-text-v2-moe` as the embedding model. Both produce 768-dimension vectors.

## Services

After starting Docker, these services will be available:

| Service     | Image                    | Port  | Description                                                         |
| ----------- | ------------------------ | ----- | ------------------------------------------------------------------- |
| PostgreSQL  | `pgvector/pgvector:pg16` | 5432  | Database with pgvector (user `cogitator`, password `cogitator_dev`) |
| Redis       | `redis:7-alpine`         | 6379  | Cache, memory, job queues (AOF persistence on)                      |
| Ollama      | `ollama/ollama:latest`   | 11434 | Local LLM runtime                                                   |
| ollama-init | `ollama/ollama:latest`   | —     | One-shot container that pulls the default models                    |

Data lives in the named volumes `cogitator_postgres_data`, `cogitator_redis_data` and `cogitator_ollama_data`.

## Pre-installed Models

The setup includes:

| Model                     | Purpose               | Size |
| ------------------------- | --------------------- | ---- |
| `nomic-embed-text-v2-moe` | Embeddings for memory | ~1GB |
| `llama3.2:3b`             | Default chat model    | ~2GB |

## Commands Reference

```bash
# Service Management
make up              # Start postgres, redis and ollama (not ollama-init)
make down            # Stop services
make ps              # Show running services
make logs            # View all logs
make logs-ollama     # View Ollama logs
make logs-pg         # View PostgreSQL logs

# Models
make pull-models     # Pull default models
make models          # List available models

# Database
make db-shell        # Open PostgreSQL shell
make db-reset        # Remove ALL volumes (Postgres, Redis and Ollama models), restart Postgres

# Development
make dev             # Start the docs site (also starts services)
make build           # Build all packages

# Cleanup
make clean           # Remove build artifacts
make reset           # Full reset (WARNING: removes containers, volumes and node_modules)
```

## Environment Variables

Copy `docker/env.example` to `.env` in the project root:

```bash
cp docker/env.example .env
```

Key variables:

```env
# Database
DATABASE_URL=postgresql://cogitator:cogitator_dev@localhost:5432/cogitator

# Redis
REDIS_URL=redis://localhost:6379

# Ollama
OLLAMA_URL=http://localhost:11434

# Cloud Providers (optional)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...
```

Who reads them:

- `loadConfig()` from `@cogitator-ai/config` maps `OLLAMA_URL` (or `OLLAMA_HOST`) and the provider API keys onto `llm.providers`; `COGITATOR_*` variables cover the rest (see [Environment Variables](https://cogitator.app/docs/cli#environment-variables)).
- `createConfigFromEnv()` from `@cogitator-ai/redis` reads `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_KEY_PREFIX` and `REDIS_CLUSTER_NODES` (see [Redis](https://cogitator.app/docs/deployment/redis#environment-configuration)).
- `DATABASE_URL` is read by the built-in `sqlQuery` and `vectorSearch` tools; pass it yourself to the memory adapters and workflow stores you create.

The `EMBEDDING_*` and `SANDBOX_*` entries in `env.example` are not read by any package. Configure embeddings and sandboxes in code or in `cogitator.yml` (`memory.embedding`, `sandbox`); `sandbox.allowNativeFallback` and `sandbox.pool.reuseContainers` are code-only, since the config schema strips them.

```typescript
import { PostgresAdapter } from '@cogitator-ai/memory';

const memory = new PostgresAdapter({
  provider: 'postgres',
  connectionString: process.env.DATABASE_URL!,
});
await memory.connect();
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│      Your app: Cogitator runtime + server adapter (optional)     │
│                      http://localhost:3000                       │
└───────────────┬────────────────────────┬────────────────────────┘
                │                        │
    ┌───────────▼──────────┐  ┌─────────▼──────────┐
    │     PostgreSQL       │  │       Redis        │
    │  (pgvector enabled)  │  │ (cache + queues)   │
    │     Port: 5432       │  │    Port: 6379      │
    └──────────────────────┘  └────────────────────┘
                │
    ┌───────────▼──────────┐
    │       Ollama         │
    │   (Local LLMs)       │
    │    Port: 11434       │
    │                      │
    │  Models:             │
    │  • nomic-embed-text  │
    │  • llama3.2:3b       │
    └──────────────────────┘
```

## Memory System

On the first start, `docker/postgres/init.sql` enables the `vector` and `uuid-ossp` extensions. The runtime packages then create the tables they need on first use:

- `PostgresAdapter` creates the schema `cogitator` with `threads`, `entries`, `facts` and `embeddings` — `vector(768)` by default (call `setVectorDimensions()` before `connect()` for other embedding models; a `Cogitator` with `memory.adapter: 'postgres'` sizes it to `memory.embedding`), an IVFFlat cosine index and a full-text `tsvector` column for hybrid search
- the Postgres workflow stores create `cogitator_workflow_runs`, `cogitator_workflow_checkpoints`, `cogitator_workflow_timers` and `cogitator_workflow_approvals_*`

Semantic search goes through the adapter, not SQL:

```typescript
import { unwrap } from '@cogitator-ai/memory';

declare const queryVector: number[];

const results = unwrap(await memory.search({ vector: queryVector, limit: 10, threshold: 0.7 }));
```

A Postgres volume created by an older `init.sql` still holds its legacy `cogitator_*` tables, and its `cogitator_workflow_runs` has a different layout from the one `PostgresRunStore` creates. Recreate the volume (`make db-reset`, which deletes all data) or run `DROP TABLE cogitator_workflow_runs;` before using the run store's default table.

See [Memory Adapters](https://cogitator.app/docs/memory/adapters#postgres) for the full adapter API.

## GPU Support

### NVIDIA GPU

The default `docker-compose.yml` reserves all NVIDIA GPUs for Ollama. Requirements:

- NVIDIA GPU with CUDA support
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

Without them the `ollama` service fails to start; use `docker-compose.cpu.yml` instead.

### Apple Silicon (M1/M2/M3)

On macOS with Apple Silicon, Ollama runs natively outside Docker for best performance:

```bash
# Install Ollama natively
brew install ollama

# Start Ollama
ollama serve

# In another terminal, start other services
docker compose up -d postgres redis

# Pull models
ollama pull nomic-embed-text-v2-moe
ollama pull llama3.2:3b
```

## Troubleshooting

### PostgreSQL connection refused

```bash
# Check if PostgreSQL is running
docker compose ps postgres

# View logs
docker compose logs postgres

# Restart
docker compose restart postgres
```

### Ollama model pull fails

```bash
# Check Ollama logs
docker compose logs ollama

# Try pulling manually
docker compose exec ollama ollama pull llama3.2:3b
```

### Sandboxed tools run on the host

Docker-sandboxed tools need a reachable Docker daemon. Without `sandbox.docker.socketPath` or `host`, `@cogitator-ai/sandbox` looks for it like the `docker` CLI: `DOCKER_HOST`, then the current Docker context, then the Docker Engine, Docker Desktop, OrbStack, Colima, Rancher Desktop and rootless sockets. When none answers, such tools run unsandboxed on the host with a `[sandbox] Docker is unavailable` warning, because `sandbox.allowNativeFallback` defaults to `true`; set it to `false` to fail those calls instead. Check with `docker context ls` and `docker info`, or point `sandbox.docker.socketPath` at your daemon's socket.

### Out of memory

For systems with limited RAM, use a smaller model instead of the default `llama3.2:3b`:

```bash
docker compose exec ollama ollama pull llama3.2:1b   # ~1.3GB
docker compose exec ollama ollama pull phi3:mini      # ~2.3GB
```

### Reset everything

```bash
# WARNING: This deletes all data!
make reset
make setup
```

## Production Deployment

For production, consider:

1. **External PostgreSQL** with proper backups (see [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md))
2. **Redis Cluster** for high availability ([Redis](https://cogitator.app/docs/deployment/redis))
3. **GPU server** for Ollama (or use cloud APIs)
4. **Reverse proxy** (nginx, Caddy) for HTTPS
5. **Environment secrets** management

`cogitator deploy` builds a production image for your project and runs it with Redis and PostgreSQL, or deploys it to Fly.io. See [DEPLOY.md](./DEPLOY.md) for the production deployment guide.
