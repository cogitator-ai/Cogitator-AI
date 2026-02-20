# @cogitator-ai/deploy

One-command deployment engine for Cogitator agents. Supports Docker and Fly.io targets with auto-detection of project configuration.

## Installation

```bash
pnpm add @cogitator-ai/deploy
```

## Quick Start

### Via CLI

```bash
# Deploy to Docker (default)
cogitator deploy

# Deploy to Fly.io
cogitator deploy --target fly

# Dry run — see what would happen
cogitator deploy --dry-run

# Check status
cogitator deploy status

# Tear down
cogitator deploy destroy
```

### Programmatic API

```typescript
import { Deployer } from '@cogitator-ai/deploy';

const deployer = new Deployer();

// Plan deployment
const plan = await deployer.plan({
  projectDir: process.cwd(),
  target: 'docker',
  dryRun: false,
  noPush: true,
});

// Execute deployment
const result = await deployer.deploy({
  projectDir: process.cwd(),
  target: 'fly',
});

console.log(result.url); // https://my-app.fly.dev
```

## Configuration

Add a `deploy` section to `cogitator.yml`:

```yaml
deploy:
  target: fly
  port: 3000
  region: iad
  instances: 2
  registry: ghcr.io/myorg/myapp
  services:
    redis: true
    postgres: true
  secrets:
    - OPENAI_API_KEY
    - DATABASE_URL
```

## Auto-Detection

The deploy engine automatically detects:

| What             | Source                        | Example                            |
| ---------------- | ----------------------------- | ---------------------------------- |
| Server adapter   | `package.json` dependencies   | `@cogitator-ai/express` → Express  |
| Services         | `cogitator.yml` memory config | `adapter: redis` → Redis service   |
| Required secrets | LLM provider configs          | `openai` → `OPENAI_API_KEY`        |
| Ollama Cloud     | Model suffix or API key       | `:cloud` suffix → `OLLAMA_API_KEY` |

## Deploy Targets

### Docker

Generates a multi-stage `Dockerfile` and optional `docker-compose.prod.yml`:

```bash
cogitator deploy --target docker           # Build only
cogitator deploy --target docker --push    # Build + push to registry
```

### Fly.io

Generates `fly.toml` and deploys via `flyctl`:

```bash
cogitator deploy --target fly --region iad
```

Requires `flyctl` installed and authenticated.

## Architecture

```
ProjectAnalyzer  →  ArtifactGenerator  →  DeployProvider  →  Result
(detect config)     (Dockerfile, etc.)     (docker/fly)       (url, status)
```

- **ProjectAnalyzer** — reads `package.json` and `cogitator.yml` to detect server, services, secrets
- **ArtifactGenerator** — generates Dockerfile, docker-compose, fly.toml from templates
- **DeployProvider** — executes preflight checks, builds, deploys (Docker or Fly.io)
- **Deployer** — orchestrator that ties it all together

## See Also

- [Deployment Guide](../../docs/DEPLOY.md) — full documentation with CI/CD examples
- [CLI Reference](../cli/README.md) — all CLI commands
