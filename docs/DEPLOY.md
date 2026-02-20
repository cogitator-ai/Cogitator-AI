# Deployment Guide

> Deploy Cogitator agents to production in one command

---

## Quick Start

### Deploy to Docker (local)

```bash
cogitator deploy --target docker
```

This builds a production Docker image with a multi-stage Dockerfile, health checks, and auto-detected services (Redis, Postgres).

### Deploy to Fly.io

```bash
cogitator deploy --target fly
```

Generates `fly.toml`, creates the app, sets secrets, and deploys. Your agent is live at `https://<app>.fly.dev` within minutes.

### Dry Run

Preview the deploy plan without executing anything:

```bash
cogitator deploy --target fly --dry-run
```

---

## Configuration Reference

All deployment settings live in the `deploy:` section of `cogitator.yml`:

```yaml
name: my-agent-service
model: gpt-4o
memory: redis

agents:
  - name: assistant
    instructions: 'You are a helpful assistant'
    tools: [web-search, calculator]

deploy:
  target: fly
  server: express
  port: 3000
  registry: ghcr.io/myorg
  image: my-agent-service
  region: iad
  instances: 1

  services:
    redis: true
    postgres: false

  env:
    NODE_ENV: production
    CUSTOM_VAR: some-value

  secrets:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

  health:
    path: /health
    interval: 30s
    timeout: 5s

  resources:
    memory: 512mb
    cpu: 1
```

### Fields

| Field               | Type                                     | Default         | Description                                                     |
| ------------------- | ---------------------------------------- | --------------- | --------------------------------------------------------------- |
| `target`            | `docker \| fly \| railway \| k8s \| ssh` | `docker`        | Deployment target platform                                      |
| `server`            | `express \| fastify \| hono \| koa`      | auto-detected   | HTTP server framework                                           |
| `port`              | `number`                                 | `3000`          | Application port                                                |
| `registry`          | `string`                                 | none            | Container registry URL (e.g. `ghcr.io/myorg`, `docker.io/user`) |
| `image`             | `string`                                 | `cogitator-app` | Docker image name                                               |
| `region`            | `string`                                 | `iad`           | Deploy region (provider-specific)                               |
| `instances`         | `number`                                 | `1`             | Number of running instances                                     |
| `services.redis`    | `boolean`                                | auto-detected   | Include Redis service                                           |
| `services.postgres` | `boolean`                                | auto-detected   | Include PostgreSQL service                                      |
| `env`               | `Record<string, string>`                 | none            | Environment variables for production                            |
| `secrets`           | `string[]`                               | auto-detected   | Provider-managed secrets (API keys)                             |
| `health.path`       | `string`                                 | `/health`       | Health check endpoint path                                      |
| `health.interval`   | `string`                                 | `30s`           | Health check interval                                           |
| `health.timeout`    | `string`                                 | `5s`            | Health check timeout                                            |
| `resources.memory`  | `string`                                 | `256mb`         | Memory allocation                                               |
| `resources.cpu`     | `number`                                 | `1`             | CPU allocation (cores or shares)                                |

---

## Docker Target

The Docker target builds a production image locally and optionally pushes it to a container registry.

### Build Only (no push)

```bash
cogitator deploy --target docker --no-push
```

Generated artifacts in `.cogitator/`:

```
.cogitator/
  Dockerfile              # multi-stage build
  docker-compose.prod.yml # app + redis + postgres
  .dockerignore
```

### Build + Push to Registry

```bash
# Docker Hub
cogitator deploy --target docker --registry docker.io/myuser

# GitHub Container Registry
cogitator deploy --target docker --registry ghcr.io/myorg

# Custom registry
cogitator deploy --target docker --registry registry.example.com
```

Make sure you're authenticated first:

```bash
docker login ghcr.io
```

### Generated Dockerfile

Multi-stage build for TypeScript projects:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q --spider http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

For JavaScript projects (no `tsconfig.json`), a single-stage build is generated instead.

### Generated Docker Compose

When services are detected, a `docker-compose.prod.yml` is generated with Redis and/or Postgres:

```yaml
services:
  app:
    build: .
    image: cogitator-app
    ports:
      - '3000:3000'
    environment:
      - NODE_ENV=production
      - PORT=3000
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://cogitator:cogitator@postgres:5432/cogitator
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 10s

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: cogitator
      POSTGRES_PASSWORD: cogitator
      POSTGRES_DB: cogitator
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U cogitator']
      interval: 10s

volumes:
  redis-data:
  postgres-data:
```

Run with:

```bash
docker compose -f .cogitator/docker-compose.prod.yml up -d
```

---

## Fly.io Target

Deploys to [Fly.io](https://fly.io) using `flyctl`. Creates the app, sets secrets, and deploys in one step.

### Prerequisites

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Authenticate
flyctl auth login
```

### Deploy

```bash
cogitator deploy --target fly
```

This generates `fly.toml` and deploys:

```toml
app = "my-agent-service"
primary_region = "iad"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[checks]
  [checks.health]
    port = 3000
    type = "http"
    interval = "30s"
    timeout = "5s"
    path = "/health"

[[vm]]
  memory = "256mb"
  cpu_kind = "shared"
  cpus = 1
```

### Regions

Set the deploy region with `--region` or in `cogitator.yml`:

```bash
cogitator deploy --target fly --region lhr  # London
cogitator deploy --target fly --region nrt  # Tokyo
```

Common Fly.io regions: `iad` (Ashburn), `lhr` (London), `nrt` (Tokyo), `syd` (Sydney), `fra` (Frankfurt), `sin` (Singapore).

### Scaling

Configure resources in `cogitator.yml`:

```yaml
deploy:
  target: fly
  resources:
    memory: 512mb
    cpu: 2
```

### Endpoints

After deployment, your agent is available at:

```
API:    https://<app>.fly.dev
A2A:    https://<app>.fly.dev/.well-known/agent.json
Health: https://<app>.fly.dev/health
```

### Management

```bash
cogitator deploy status     # check if deployment is running
cogitator deploy destroy    # tear down the app
```

---

## Auto-Detection

The deploy system inspects your project and automatically configures what it can. All auto-detected values can be overridden in `cogitator.yml`.

| Source                                     | What's Detected                             |
| ------------------------------------------ | ------------------------------------------- |
| `package.json` has `@cogitator-ai/express` | `server: express`                           |
| `package.json` has `@cogitator-ai/fastify` | `server: fastify`                           |
| `package.json` has `@cogitator-ai/hono`    | `server: hono`                              |
| `package.json` has `@cogitator-ai/koa`     | `server: koa`                               |
| `cogitator.yml` has `memory: redis`        | `services.redis: true`                      |
| `cogitator.yml` has `memory: postgres`     | `services.postgres: true`                   |
| `cogitator.yml` has `model: gpt-4o`        | `secrets: [OPENAI_API_KEY]`                 |
| `cogitator.yml` has `model: claude-*`      | `secrets: [ANTHROPIC_API_KEY]`              |
| `tsconfig.json` exists                     | TypeScript project (multi-stage Dockerfile) |

### Model-to-Secret Mapping

| Model Provider   | Required Secret        |
| ---------------- | ---------------------- |
| `openai/*`       | `OPENAI_API_KEY`       |
| `anthropic/*`    | `ANTHROPIC_API_KEY`    |
| `google/*`       | `GOOGLE_API_KEY`       |
| `azure/*`        | `AZURE_OPENAI_API_KEY` |
| `bedrock/*`      | `AWS_ACCESS_KEY_ID`    |
| `ollama/*:cloud` | `OLLAMA_API_KEY`       |

---

## Secrets Management

Secrets (API keys, credentials) are handled differently per target.

### Environment Variables

Set secrets as environment variables before deploying:

```bash
export OPENAI_API_KEY=sk-...
cogitator deploy --target fly
```

### Fly.io Secrets

For Fly.io, secrets are automatically set via `flyctl secrets set` during deployment. They're stored encrypted and injected as env vars at runtime.

```bash
# manually set a secret
flyctl secrets set OPENAI_API_KEY=sk-... --app my-agent-service
```

### Docker Secrets

For Docker, pass secrets via environment variables in `docker-compose.prod.yml` or use Docker secrets:

```bash
# via .env file
echo "OPENAI_API_KEY=sk-..." > .env
docker compose -f .cogitator/docker-compose.prod.yml --env-file .env up -d
```

### cogitator.yml Secrets Reference

List secrets that must be available at deploy time:

```yaml
deploy:
  secrets:
    - OPENAI_API_KEY
    - DATABASE_URL
    - REDIS_URL
```

The preflight check will warn if any listed secret is not set in the environment.

---

## Ollama Cloud

By default, Ollama models (`ollama/llama3.2`, `qwen3.5`, etc.) require a local Ollama server. Cloud deployment targets (Fly.io, Railway) don't include one.

### Options for Cloud Deployment

**1. Use a cloud LLM provider instead:**

```yaml
model: gpt-4o # or anthropic/claude-sonnet-4-5
```

**2. Use Ollama Cloud with the `:cloud` suffix:**

```yaml
model: ollama/qwen3.5:cloud
```

Set your API key:

```bash
export OLLAMA_API_KEY=your-key
```

The deploy system detects the `:cloud` suffix and adds `OLLAMA_API_KEY` to required secrets automatically.

**3. Point to an external Ollama server:**

```yaml
llm:
  providers:
    ollama:
      baseUrl: https://my-ollama.example.com

deploy:
  env:
    OLLAMA_HOST: https://my-ollama.example.com
```

### Deploy Warning

If you try to deploy a local Ollama model to a cloud target, the preflight check warns you:

```
Model "ollama/llama3.2:3b" requires local Ollama server.
Cloud targets don't include Ollama. Options:
  1. Switch to a cloud model (gpt-4o, claude-sonnet)
  2. Use Ollama Cloud (model:cloud suffix + OLLAMA_API_KEY)
  3. Point to external Ollama URL via OLLAMA_HOST env
```

---

## CI/CD Integration

### GitHub Actions

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: pnpm/action-setup@v4

      - run: pnpm install --frozen-lockfile

      - name: Install flyctl
        uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Deploy to Fly.io
        run: cogitator deploy --target fly
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Docker Build + Push (GitHub Actions)

```yaml
name: Build and Push

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: pnpm/action-setup@v4

      - run: pnpm install --frozen-lockfile

      - name: Login to GHCR
        run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

      - name: Deploy
        run: cogitator deploy --target docker --registry ghcr.io/${{ github.repository_owner }}
```

---

## Troubleshooting

### Docker is not installed

```
Preflight: Docker is not installed
Fix: Install Docker — https://docs.docker.com/get-docker/
```

### Docker daemon is not running

```
Preflight: Docker daemon is not running
Fix: Start Docker Desktop or run — sudo systemctl start docker
```

### flyctl is not installed

```
Preflight: flyctl is not installed
Fix: curl -L https://fly.io/install.sh | sh
```

### Not authenticated with Fly.io

```
Preflight: Not authenticated with Fly.io
Fix: flyctl auth login
```

### Secret not set

```
Preflight: OPENAI_API_KEY is not set
Fix: export OPENAI_API_KEY=sk-...
```

### Local Ollama model on cloud target

See [Ollama Cloud](#ollama-cloud) section above.

### Build fails

Check that your project builds locally first:

```bash
pnpm build
```

Common causes:

- Missing `build` script in `package.json`
- TypeScript errors
- Missing dependencies

### Port conflict

If port 3000 is taken, change it in `cogitator.yml`:

```yaml
deploy:
  port: 8080
```

---

## Programmatic API

Use `@cogitator-ai/deploy` directly from code for custom deployment pipelines.

```bash
pnpm add @cogitator-ai/deploy
```

### Basic Usage

```typescript
import { Deployer } from '@cogitator-ai/deploy';

const deployer = new Deployer();

const result = await deployer.deploy({
  projectDir: process.cwd(),
  target: 'docker',
  noPush: true,
});

if (result.success) {
  console.log('Deployed:', result.endpoints);
} else {
  console.error('Failed:', result.error);
}
```

### Plan Before Deploy

Preview what will happen without executing:

```typescript
const plan = await deployer.plan({
  projectDir: process.cwd(),
  target: 'fly',
  configOverrides: {
    region: 'lhr',
    resources: { memory: '512mb', cpu: 2 },
  },
});

console.log('Config:', plan.config);
console.log('Preflight passed:', plan.preflight.passed);

for (const check of plan.preflight.checks) {
  console.log(`  ${check.passed ? 'OK' : 'FAIL'}: ${check.message}`);
}
```

### Analyze a Project

```typescript
import { ProjectAnalyzer } from '@cogitator-ai/deploy';

const analyzer = new ProjectAnalyzer();
const result = analyzer.analyze('/path/to/project');

console.log('Server:', result.server); // 'express' | 'fastify' | ...
console.log('Services:', result.services); // { redis: true, postgres: false }
console.log('Secrets:', result.secrets); // ['OPENAI_API_KEY']
console.log('TypeScript:', result.hasTypeScript);
```

### Generate Artifacts

```typescript
import { ArtifactGenerator } from '@cogitator-ai/deploy';

const generator = new ArtifactGenerator();
const artifacts = generator.generate(
  {
    target: 'docker',
    port: 3000,
    services: { redis: true },
  },
  { hasTypeScript: true }
);

for (const file of artifacts.files) {
  console.log(`${file.path}:`);
  console.log(file.content);
}
```

### Custom Providers

Register your own deploy provider:

```typescript
import { Deployer } from '@cogitator-ai/deploy';
import type { DeployProvider } from '@cogitator-ai/deploy';

const myProvider: DeployProvider = {
  name: 'my-cloud',
  async preflight(config, projectDir) {
    return { checks: [], passed: true };
  },
  async generate(config, projectDir) {
    return { files: [], outputDir: '.cogitator' };
  },
  async deploy(config, artifacts, projectDir) {
    return { success: true, url: 'https://my-app.example.com' };
  },
  async status(config, projectDir) {
    return { running: true };
  },
  async destroy(config, projectDir) {},
};

const deployer = new Deployer();
deployer.registerProvider(myProvider);

await deployer.deploy({
  projectDir: process.cwd(),
  target: 'my-cloud' as any,
});
```

### Check Status and Destroy

```typescript
const status = await deployer.status('fly', config, projectDir);
console.log('Running:', status.running);

await deployer.destroy('fly', config, projectDir);
```

---

## CLI Reference

```bash
cogitator deploy [action] [options]

Actions:
  (none)     Deploy the project (default)
  status     Check deployment status
  destroy    Tear down the deployment

Options:
  -t, --target <target>    Deploy target: docker, fly, railway, k8s, ssh
  -c, --config <path>      Path to cogitator.yml
  --registry <url>         Container registry URL
  --no-push                Skip pushing image to registry
  --dry-run                Show plan without deploying
  --region <region>        Deploy region
```

---

## Future Targets

These targets are planned but not yet implemented:

| Target     | Status    | Description                        |
| ---------- | --------- | ---------------------------------- |
| Docker     | Available | Build image, push to registry      |
| Fly.io     | Available | Deploy with flyctl                 |
| Railway    | Planned   | Zero-config from git or Dockerfile |
| Kubernetes | Planned   | Helm chart / manifests generation  |
| SSH/VPS    | Planned   | Deploy to a server via SSH         |

---

<div align="center">

**Need help?** [GitHub Issues](https://github.com/eL1Fe/cogitator/issues)

[Back to Getting Started](./GETTING_STARTED.md) | [Architecture](./ARCHITECTURE.md)

</div>
