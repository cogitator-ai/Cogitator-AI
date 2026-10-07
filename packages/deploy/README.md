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

| Method                                          | Description                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `plan(options)`                                 | Analyze + preflight. Returns `config`, `preflight`, `warnings`, `analysis`, `provider`   |
| `deploy(options)`                               | `plan`, generate artifacts, deploy. Returns `DeployResult` (`url`, `endpoints`, `error`) |
| `status(target, config, projectDir, options?)`  | `DeployStatus` (`running`, `url`, `instances`, `uptime`)                                 |
| `destroy(target, config, projectDir, options?)` | Tears down the deployment, throws when it fails                                          |
| `availableTargets()`                            | Names of registered providers (`['docker', 'fly']` by default)                           |
| `registerProvider(provider)`                    | Add a custom `DeployProvider`                                                            |
| `getProvider(target)`                           | The registered provider, throws for an unknown target                                    |

`DeployOptions`: `projectDir`, `target`, `dryRun` (plan and generate, then return `{ success: true, url: '(dry run)' }` without writing artifacts or deploying), `noPush` (drop the registry), `configOverrides` (a partial `DeployConfig`), `configPath` (the config file to read, by default the first of `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml`, `.cogitator.yaml` in `projectDir`, the same lookup as `loadConfig`) and `env` (where secrets come from, by default the project's `.env` under the process environment). `status` and `destroy` take `{ configPath }` too. `deploy()` does not throw on failed preflight checks: it returns `{ success: false, error }` listing each failed check and its fix.

`ProjectAnalyzer` (`analyze(projectDir, overrides?, { configPath, env }?)`, `detectBuild(projectDir)`), `ArtifactGenerator`, `DockerProvider` and `FlyProvider` are exported for building your own pipeline.

## Configuration

Both `cogitator deploy` and the programmatic `Deployer` read the `deploy` section of the project's config file. `configOverrides` win over it field by field (inside `services`, `env`, `health` and `resources` too), and both win over auto-detection:

```yaml
deploy:
  target: fly # docker | fly (default: docker)
  kind: worker # server | worker (default: detected, see below)
  server: express # express | fastify | hono | koa | tetsu | next (default: detected)
  port: 3000 # default: 3000 for a server, none for a worker
  image: my-agent # Docker image / Fly app name (default: package.json name)
  region: iad # Fly.io, default: iad
  instances: 2 # Fly.io only, docker runs one container
  registry: ghcr.io/myorg
  services: # default: detected from the memory adapter
    redis: true
    postgres: true
  env:
    LOG_LEVEL: info
  secrets: # default: detected, see below
    - OPENAI_API_KEY
  health: # defaults shown
    path: /cogitator/health
    interval: 30s
    timeout: 5s
  resources: # Fly.io VM, default: 256mb, 1 shared CPU
    memory: 512mb
    cpu: 1
  volumes: # default: the directory of a SQLite memory database
    - path: data # relative to the app directory, or absolute
      size: 1 # GB, Fly.io volume size
  hostGateway: true # docker: reach the host as host.docker.internal (set for a local Ollama)
```

### Server or worker

`kind` decides how the app is run and checked:

- `server` answers HTTP on `port`. It gets a health check (`HEALTHCHECK`, Fly `[checks]`) and, on Fly, an HTTP service that stops idle machines and starts them on the next request. Detected from a Cogitator server adapter (`@cogitator-ai/express`, `fastify`, `hono`, `koa`, `tetsu`, `next`), Next.js or a plain HTTP framework (Express, Fastify, Hono, Koa).
- `worker` runs without serving HTTP, like a channel gateway (Telegram long polling) or a queue worker. It gets no health check, publishes `port` only when one is set, and on Fly is never stopped by the proxy (`auto_stop_machines = "off"`, no HTTP service without a port). Detected from `@cogitator-ai/channels` or `@cogitator-ai/worker`.

A project that is neither, such as a script that makes one call and exits, fails preflight: deployed, it would be restarted forever. Set `deploy.kind` when detection gets it wrong.

`health.path` defaults to the path of the detected adapter: `/cogitator/health` for Express, Fastify, Hono and Koa at their default base path, `/health` for Tetsu. Set it when the adapter is mounted elsewhere. Next.js has no health route of its own, so a server without a known path gets no health check and a warning. Projects from `create-cogitator-app` already set it: the `api-server` template mounts the adapter at `/api` and writes `health.path: /api/health`.

### Secrets

Unless `deploy.secrets` lists them, the secrets are detected:

- what the model's provider cannot run without, routed like the runtime routes it (`meta-llama/Llama-3.3-70B-Instruct-Turbo` with `defaultProvider: together` needs `TOGETHER_API_KEY`). Azure needs the key and the endpoint, Bedrock a region and credentials. A value written in `llm.providers` counts as provided. When an alias is set instead of the main name (`GEMINI_API_KEY` for `GOOGLE_API_KEY`), the alias is passed. Optional provider settings that are set (`OPENAI_BASE_URL`, `AWS_SESSION_TOKEN`) are passed too. `PROVIDER_ENV` of `@cogitator-ai/config` is the table behind this
- the names the code passes to `requireEnv('NAME')` under `src/`
- the variables of `.env.example` that are set

When nothing is detected but the project's `.env` defines variables, preflight fails rather than deploying an app without them. List what it needs in `deploy.secrets` (an empty list deploys without any).

Secrets are read from the current environment or the project's `.env` file. They are checked during preflight, passed through to the Docker Compose stack, and imported into Fly.io with `fly secrets import --stage`.

### Data that outlives a deploy

A SQLite memory (`memory.adapter: sqlite`) keeps its database directory on a volume: a Docker named volume, or a Fly volume created on the first deploy and mounted through `[mounts]`. The directory is also kept out of the image, so local data never ships. A database in the project root cannot get a volume and gets a warning, move it into a directory such as `data/memory.db`. Fly machines mount one volume, more fail preflight.

### Local Ollama

A local Ollama model on the docker target reaches the Ollama of the host: the Compose file maps `host.docker.internal` to the host and points `COGITATOR_OLLAMA_BASE_URL`, `OLLAMA_BASE_URL`, `OLLAMA_URL` and `OLLAMA_HOST` at it, keeping the port of your local URL. On Linux, Ollama must listen beyond localhost (`OLLAMA_HOST=0.0.0.0 ollama serve`). An Ollama URL that already points to another machine is passed through as it is. Other targets warn, since they have no Ollama.

## Auto-Detection

| What             | Source                                                | Example                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind and server  | `package.json` dependencies                           | `@cogitator-ai/express` → Express server, `@cogitator-ai/channels` → worker                                                                                                                         |
| Image / app name | `package.json` `name`                                 | `@acme/My Agent` → `my-agent` (fallback `cogitator-app`)                                                                                                                                            |
| Package manager  | Lockfile, `packageManager`, `pnpm-workspace.yaml`     | `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, Yarn 1 → `yarn install --frozen-lockfile`, Yarn Berry → `yarn install --immutable`, `bun.lock` → `bun install`, `package-lock.json` → `npm ci` |
| Install files    | Files next to `package.json`                          | `pnpm-workspace.yaml`, `.npmrc`, `patches/`, `.yarnrc.yml`, `.yarn/`, `bunfig.toml` are copied before the install step                                                                              |
| Runtime          | Start command, Bun lockfile, `@cogitator-ai/tetsu`    | `bun ...` start → `oven/bun:1-alpine` image, otherwise `node:24-alpine` (with Bun added for a Bun-managed Node app)                                                                                 |
| Start command    | `scripts.start`, then `main`                          | `node dist/index.js` → `CMD ["node","dist/index.js"]`, any other script → `npm start` (`yarn start`, `bun run start`)                                                                               |
| Build step       | `tsconfig.json` + `scripts.build`                     | Multi-stage build running `<pm> run build`                                                                                                                                                          |
| Services         | Config file memory adapter                            | `adapter: postgres` → PostgreSQL service                                                                                                                                                            |
| Volumes          | Config file `memory.sqlite.path`                      | `./data/memory.db` → volume on `/app/data`                                                                                                                                                          |
| Required secrets | Provider of the model, `requireEnv()`, `.env.example` | `openai/gpt-6.1-sol` → `OPENAI_API_KEY`, Bedrock → `AWS_REGION` and both AWS keys                                                                                                                   |
| Ollama Cloud     | Model tag `:cloud` / `-cloud`                         | `gpt-oss:120b-cloud` → `OLLAMA_API_KEY`                                                                                                                                                             |

Preflight starts with the project checks every target shares: `package.json` exists (a `cogitator wizard` assistant has none, it runs with `cogitator up` or `cogitator daemon start`), the project is a server or a worker, the `start` script does not load a `.env` file with `--env-file` (`.env` stays out of the image, use `--env-file-if-exists`), and secrets were found. Other problems (invalid config, unparsable `package.json`, missing start script, `tsconfig.json` without a `build` script, a server without a known health path, local Ollama, Redis or Postgres on Fly, `instances > 1` on Docker) are returned as `plan.warnings`.

The image is a production build in three stages. `base` is `node:24-alpine`, or `oven/bun:1-alpine` when the start command runs `bun`. `builder` adds the native toolchain (`python3`, `make`, `g++`), installs from the lockfile with the package manager's cache in a BuildKit cache mount, runs the build and drops the dev dependencies. `runtime` copies the result, runs as the image's unprivileged user (`node` or `bun`) under `tini`, so signals reach the app and child processes are reaped, and sets `NODE_ENV=production`. A server also gets `PORT`, `EXPOSE` and a `HEALTHCHECK` on its health path. A Node app whose package manager is Bun builds on the Node image with Bun copied in and `node-gyp` installed, so native dependencies such as `better-sqlite3` compile. A `start` script of the form `node [flags] dist/index.js` becomes the `CMD` directly, without its `--env-file` flags: the container gets its environment from the deployment. `file:` and `link:` dependencies are copied in before the install step.

## Deploy Targets

### Docker

Artifacts are written to `.cogitator/`: `Dockerfile`, `.dockerignore`, `Dockerfile.dockerignore` and `docker-compose.prod.yml`. A root `.dockerignore` is created when the project has none, so `.env` and `node_modules` never enter the image.

`deploy` builds and tags the image (`<registry>/<image>:latest`), pushes it when a registry is configured, then runs `docker compose up -d` for the app plus the Redis/PostgreSQL services it needs (health-gated, data in named volumes). Each key appears once in the app's Compose `environment`: a `REDIS_URL` / `DATABASE_URL` in `env` replaces the bundled service URL, and one listed in `secrets` is read from your environment with the bundled URL as fallback. The app container must then keep running for a few seconds (`new DockerProvider({ startupCheckMs })`, 8 seconds by default): one that exits or restarts fails the deploy with its last log lines, so a missing secret is reported instead of a restart loop. The result's `url` is `http://localhost:<port>` for a server, a worker without a port has none. `status` reports whether the `app` service is running, `destroy` runs `docker compose down` and keeps volumes.

Preflight checks: Docker installed, daemon running, Compose v2 available, registry credentials (read from the Docker config, credential helpers and stores), secrets.

### Fly.io

Generates `.cogitator/fly.toml` (your own `fly.toml` is never overwritten) with `[env]`, VM size from `resources`, a `[mounts]` volume when there is one, and for a server an HTTP service with checks from `health` and `min_machines_running` from `instances` (machines auto-stop and auto-start). A worker gets no checks and is never auto-stopped. `deploy` creates the app and its volume when needed, stages secrets, runs `fly deploy --config .cogitator/fly.toml --dockerfile .cogitator/Dockerfile`, and scales to `instances`. For a server the result lists `https://<app>.fly.dev`, its health URL and the A2A agent card (`/.well-known/agent.json`). Fly runs no Redis or Postgres next to the app: with those services, `REDIS_URL` / `DATABASE_URL` become required secrets (create them with `fly redis create`, `fly postgres create` or any hosted service). `status` reads `fly status`, `destroy` runs `fly apps destroy`. Preflight checks: `flyctl` installed, `fly auth whoami`, secrets. Works with either `flyctl` or `fly` on `PATH`.

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
