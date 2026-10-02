# @cogitator-ai/deploy

One-command deployment engine for Cogitator agents. Analyzes your project, generates a Dockerfile and target-specific artifacts, runs preflight checks and deploys to Docker or Fly.io.

## Installation

```bash
pnpm add @cogitator-ai/deploy
```

## Quick Start

### Via CLI

```bash
cogitator deploy --dry-run            # analyze + preflight, change nothing
cogitator deploy                      # Docker: build image, start the compose stack
cogitator deploy --target fly         # Fly.io
cogitator deploy status
cogitator deploy destroy
```

### Programmatic API

```typescript
import { Deployer } from '@cogitator-ai/deploy';

const deployer = new Deployer();

const plan = await deployer.plan({
  projectDir: process.cwd(),
  target: 'docker',
  noPush: true,
});

console.log(plan.config); // resolved DeployConfig (image, port, services, secrets, ...)
console.log(plan.warnings); // e.g. missing start script, local Ollama on a cloud target
console.log(plan.preflight.passed, plan.preflight.checks);

const result = await deployer.deploy({ projectDir: process.cwd(), target: 'fly' });
if (!result.success) throw new Error(result.error);
console.log(result.url); // https://my-app.fly.dev
```

| Method                                | Description                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `plan(options)`                       | Analyze + preflight. Returns `config`, `preflight`, `warnings`, `analysis`, `provider`       |
| `deploy(options)`                     | `plan`, generate artifacts, deploy. Returns `DeployResult` (`dryRun` stops before deploying) |
| `status(target, config, projectDir)`  | `DeployStatus` (`running`, `url`, `instances`)                                               |
| `destroy(target, config, projectDir)` | Tears down the deployment; throws when it fails                                              |
| `availableTargets()`                  | Names of registered providers (`['docker', 'fly']` by default)                               |
| `registerProvider(provider)`          | Add a custom `DeployProvider`                                                                |

## Configuration

Add a `deploy` section to `cogitator.yml` (or pass `configOverrides`):

```yaml
deploy:
  target: fly # docker | fly
  port: 3000
  image: my-agent # Docker image / Fly app name (default: package.json name)
  region: iad
  instances: 2 # Fly.io only
  registry: ghcr.io/myorg
  services:
    redis: true
    postgres: true
  env:
    LOG_LEVEL: info
  secrets:
    - OPENAI_API_KEY
  health:
    path: /health
    interval: 30s
    timeout: 5s
  resources:
    memory: 512mb
    cpu: 1
```

Secrets are read from the current environment or the project's `.env` file. They are checked during preflight, passed through to the Docker Compose stack, and imported into Fly.io with `fly secrets import --stage`.

## Auto-Detection

| What             | Source                                   | Example                                                                             |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Server adapter   | `package.json` dependencies              | `@cogitator-ai/express` → Express                                                   |
| Image / app name | `package.json` `name`                    | `@acme/My Agent` → `my-agent`                                                       |
| Package manager  | Lockfile                                 | `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `package-lock.json` → `npm ci` |
| Start command    | `scripts.start`, then `main`             | `node dist/index.js` → `CMD ["node","dist/index.js"]`, otherwise `npm start`        |
| Build step       | `tsconfig.json` + `scripts.build`        | Multi-stage build running `<pm> run build`                                          |
| Services         | `cogitator.yml` / `.yaml` memory adapter | `adapter: postgres` → PostgreSQL service                                            |
| Required secrets | `llm.defaultModel` (+ `defaultProvider`) | `openai/gpt-4o` → `OPENAI_API_KEY`; Bedrock → both AWS keys                         |
| Ollama Cloud     | Model tag `:cloud` / `-cloud`            | `gpt-oss:120b-cloud` → `OLLAMA_API_KEY`                                             |

Problems found during analysis (invalid config, unparsable `package.json`, missing start script, local Ollama models on cloud targets) are returned as `plan.warnings` instead of being ignored.

## Deploy Targets

### Docker

Artifacts are written to `.cogitator/`: `Dockerfile`, `Dockerfile.dockerignore` and `docker-compose.prod.yml`. A root `.dockerignore` is created when the project has none, so `.env` and `node_modules` never enter the image.

`deploy` builds and tags the image (`<registry>/<image>:latest`), pushes it when a registry is configured, then runs `docker compose up -d` for the app plus the Redis/PostgreSQL services it needs (health-gated, data in named volumes). `status` reports whether the `app` service is running; `destroy` runs `docker compose down` and keeps volumes.

Preflight checks: Docker installed, daemon running, Compose v2 available, registry credentials (read from the Docker config, credential helpers and stores), secrets.

### Fly.io

Generates `.cogitator/fly.toml` (your own `fly.toml` is never overwritten) with `[env]`, HTTP checks from `health`, VM size from `resources`, and `min_machines_running` from `instances`. `deploy` creates the app when needed, stages secrets, runs `fly deploy --config .cogitator/fly.toml --dockerfile .cogitator/Dockerfile`, and scales to `instances`. Works with either `flyctl` or `fly` on `PATH`.

## Custom Providers

```typescript
import { Deployer, type DeployProvider } from '@cogitator-ai/deploy';

class KubernetesProvider implements DeployProvider {
  readonly name = 'kubernetes';
  async preflight(config, projectDir) {
    /* ... */
  }
  async generate(config, projectDir) {
    /* ... */
  }
  async deploy(config, artifacts, projectDir) {
    /* ... */
  }
  async status(config, projectDir) {
    /* ... */
  }
  async destroy(config, projectDir) {
    /* ... */
  }
}

const deployer = new Deployer();
deployer.registerProvider(new KubernetesProvider());
await deployer.deploy({ projectDir: process.cwd(), target: 'kubernetes' });
```

All external commands are executed without a shell, so paths with spaces and user-supplied values are passed verbatim.

## Architecture

```
ProjectAnalyzer  →  ArtifactGenerator  →  DeployProvider  →  Result
(detect config)     (Dockerfile, etc.)     (docker/fly)       (url, status)
```

## See Also

- [Deployment Guide](../../docs/DEPLOY.md) — CI/CD examples
- [CLI Reference](../cli/README.md#cogitator-deploy)

## License

MIT
