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
cogitator deploy logs -f              # docker compose logs / flyctl logs
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

| Method                                              | Description                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `plan(options)`                                     | Analyze + preflight. Returns `config`, `preflight`, `warnings`, `analysis`, `provider`            |
| `deploy(options)`                                   | `plan`, generate artifacts, deploy. Returns `DeployResult` (`url`, `endpoints`, `error`)          |
| `status(target, config, projectDir, options?)`      | `DeployStatus` (`running`, `url`, `instances`, `uptime`)                                          |
| `destroy(target, config, projectDir, options?)`     | Tears down the deployment, throws when it fails                                                   |
| `logsCommand(target, config, projectDir, options?)` | A promise of the command that shows the logs (`follow`, `tail`, `service`, `timestamps`), as argv |
| `availableTargets()`                                | Names of registered providers (`['docker', 'fly']` by default)                                    |
| `registerProvider(provider)`                        | Add a custom `DeployProvider`                                                                     |
| `getProvider(target)`                               | The registered provider, throws for an unknown target                                             |

`DeployOptions`: `projectDir`, `target`, `dryRun` (plan and generate, then return `{ success: true, url: '(dry run)' }` without writing artifacts or deploying), `noPush` (drop the registry), `configOverrides` (a partial `DeployConfig`), `configPath` (the config file to read, by default the first of `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml`, `.cogitator.yaml` in `projectDir`, the same lookup as `loadConfig`) and `env` (where secrets come from, by default the project's `.env` under the process environment). `status`, `destroy` and `logsCommand` take `{ configPath }` too, and `logsCommand` resolves to the command. `deploy()` does not throw on failed preflight checks: it returns `{ success: false, error }` listing each failed check and its fix.

`ProjectAnalyzer` (`analyze(projectDir, overrides?, { configPath, env }?)`, `detectBuild(projectDir)`), `ArtifactGenerator`, `DockerProvider` and `FlyProvider` are exported for building your own pipeline.

## Configuration

Both `cogitator deploy` and the programmatic `Deployer` read the `deploy` section of the project's config file. `configOverrides` win over it field by field (inside `services`, `env`, `health` and `resources` too), and both win over auto-detection:

```yaml
deploy:
  target: fly # docker | fly (default: docker)
  kind: worker # server | worker (default: detected, see below)
  server: express # express | fastify | hono | koa | tetsu | next (default: detected)
  port: 3000 # default: 3000 for a server, none for a worker
  image: my-agent # Docker image (default: package.json name)
  app: my-agent-prod # Fly.io app name (default: image)
  org: acme # Fly.io organization a new app is created in (default: your default org)
  region: iad # Fly.io, default: iad
  instances: 2 # Fly.io only, docker runs one container
  registry: ghcr.io/myorg
  services: # default: detected from the memory adapter and the Ollama models
    redis: true
    postgres: true
    ollama: true # docker: an Ollama container next to the app
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
  hostGateway: true # docker: reach the host as host.docker.internal (set with services.ollama off)
  ollama: # docker, with services.ollama
    models: [qwen3:8b, nomic-embed-text] # default: the local Ollama models of the config
    gpu: true # reserve the host's NVIDIA GPUs (needs the NVIDIA Container Toolkit)
    image: ollama/ollama:0.40.10 # default shown
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
- the variables the config reads that are set, as `loadConfig` reads them: the `${VAR}` references of the file and the `COGITATOR_*` overrides such as `COGITATOR_LLM_DEFAULT_MODEL`, so the app resolves its config the way the analysis did (the models it pulls among them). Left out are `COGITATOR_DEPLOY_*`, Ollama URLs of this machine and the URLs of the services the Compose stack runs

When nothing is detected but the project's `.env` defines variables, preflight fails rather than deploying an app without them. List what it needs in `deploy.secrets` (an empty list deploys without any).

Secrets are read from the current environment or the project's `.env` file. They are checked during preflight, passed through to the Docker Compose stack, and imported into Fly.io with `fly secrets import --stage`.

### Data that outlives a deploy

A SQLite memory (`memory.adapter: sqlite`) keeps its database directory on a volume: a Docker named volume, or a Fly volume created on the first deploy and mounted through `[mounts]`. The directory is also kept out of the image, so local data never ships. A database in the project root cannot get a volume and gets a warning, move it into a directory such as `data/memory.db`. Fly machines mount one volume, more fail preflight.

### Local Ollama

When the project's models run on a local Ollama, the docker target runs one next to the app (`services.ollama`, on by default then). Each role is looked at on its own. The chat role is every Ollama model of the config the runtime uses: `llm.defaultModel`, `context.summaryModel` unless `context.enabled` is false, the models of the memory stages that are set, `reflection.reflectionModel` with `reflection.enabled`, `guardrails.model` unless `guardrails.enabled` is false and `security.promptInjection.llmModel` with `classifier: llm`. Roles and their models are decided from the environment the deployment gets, `deploy.env` included (`defaultModel: ${CHAT_MODEL:-ollama/qwen3:8b}` pulls the model `deploy.env.CHAT_MODEL` names), so `deploy.env.COGITATOR_OLLAMA_BASE_URL` pointing at a GPU box keeps the chat there. A model an agent names in code is not in the config, list it in `ollama.models`. The embedding role is `memory.embedding` with `provider: ollama` (its model, `nomic-embed-text` by default). Ollama Cloud models (a `:cloud` tag, or an API key with no URL, which means `https://ollama.com` as in the config schema) are part of the chat role and never pulled. A role is local when its URL points at this machine, a role whose URL points beyond it keeps that URL and the variables it follows are forwarded, such as `GPU_OLLAMA` for `baseUrl: ${GPU_OLLAMA}`. With `llm.defaultProvider: ollama` and no model in the config (models named in agent code), there is nothing to pull, so the app reaches the Ollama of the host with a warning, unless `ollama.models` lists the models, which runs the container. A model name that `ollama pull` would refuse or read as a flag, such as `ollama/--insecure`, fails preflight.

The Compose file gets an `ollama` service on the `ollama/ollama` image with the models in the `ollama-data` volume and a health check, and a one-shot `ollama-pull` service that pulls the models on the first start: each model is an argument of the job, and one the volume has already is skipped, so later starts need no network. The app waits for both. A local chat role gets `COGITATOR_OLLAMA_BASE_URL`, `OLLAMA_BASE_URL`, `OLLAMA_URL` and `OLLAMA_HOST` pointing at `http://ollama:11434`, also when one of them was detected as a secret with a localhost value, and a variable named in `deploy.env` or `deploy.secrets` is left to you. The first deploy takes as long as the download, `cogitator deploy logs ollama-pull -f` shows it, and a failed download fails the deploy with the last lines of the job. With `services.ollama: true` and no model running on the container, the analyzer warns. `ollama.models` replaces the detected list, `ollama.gpu: true` reserves the NVIDIA GPUs of the host, `ollama.image` runs another release or `ollama/ollama:rocm`.

The embedding service reads its URL from `memory.embedding.baseUrl` only, so the deployment points the variables that value follows at the container: write it as `${OLLAMA_BASE_URL:-http://localhost:11434}`, or `${OLLAMA_EMBEDDING_URL:-http://localhost:11434}` when the chat models use another Ollama. A variable gets the whole URL, or only the host (`http://${EMBED_HOST:-localhost}:11434` gets `EMBED_HOST=ollama`), whichever gives the target URL, and is left alone with a warning when neither does. A variable that the settings of another provider reference (`llm.providers.openai.baseUrl: ${OLLAMA_BASE_URL}/v1`) is never rewritten, and a variable is only set when it moves no role that stays remote, so a chat model on a GPU box keeps its URL while the embeddings run in the container, and the analyzer warns when the embeddings cannot be reached (a literal localhost URL, or a variable the remote chat URL reads too).

With `services.ollama: false` the local roles reach the Ollama of the host instead: the Compose file maps `host.docker.internal` to the host and points the same variables at it, each role keeping the port of its own local URL, and a warning lists the models to pull there. The keys of `services` you set replace the detected ones one by one, so `services: { ollama: false }` keeps Redis and Postgres detected from the memory adapter. On Linux, Ollama must listen beyond localhost (`OLLAMA_HOST=0.0.0.0 ollama serve`). An Ollama URL that already points to another machine is passed through as it is. Other targets warn, since they have no Ollama.

## Auto-Detection

| What             | Source                                                | Example                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind and server  | `package.json` dependencies                           | `@cogitator-ai/express` → Express server, `@cogitator-ai/channels` → worker                                                                                                                         |
| Image / app name | `package.json` `name`                                 | `@acme/My Agent` → `my-agent` (fallback `cogitator-app`), `deploy.app` names the Fly app                                                                                                            |
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

The image is a production build in three stages. `base` is `node:24-alpine`, or `oven/bun:1-alpine` when the start command runs `bun`. `builder` adds the native toolchain (`python3`, `make`, `g++`), installs from the lockfile with the package manager's cache in a BuildKit cache mount, runs the build and drops the dev dependencies. `runtime` copies the result, runs as the image's unprivileged user (`node` or `bun`) under `tini`, so signals reach the app and child processes are reaped, and sets `NODE_ENV=production`. A server also gets `PORT`, `EXPOSE` and a `HEALTHCHECK` on its health path. A Node app whose package manager is Bun builds on the Node image with Bun copied in and `node-gyp` installed, so native dependencies such as `better-sqlite3` compile. A `start` script of the form `node [flags] dist/index.js` becomes the `CMD` directly, without its `--env-file` flags: the container gets its environment from the deployment. `file:` and `link:` dependencies are copied in before the install step. A Yarn Berry project on Plug'n'Play (Yarn's default linker) installs its package archives into the image's `.yarn/cache`, keeps only the production ones, and starts with the PnP resolver loaded through `NODE_OPTIONS` (`.pnp.cjs`, and `.pnp.loader.mjs` for ES modules).

## Deploy Targets

### Docker

Artifacts are written to `.cogitator/`: `Dockerfile`, `.dockerignore`, `Dockerfile.dockerignore` and `docker-compose.prod.yml`. A root `.dockerignore` is created when the project has none, so `.env` and `node_modules` never enter the image.

`deploy` builds and tags the image (`<registry>/<image>:latest`), pushes it when a registry is configured, then runs `docker compose up -d` for the app plus the Redis, PostgreSQL and Ollama services it needs (health-gated, data in named volumes). Each key appears once in the app's Compose `environment`: a `REDIS_URL` / `DATABASE_URL` in `env` replaces the bundled service URL, and one listed in `secrets` is read from your environment with the bundled URL as fallback. The app container must then keep running for a few seconds (`new DockerProvider({ startupCheckMs })`, 8 seconds by default): one that exits or restarts fails the deploy with its last log lines, so a missing secret is reported instead of a restart loop. The result's `url` is `http://localhost:<port>` for a server, a worker without a port has none. `status` reports whether the `app` service is running, `logsCommand` builds `docker compose logs` (`--follow`, `--tail`, 100 lines by default, `--timestamps`, one service), `destroy` runs `docker compose down` and keeps volumes, the pulled models among them.

Preflight checks: Docker installed, daemon running, Compose v2 available, registry credentials (read from the Docker config, credential helpers and stores), secrets.

### Fly.io

Generates `.cogitator/fly.toml` (your own `fly.toml` is never overwritten) with `[env]`, VM size from `resources`, a `[mounts]` volume when there is one, and for a server an HTTP service with checks from `health` and `min_machines_running` from `instances` (machines auto-stop and auto-start). A worker gets no checks and is never auto-stopped. The app is `deploy.app`, else the image name. `deploy` creates the app when needed (`fly apps create --org <org>` with `deploy.org`, your default organization without it) and its volume, stages secrets, runs `fly deploy --config .cogitator/fly.toml --dockerfile .cogitator/Dockerfile`, and scales to `instances`. For a server the result lists `https://<app>.fly.dev`, its health URL and the A2A agent card (`/.well-known/agent.json`). Fly runs no Redis or Postgres next to the app: with those services, `REDIS_URL` / `DATABASE_URL` become required secrets (create them with `fly redis create`, `fly postgres create` or any hosted service). `status` reads `fly status`, `logsCommand` builds `fly logs --app <app>` (`--no-tail` unless following, no service, `tail` or `timestamps`, which it refuses), `destroy` runs `fly apps destroy`. Preflight checks: the app name follows the Fly rules (lowercase letters, digits and dashes, starting and ending with a letter or digit, 63 characters at most) and `deploy.org` is a slug, `flyctl` installed, `fly auth whoami`, secrets. Works with either `flyctl` or `fly` on `PATH`.

## Custom Providers

```typescript
import {
  ArtifactGenerator,
  Deployer,
  ProjectAnalyzer,
  type DeployCommand,
  type DeployLogsOptions,
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
  async logsCommand(
    config: DeployConfig,
    projectDir: string,
    options: DeployLogsOptions
  ): Promise<DeployCommand> {
    return {
      command: 'kubectl',
      args: ['logs', 'deploy/agents', ...(options.follow ? ['-f'] : [])],
    };
  }
}

const deployer = new Deployer();
deployer.registerProvider(new KubernetesProvider());
await deployer.deploy({ projectDir: process.cwd(), target: 'kubernetes' });
```

`Deployer.deploy()` runs preflight, calls your provider's `generate(config, projectDir)` and hands the result to its `deploy()` (with `dryRun` it stops after `generate()`). Writing the files to disk is up to the provider. `logsCommand` is optional and may return the command or a promise of it: `Deployer.logsCommand(target, config, projectDir, options)` resolves to the command for the caller to run with the terminal attached, the way `cogitator deploy logs` does. The example reuses the built-in Dockerfile: `ProjectAnalyzer.detectBuild(projectDir)` reports the TypeScript setup, package manager, lockfile, build script and start command that `ArtifactGenerator` needs.

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
