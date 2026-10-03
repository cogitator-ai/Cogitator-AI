# Deployment Guide

> Deploy Cogitator agents to production in one command

The `cogitator deploy` command (from `@cogitator-ai/cli`) analyzes your project, generates a Dockerfile and target-specific artifacts in `.cogitator/`, runs preflight checks and deploys to Docker or Fly.io. The engine behind it is `@cogitator-ai/deploy`; see [Deploy Package](https://cogitator.app/docs/deployment/deploy-package) for the reference.

---

## Quick Start

### Deploy to Docker (local)

```bash
cogitator deploy --target docker
```

This builds a production image (multi-stage for TypeScript projects, with a `HEALTHCHECK`) and starts it with Docker Compose together with the Redis and PostgreSQL services your project needs.

### Deploy to Fly.io

```bash
cogitator deploy --target fly
```

Generates `.cogitator/fly.toml`, creates the app, stages secrets, and deploys. Your agent is live at `https://<app>.fly.dev` within minutes.

### Dry Run

Analyze and run the preflight checks without building or deploying anything:

```bash
cogitator deploy --target fly --dry-run
```

---

## Configuration Reference

Deployment settings live in the `deploy:` section of `cogitator.yml`. The rest of the file is a regular Cogitator config — the analyzer reads `llm.defaultModel` and `memory.adapter` from it:

```yaml
llm:
  defaultModel: openai/gpt-6.1-sol

memory:
  adapter: redis

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
    LOG_LEVEL: info
    CUSTOM_VAR: some-value

  secrets:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

  health:
    path: /cogitator/health
    interval: 30s
    timeout: 5s

  resources:
    memory: 512mb
    cpu: 1
```

### Fields

| Field               | Type                                | Default             | Description                                                             |
| ------------------- | ----------------------------------- | ------------------- | ----------------------------------------------------------------------- |
| `target`            | `docker \| fly`                     | `docker`            | Deployment target platform (`--target` wins)                            |
| `server`            | `express \| fastify \| hono \| koa` | auto-detected       | HTTP server framework; shown in the plan, does not change the artifacts |
| `port`              | `number`                            | `3000`              | Application port (`PORT` is set in the container)                       |
| `registry`          | `string`                            | none                | Container registry to push to (e.g. `ghcr.io/myorg`, `docker.io/user`)  |
| `image`             | `string`                            | `package.json` name | Docker image / Fly app name (sanitized; falls back to `cogitator-app`)  |
| `region`            | `string`                            | `iad`               | Fly.io region                                                           |
| `instances`         | `number`                            | `1`                 | Fly.io machine count; the Docker target always runs one container       |
| `services.redis`    | `boolean`                           | auto-detected       | Include a Redis service (Docker target)                                 |
| `services.postgres` | `boolean`                           | auto-detected       | Include a PostgreSQL service (Docker target)                            |
| `env`               | `Record<string, string>`            | none                | Environment variables for the app                                       |
| `secrets`           | `string[]`                          | auto-detected       | Secrets that must be set at deploy time; passed to the app              |
| `health.path`       | `string`                            | `/health`           | Health check path for the Dockerfile `HEALTHCHECK` and the Fly.io check |
| `health.interval`   | `string`                            | `30s`               | Health check interval                                                   |
| `health.timeout`    | `string`                            | `5s`                | Health check timeout                                                    |
| `resources.memory`  | `string`                            | `256mb`             | Fly.io VM memory (`mb` or `gb`)                                         |
| `resources.cpu`     | `number`                            | `1`                 | Fly.io shared CPUs                                                      |

Explicit `services` and `secrets` replace auto-detection rather than merging with it.

The server adapters mount their routes under `/cogitator` by default (Express `basePath`, Fastify `prefix`), so the health endpoint is `/cogitator/health`. Set `health.path` accordingly — with the default `/health` the container health check and the Fly.io check hit a route that does not exist.

`COGITATOR_DEPLOY_TARGET`, `COGITATOR_DEPLOY_PORT` and `COGITATOR_DEPLOY_REGISTRY` override `deploy.target`, `deploy.port` and `deploy.registry`.

---

## Docker Target

The Docker target builds a production image, optionally pushes it to a container registry, and starts it together with the services it needs via Docker Compose.

### Build Only (no push)

```bash
cogitator deploy --target docker --no-push
```

Generated artifacts in `.cogitator/`:

```
.cogitator/
  Dockerfile               # multi-stage build for TypeScript projects
  Dockerfile.dockerignore  # keeps .env and node_modules out of the build context
  docker-compose.prod.yml  # app + redis + postgres
  .dockerignore
```

A root `.dockerignore` with the same rules is created when the project has none.

### Build + Push to Registry

```bash
# Docker Hub
cogitator deploy --target docker --registry docker.io/myuser

# GitHub Container Registry
cogitator deploy --target docker --registry ghcr.io/myorg

# Custom registry
cogitator deploy --target docker --registry registry.example.com
```

The image is tagged `<registry>/<image>:latest`. Make sure you're authenticated first — preflight checks the Docker credentials for the registry host:

```bash
docker login ghcr.io
```

### Generated Dockerfile

Multi-stage build for a TypeScript project using pnpm with `"start": "node dist/server.js"`:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q --spider http://localhost:3000/cogitator/health || exit 1
CMD ["node","dist/server.js"]
```

The install commands follow your lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → `npm ci`; plain `npm install` without one), the build step only runs when `package.json` has a `build` script, and `CMD` comes from `scripts.start` (a plain `node <file>` script runs directly, anything else runs `npm start`), then `main`, then `dist/server.js`. Health check settings come from `deploy.health`.

For JavaScript projects (no `tsconfig.json`), a single-stage build with production dependencies only is generated instead.

### Generated Docker Compose

`docker-compose.prod.yml` always contains the app; Redis and/or Postgres are added when enabled:

```yaml
services:
  app:
    build:
      context: ..
      dockerfile: .cogitator/Dockerfile
    image: 'my-agent-service:latest'
    ports:
      - '3000:3000'
    environment:
      NODE_ENV: 'production'
      PORT: '3000'
      REDIS_URL: 'redis://redis:6379'
      DATABASE_URL: 'postgresql://cogitator:cogitator@postgres:5432/cogitator'
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 10s
      timeout: 3s
      retries: 3

  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: cogitator
      POSTGRES_PASSWORD: cogitator
      POSTGRES_DB: cogitator
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U cogitator']
      interval: 10s
      timeout: 3s
      retries: 3

volumes:
  redis-data:
  postgres-data:
```

`cogitator deploy` builds the image, pushes it when a registry is set, and starts this stack with `docker compose -p <image> -f .cogitator/docker-compose.prod.yml up -d --no-build`, passing secrets from your environment or `.env`. The app gets `REDIS_URL` and `DATABASE_URL` pointing at the bundled services — read them when you create your memory adapter or Redis client. The app is then at `http://localhost:<port>`.

`cogitator deploy status` reports whether the `app` service is running; `cogitator deploy destroy` runs `docker compose down` and keeps the volumes. To back up the bundled databases, see [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md#backup-procedures).

---

## Fly.io Target

Deploys to [Fly.io](https://fly.io) using `flyctl` (or `fly`). Creates the app, stages secrets, and deploys in one step.

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

This generates `.cogitator/fly.toml` (an existing `fly.toml` in your project is left untouched) and runs `fly deploy --config .cogitator/fly.toml --dockerfile .cogitator/Dockerfile`:

```toml
app = "my-agent-service"
primary_region = "iad"

[build]

[env]
  NODE_ENV = "production"
  PORT = "3000"
  LOG_LEVEL = "info"

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
    path = "/cogitator/health"

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

The bundled Redis and PostgreSQL services are Docker-only: on Fly.io, point your app at managed databases through `deploy.env` or `deploy.secrets`.

### Regions

Set the deploy region with `--region` or in `cogitator.yml`:

```bash
cogitator deploy --target fly --region lhr  # London
cogitator deploy --target fly --region nrt  # Tokyo
```

Common Fly.io regions: `iad` (Ashburn), `lhr` (London), `nrt` (Tokyo), `syd` (Sydney), `fra` (Frankfurt), `sin` (Singapore).

### Scaling

Configure resources and instances in `cogitator.yml`:

```yaml
deploy:
  target: fly
  instances: 2
  resources:
    memory: 1gb
    cpu: 2
```

With `instances` above 1, `min_machines_running` is set to the instance count and the deploy runs `fly scale count <instances>`; with 1, machines stop when idle and start on the next request.

### Endpoints

After deployment, the CLI prints:

```
API:    https://<app>.fly.dev
A2A:    https://<app>.fly.dev/.well-known/agent.json
Health: https://<app>.fly.dev<health.path>
```

The A2A agent card is only served if your app mounts an `@cogitator-ai/a2a` server adapter.

### Management

```bash
cogitator deploy status     # check if deployment is running
cogitator deploy destroy    # tear down the app (fly apps destroy)
```

---

## Auto-Detection

The deploy system inspects your project and automatically configures what it can. All auto-detected values can be overridden in `cogitator.yml`.

| Source                                             | What's Detected                             |
| -------------------------------------------------- | ------------------------------------------- |
| `package.json` has `@cogitator-ai/express`         | `server: express`                           |
| `package.json` has `@cogitator-ai/fastify`         | `server: fastify`                           |
| `package.json` has `@cogitator-ai/hono`            | `server: hono`                              |
| `package.json` has `@cogitator-ai/koa`             | `server: koa`                               |
| `package.json` `name`                              | `image` (`@acme/My Agent` → `my-agent`)     |
| Lockfile                                           | Package manager and install command         |
| `package.json` `scripts.start`, then `main`        | Container `CMD`                             |
| `cogitator.yml` has `memory.adapter: redis`        | `services.redis: true`                      |
| `cogitator.yml` has `memory.adapter: postgres`     | `services.postgres: true`                   |
| `cogitator.yml` has `llm.defaultModel: openai/...` | `secrets: [OPENAI_API_KEY]`                 |
| `llm.defaultModel` without a provider prefix       | Provider taken from `llm.defaultProvider`   |
| `tsconfig.json` exists                             | TypeScript project (multi-stage Dockerfile) |

The analyzer reads `cogitator.yml` (or `cogitator.yaml`) from the project directory; `--config` only changes where the CLI reads the `deploy:` section from. Problems found during analysis — an invalid config, an unparsable `package.json`, a missing start script, `tsconfig.json` without a `build` script, a local Ollama model on a cloud target, `instances > 1` on Docker — appear as warnings in the plan.

### Model-to-Secret Mapping

| Model Provider                     | Required Secret(s)                           |
| ---------------------------------- | -------------------------------------------- |
| `openai/*`                         | `OPENAI_API_KEY`                             |
| `anthropic/*`                      | `ANTHROPIC_API_KEY`                          |
| `google/*`                         | `GOOGLE_API_KEY`                             |
| `azure/*`                          | `AZURE_OPENAI_API_KEY`                       |
| `bedrock/*`                        | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `mistral/*`                        | `MISTRAL_API_KEY`                            |
| `groq/*`                           | `GROQ_API_KEY`                               |
| `together/*`                       | `TOGETHER_API_KEY`                           |
| `deepseek/*`                       | `DEEPSEEK_API_KEY`                           |
| `ollama/*:cloud`, `ollama/*-cloud` | `OLLAMA_API_KEY`                             |

Local Ollama models need no secret.

---

## Secrets Management

Secrets listed in `deploy.secrets` (or detected from the model) are read from the current environment or the project's `.env` file — the environment wins. Preflight **fails** when one of them is not set.

### Environment Variables

Set secrets as environment variables before deploying:

```bash
export OPENAI_API_KEY=sk-...
cogitator deploy --target fly
```

### Fly.io Secrets

For Fly.io, the secrets are imported with `fly secrets import --stage` during deployment. They're stored encrypted and injected as env vars at runtime. Multi-line values are rejected because `fly secrets import` cannot carry them.

```bash
# manually set a secret
flyctl secrets set OPENAI_API_KEY=sk-... --app my-agent-service
```

### Docker Secrets

For Docker, the secrets are passed through to the `app` container (`KEY: ${KEY:-}` in the Compose file) from your environment or the project's `.env` when `cogitator deploy` starts the stack:

```bash
echo "OPENAI_API_KEY=sk-..." >> .env
cogitator deploy --target docker
```

### cogitator.yml Secrets Reference

List secrets that must be available at deploy time:

```yaml
deploy:
  services:
    postgres: false
  secrets:
    - OPENAI_API_KEY
    - DATABASE_URL # an external database
```

Don't list `REDIS_URL` or `DATABASE_URL` (in `secrets` or `env`) while the matching bundled service is enabled on the Docker target: the Compose file already sets them, and the duplicate key makes Compose reject the file.

---

## Ollama Cloud

By default, Ollama models (`ollama/llama3.2`, `ollama/qwen3.5`, etc.) require a local Ollama server. Fly.io deployments don't include one, and neither does the Docker target's Compose stack.

### Options for Cloud Deployment

**1. Use a cloud LLM provider instead:**

```yaml
llm:
  defaultModel: openai/gpt-6.1-sol # or anthropic/claude-sonnet-5-5
```

**2. Use Ollama Cloud with the `:cloud` suffix:**

```yaml
llm:
  defaultModel: ollama/qwen3.5:cloud
```

Set your API key:

```bash
export OLLAMA_API_KEY=your-key
```

The deploy system detects the `:cloud` (or `-cloud`) suffix and adds `OLLAMA_API_KEY` to the required secrets automatically. `loadConfig()` from `@cogitator-ai/config` points the Ollama provider at `https://ollama.com` when only `OLLAMA_API_KEY` is set.

**3. Point to an external Ollama server:**

```yaml
deploy:
  env:
    OLLAMA_HOST: https://my-ollama.example.com
```

`loadConfig()` maps `OLLAMA_HOST` (or `OLLAMA_URL`) to `llm.providers.ollama.baseUrl`. If you build the `Cogitator` config yourself, pass `llm.providers.ollama.baseUrl` directly.

### Deploy Warning

If you deploy a local Ollama model to Fly.io, the plan shows a warning (the deploy still proceeds):

```
  Warnings:
    ! Model "ollama/llama3.2:3b" requires local Ollama server. Cloud targets don't include
      Ollama. Use a cloud model (e.g. qwen3.5:cloud with OLLAMA_API_KEY), switch to a cloud
      LLM provider, or set OLLAMA_HOST to an external Ollama URL.
```

---

## CI/CD Integration

Add `@cogitator-ai/cli` to your project's `devDependencies` so `pnpm exec cogitator` works in CI.

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
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 22

      - uses: pnpm/action-setup@v6

      - run: pnpm install --frozen-lockfile

      - name: Install flyctl
        uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Deploy to Fly.io
        run: pnpm exec cogitator deploy --target fly
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Docker Build + Push (GitHub Actions)

The Docker target always finishes by starting the Compose stack, so in CI it also brings the app up on the runner (discarded with the job). Secrets the plan requires must be set, or preflight fails.

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
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 22

      - uses: pnpm/action-setup@v6

      - run: pnpm install --frozen-lockfile

      - name: Login to GHCR
        run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin

      - name: Deploy
        run: pnpm exec cogitator deploy --target docker --registry ghcr.io/${{ github.repository_owner }}
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

---

## Troubleshooting

When a preflight check fails, the CLI lists the checks and a fix for each failure:

```
  Preflight checks:
    ✓ Docker is available
    ✗ Docker daemon is not running

✗ Preflight checks failed

  Fix: Start Docker Desktop or run: sudo systemctl start docker
```

| Check fails with                            | Fix                                                        |
| ------------------------------------------- | ---------------------------------------------------------- |
| `Docker is not installed`                   | Install Docker: https://docs.docker.com/get-docker/        |
| `Docker daemon is not running`              | Start Docker Desktop or run: `sudo systemctl start docker` |
| `Docker Compose v2 plugin is not available` | Install it: https://docs.docker.com/compose/install/       |
| `Not authenticated with <registry>`         | `docker login <registry host>`                             |
| `flyctl is not installed`                   | `curl -L https://fly.io/install.sh \| sh`                  |
| `Not authenticated with Fly.io`             | `flyctl auth login` (or set `FLY_API_TOKEN`)               |
| `OPENAI_API_KEY is not set`                 | Add `OPENAI_API_KEY` to `.env` or export it                |

### Local Ollama model on cloud target

See [Ollama Cloud](#ollama-cloud) section above.

### Container is unhealthy / Fly.io check fails

The health check hits `health.path`, which defaults to `/health`. With an adapter mounted under `/cogitator` (the Express and Fastify default) set `health.path: /cogitator/health`. If your adapter has an `auth` function, let requests to the health route through — it runs for `/health` too.

### Build fails

Check that your project builds locally first:

```bash
pnpm build
```

Common causes:

- Missing `build` script in `package.json` (the TypeScript build step is skipped and `dist/` is missing)
- TypeScript errors
- Missing dependencies

### Port conflict

If port 3000 is taken, change it in `cogitator.yml`:

```yaml
deploy:
  port: 8080
```

Your server must listen on `process.env.PORT`.

---

## Programmatic API

Use `@cogitator-ai/deploy` directly from code for custom deployment pipelines. Unlike the CLI, the `Deployer` does not read the `deploy:` section of `cogitator.yml`; pass it as `configOverrides`.

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
  console.log('Deployed:', result.url, result.endpoints);
} else {
  console.error('Failed:', result.error);
}
```

`deploy()` returns `{ success: false, error }` when preflight fails; `dryRun: true` stops after preflight without writing artifacts.

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
console.log('Warnings:', plan.warnings);
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
console.log('Package manager:', result.packageManager); // 'pnpm' | 'npm' | 'yarn'
console.log('Start command:', result.startCommand); // ['node', 'dist/server.js']
console.log('Warnings:', result.warnings);
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
    health: { path: '/cogitator/health' },
  },
  { hasTypeScript: true, packageManager: 'pnpm', hasLockfile: true }
);

for (const file of artifacts.files) {
  console.log(`${artifacts.outputDir}/${file.path}:`);
  console.log(file.content);
}
```

`generate()` only returns the files; `Deployer.deploy()` writes them to `.cogitator/`.

### Custom Providers

Register your own deploy provider. `target` accepts any registered provider name (`DeployTargetName`), not just the built-in `'docker' | 'fly'`:

```typescript
import { Deployer } from '@cogitator-ai/deploy';
import type { DeployProvider } from '@cogitator-ai/deploy';

const myProvider: DeployProvider = {
  name: 'my-cloud',
  async preflight() {
    return { checks: [], passed: true };
  },
  async generate() {
    return { files: [], outputDir: '.cogitator' };
  },
  async deploy(config) {
    return { success: true, url: `https://${config.image}.example.com` };
  },
  async status() {
    return { running: true };
  },
  async destroy() {},
};

const deployer = new Deployer();
deployer.registerProvider(myProvider);
console.log(deployer.availableTargets()); // ['docker', 'fly', 'my-cloud']

await deployer.deploy({
  projectDir: process.cwd(),
  target: 'my-cloud',
});
```

`Deployer.deploy()` passes your provider the artifacts from the built-in `ArtifactGenerator` (Dockerfile, `.dockerignore`, and a Compose file); `generate()` is part of the interface for standalone use. The CLI only accepts the built-in `docker` and `fly` targets.

### Check Status and Destroy

```typescript
import type { DeployConfig } from '@cogitator-ai/types';

const projectDir = process.cwd();
const config: DeployConfig = { image: 'my-agent-service' };

const status = await deployer.status('fly', config, projectDir);
console.log('Running:', status.running, status.url);

await deployer.destroy('fly', config, projectDir); // throws if teardown fails
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
  -t, --target <target>    Deploy target: docker, fly
  -c, --config <path>      Config file with a deploy: section
  --registry <url>         Container registry URL
  --no-push                Skip pushing image to registry
  --dry-run                Show plan without deploying
  --region <region>        Deploy region
```

The target is taken from `--target`, then `deploy.target`, then `docker`. See [cogitator deploy](https://cogitator.app/docs/cli#cogitator-deploy).

---

## Other Targets

Docker and Fly.io are the built-in targets. For Kubernetes, Railway or a VPS, register a [custom provider](#custom-providers) or run the generated `.cogitator/Dockerfile` with your platform's tooling.

---

<div align="center">

**Need help?** [GitHub Issues](https://github.com/cogitator-ai/Cogitator-AI/issues)

[Back to Getting Started](./GETTING_STARTED.md) | [Architecture](./ARCHITECTURE.md) | [Docker](./DOCKER.md) | [Disaster Recovery](./DISASTER_RECOVERY.md)

</div>
