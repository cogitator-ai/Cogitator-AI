# Docker Setup Guide

This guide explains how to run Cogitator with Docker for local development.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (20.10+)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2.0+)
- [Node.js](https://nodejs.org/) (v20+)
- [pnpm](https://pnpm.io/) (v9+)

## Quick Start

### Option 1: Using Make (Recommended)

```bash
# Full setup - starts services, pulls models, installs deps
make setup

# Start dashboard
make dev
```

### Option 2: Manual Setup

```bash
# Start Docker services
docker-compose up -d

# Wait for services to be ready, then pull models
docker-compose exec ollama ollama pull nomic-embed-text-v2-moe
docker-compose exec ollama ollama pull llama3.2:3b

# Install dependencies and build
pnpm install
pnpm build

# Start dashboard
cd packages/dashboard && pnpm dev
```

### Option 3: CPU Only (No GPU)

If you don't have an NVIDIA GPU:

```bash
docker-compose -f docker-compose.cpu.yml up -d
```

> The CPU variant pulls `nomic-embed-text` instead of `nomic-embed-text-v2-moe` as the embedding model.

## Services

After starting Docker, these services will be available:

| Service    | Port  | Description                      |
| ---------- | ----- | -------------------------------- |
| PostgreSQL | 5432  | Primary database with pgvector   |
| Redis      | 6379  | Cache, events, short-term memory |
| Ollama     | 11434 | Local LLM runtime                |

## Pre-installed Models

The setup includes:

| Model                     | Purpose               | Size   |
| ------------------------- | --------------------- | ------ |
| `nomic-embed-text-v2-moe` | Embeddings for memory | ~274MB |
| `llama3.2:3b`             | Default chat model    | ~2GB   |

## Commands Reference

```bash
# Service Management
make up              # Start services
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
make db-reset        # Reset database (deletes all data!)

# Development
make dev             # Start dashboard (also starts services)
make build           # Build all packages

# Cleanup
make clean           # Remove build artifacts
make reset           # Full reset (WARNING: removes all data)
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

# Embeddings
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text-v2-moe

# Sandbox (code execution isolation)
SANDBOX_DEFAULT_TYPE=native
SANDBOX_DEFAULT_TIMEOUT=30000
SANDBOX_MAX_CONTAINERS=5

# Dashboard
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cogitator Dashboard                       │
│                      http://localhost:3000                       │
└───────────────┬────────────────────────┬────────────────────────┘
                │                        │
    ┌───────────▼──────────┐  ┌─────────▼──────────┐
    │     PostgreSQL       │  │       Redis        │
    │  (pgvector enabled)  │  │  (cache + events)  │
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

The PostgreSQL database includes:

- **pgvector extension** for vector similarity search
- **768-dimension vectors** optimized for nomic-embed-text models
- **IVFFlat index** for fast similarity search
- **Pre-built function** `search_memory_by_embedding()` for semantic search

Example query:

```sql
-- Search memory by semantic similarity
SELECT * FROM search_memory_by_embedding(
    query_embedding := '[0.1, 0.2, ...]'::vector,
    match_threshold := 0.7,
    match_count := 10,
    filter_thread_id := 'thread_abc123'
);
```

## GPU Support

### NVIDIA GPU

The default `docker-compose.yml` includes GPU support. Requirements:

- NVIDIA GPU with CUDA support
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

### Apple Silicon (M1/M2/M3)

On macOS with Apple Silicon, Ollama runs natively outside Docker for best performance:

```bash
# Install Ollama natively
brew install ollama

# Start Ollama
ollama serve

# In another terminal, start other services
docker-compose up -d postgres redis

# Pull models
ollama pull nomic-embed-text-v2-moe
ollama pull llama3.2:3b
```

## Troubleshooting

### PostgreSQL connection refused

```bash
# Check if PostgreSQL is running
docker-compose ps postgres

# View logs
docker-compose logs postgres

# Restart
docker-compose restart postgres
```

### Ollama model pull fails

```bash
# Check Ollama logs
docker-compose logs ollama

# Try pulling manually
docker-compose exec ollama ollama pull llama3.2:3b
```

### Out of memory

For systems with limited RAM, use a smaller model instead of the default `llama3.2:3b`:

```bash
docker-compose exec ollama ollama pull llama3.2:1b   # ~1.3GB
docker-compose exec ollama ollama pull phi3:mini      # ~2.3GB
```

### Reset everything

```bash
# WARNING: This deletes all data!
make reset
make setup
```

## Production Deployment

For production, consider:

1. **External PostgreSQL** with proper backups
2. **Redis Cluster** for high availability
3. **GPU server** for Ollama (or use cloud APIs)
4. **Reverse proxy** (nginx, Caddy) for HTTPS
5. **Environment secrets** management

See [DEPLOYMENT.md](./DEPLOYMENT.md) for production deployment guide.
