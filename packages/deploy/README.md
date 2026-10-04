# @cogitator-ai/deploy

One-command deployment engine for Cogitator agents. Analyzes your project, generates a Dockerfile and target-specific artifacts, runs preflight checks and deploys to Docker or Fly.io.

Guide: [cogitator.app/docs/deployment/deploy-package](https://cogitator.app/docs/deployment/deploy-package)

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
  configOverrides: { port: 8080, secrets: ['OPENAI_API_KEY'] },
});

console.log(plan.config); // resolved DeployConfig (image, port, services, secrets, ...)
console.log(plan.warnings); // e.g. missing start script, local Ollama on a cloud target
console.log(plan.preflight.passed, plan.preflight.checks);

const result = await deployer.deploy({ projectDir: process.cwd(), target: 'fly' });
if (!result.success) throw new Error(result.error);
console.log(result.url); // https://my-app.fly.dev
```

| Method                                | Description                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `plan(options)`                       | Analyze + preflight. Returns `config`, `preflight`, `warnings`, `analysis`, `provider`   |
| `deploy(options)`                     | `plan`, generate artifacts, deploy. Returns `DeployResult` (`url`, `endpoints`, `error`) |
| `status(target, config, projectDir)`  | `DeployStatus` (`running`, `url`, `instances`, `uptime`)                                 |
| `destroy(target, config, projectDir)` | Tears down the deployment; throws when it fails                                          |
| `availableTargets()`                  | Names of registered providers (`['docker', 'fly']` by default)                           |
| `registerProvider(provider)`          | Add a custom `DeployProvider`                                                            |
| `getProvider(target)`                 | The registered provider; throws for an unknown target                                    |

`DeployOptions`: `projectDir`, `target`, `dryRun` (plan and generate, then return `{ success: true, url: '(dry run)' }` without writing artifacts or deploying), `noPush` (drop the registry) and `configOverrides` (a partial `DeployConfig`). `deploy()` does not throw on failed preflight checks: it returns `{ success: false, error }` listing each failed check and its fix.

`ProjectAnalyzer` (`analyze(projectDir, overrides?)`, `detectBuild(projectDir)`), `ArtifactGenerator`, `DockerProvider` and `FlyProvider` are exported for building your own pipeline.

## Configuration

Both `cogitator deploy` and the programmatic `Deployer` read the `deploy` section of the project's `cogitator.yml`. `configOverrides` win over it field by field (inside `services`, `env`, `health` and `resources` too), and both win over auto-detection:

```yaml
deploy:
  target: fly # docker | fly (default: docker)
  server: express # express | fastify | hono | koa (default: detected)
  port: 3000 # default: 3000
  image: my-agent # Docker image / Fly app name (default: package.json name)
  region: iad # Fly.io, default: iad
  instances: 2 # Fly.io only; docker runs one container
  registry: ghcr.io/myorg
  services: # default: detected from the memory adapter
    redis: true
    postgres: true
  env:
    LOG_LEVEL: info
  secrets: # default: detected from llm.defaultModel
    - OPENAI_API_KEY
  health: # defaults shown
    path: /cogitator/health
    interval: 30s
    timeout: 5s
  resources: # Fly.io VM, default: 256mb, 1 shared CPU
    memory: 512mb
    cpu: 1
```

`health.path` defaults to the path the Express and Fastify adapters serve at their default `/cogitator` base path. Set it only when the adapter is mounted elsewhere (Hono, Koa and Tetsu answer wherever you mount them). Projects from `create-cogitator-app` already set it: the `api-server` template mounts the adapter at `/api` and writes `health.path: /api/health`.

Secrets are read from the current environment or the project's `.env` file. They are checked during preflight, passed through to the Docker Compose stack, and imported into Fly.io with `fly secrets import --stage`.

## Auto-Detection

| What             | Source                                   | Example                                                                                                                                                         |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server adapter   | `package.json` dependencies              | `@cogitator-ai/express` → Express                                                                                                                               |
| Image / app name | `package.json` `name`                    | `@acme/My Agent` → `my-agent` (fallback `cogitator-app`)                                                                                                        |
| Package manager  | Lockfile                                 | `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `package-lock.json` → `npm ci`, none → `npm install`       |
| Start command    | `scripts.start`, then `main`             | `node dist/index.js` → `CMD ["node","dist/index.js"]`, any other script → `npm start`; without both, `node dist/server.js` (TypeScript) or `node src/server.js` |
| Build step       | `tsconfig.json` + `scripts.build`        | Multi-stage build running `<pm> run build`                                                                                                                      |
| Services         | `cogitator.yml` / `.yaml` memory adapter | `adapter: postgres` → PostgreSQL service                                                                                                                        |
| Required secrets | `llm.defaultModel` (+ `defaultProvider`) | `openai/gpt-6.1-sol` → `OPENAI_API_KEY`; Bedrock → both AWS keys                                                                                                |
| Ollama Cloud     | Model tag `:cloud` / `-cloud`            | `gpt-oss:120b-cloud` → `OLLAMA_API_KEY`                                                                                                                         |

Problems found during analysis (invalid config, unparsable `package.json`, missing start script, `tsconfig.json` without a `build` script, local Ollama models on cloud targets, `instances > 1` on Docker) are returned as `plan.warnings` instead of being ignored.

The image is based on `node:22-alpine`, sets `NODE_ENV=production` and `PORT`, exposes `port` and has a `HEALTHCHECK` on `health.path`.

## Deploy Targets

### Docker

Artifacts are written to `.cogitator/`: `Dockerfile`, `.dockerignore`, `Dockerfile.dockerignore` and `docker-compose.prod.yml`. A root `.dockerignore` is created when the project has none, so `.env` and `node_modules` never enter the image.

`deploy` builds and tags the image (`<registry>/<image>:latest`), pushes it when a registry is configured, then runs `docker compose up -d` for the app plus the Redis/PostgreSQL services it needs (health-gated, data in named volumes). Each key appears once in the app's Compose `environment`: a `REDIS_URL` / `DATABASE_URL` in `env` replaces the bundled service URL, and one listed in `secrets` is read from your environment with the bundled URL as fallback. The result's `url` is `http://localhost:<port>`. `status` reports whether the `app` service is running; `destroy` runs `docker compose down` and keeps volumes.

Preflight checks: Docker installed, daemon running, Compose v2 available, registry credentials (read from the Docker config, credential helpers and stores), secrets.

### Fly.io

Generates `.cogitator/fly.toml` (your own `fly.toml` is never overwritten) with `[env]`, HTTP checks from `health`, VM size from `resources`, and `min_machines_running` from `instances` (machines auto-stop and auto-start). `deploy` creates the app when needed, stages secrets, runs `fly deploy --config .cogitator/fly.toml --dockerfile .cogitator/Dockerfile`, and scales to `instances`; the result lists `https://<app>.fly.dev`, its health URL and the A2A agent card (`/.well-known/agent.json`). `status` reads `fly status`; `destroy` runs `fly apps destroy`. Preflight checks: `flyctl` installed, `fly auth whoami`, secrets. Works with either `flyctl` or `fly` on `PATH`.

## Custom Providers

```typescript
import {
  ArtifactGenerator,
  Deployer,
  ProjectAnalyzer,
  type DeployProvider,
} from '@cogitator-ai/deploy';
import type {
  DeployConfig,
  DeployResult,
  DeployStatus,
  GeneratedArtifacts,
  PreflightResult,
} from '@cogitator-ai/types';

class KubernetesProvider implements DeployProvider {
  readonly name = 'kubernetes';

  async preflight(config: DeployConfig, projectDir: string): Promise<PreflightResult> {
    return { checks: [], passed: true };
  }
  async generate(config: DeployConfig, projectDir: string): Promise<GeneratedArtifacts> {
    const build = new ProjectAnalyzer().detectBuild(projectDir);
    return new ArtifactGenerator().generate(config, build);
  }
  async deploy(
    config: DeployConfig,
    artifacts: GeneratedArtifacts,
    projectDir: string
  ): Promise<DeployResult> {
    // write artifacts.files to artifacts.outputDir, apply manifests, ...
    return { success: true, url: 'https://agents.example.com' };
  }
  async status(config: DeployConfig, projectDir: string): Promise<DeployStatus> {
    return { running: true };
  }
  async destroy(config: DeployConfig, projectDir: string): Promise<void> {}
}

const deployer = new Deployer();
deployer.registerProvider(new KubernetesProvider());
await deployer.deploy({ projectDir: process.cwd(), target: 'kubernetes' });
```

`Deployer.deploy()` runs preflight, calls your provider's `generate(config, projectDir)` and hands the result to its `deploy()` (with `dryRun` it stops after `generate()`). Writing the files to disk is up to the provider. The example reuses the built-in Dockerfile: `ProjectAnalyzer.detectBuild(projectDir)` reports the TypeScript setup, package manager, lockfile, build script and start command that `ArtifactGenerator` needs.

All external commands are executed without a shell, so paths with spaces and user-supplied values are passed verbatim.

## Architecture

```
ProjectAnalyzer  →  DeployProvider.generate  →  DeployProvider.deploy  →  Result
(detect config)     (Dockerfile, etc.)            (docker/fly)              (url, status)
```

## See Also

- [Deploy package guide](https://cogitator.app/docs/deployment/deploy-package)
- [Docker deployment](https://cogitator.app/docs/deployment/docker)
- [CLI reference](https://cogitator.app/docs/cli) — `cogitator deploy`

## License

MIT
