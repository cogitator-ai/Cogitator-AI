# @cogitator-ai/deploy

## 0.3.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/config@0.9.0

## 0.3.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/config@0.8.0

## 0.3.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/config@0.7.0
  - @cogitator-ai/types@0.24.0

## 0.2.0

### Minor Changes

- The Docker target never started a deployment. It built and pushed the image but never ran compose; the compose file used the wrong build context and passed no secrets; and status/destroy used the legacy docker-compose binary, with destroy silently deleting volumes. Deploy now builds, then runs `docker compose -p <image> up -d` with .env secrets passed through, and destroy keeps volumes. The analyzer dropped detected services and secrets from the plan and swallowed config errors; both now surface as plan.warnings. The registry preflight used a docker flag that does not exist (`docker login --get-login`), so it always failed; it now reads the Docker config and credential helpers. .dockerignore was written where Docker ignores it, so .env secrets and node_modules went into images. The Dockerfile hard-coded pnpm --frozen-lockfile, dist/server.js and the EOL node:20; install steps now follow the lockfile, CMD comes from start/main, and the image is node:22. Fly overwrote the user's fly.toml, ignored failed secret imports, and did not apply `instances`. All commands now run without a shell (execFile), and app/image names default to the package name instead of the shared 'cogitator-app'. railway/k8s/ssh targets that had no provider were removed. Custom providers now work with the typed API via DeployTargetName.

  **Breaking changes**
  - DeployTarget narrowed to 'docker' | 'fly' (railway/k8s/ssh never had providers). Custom providers use Deployer.registerProvider plus DeployTargetName.
  - DockerProvider.deploy now also starts the compose stack. destroy no longer deletes volumes and throws on failure. FlyProvider.destroy throws on failure.
  - Generated artifacts changed: fly.toml now lives in .cogitator/; the Dockerfile uses node:22-alpine and lockfile-based installs; a root .dockerignore is created if missing.
  - The default image/app name is now derived from package.json name instead of 'cogitator-app'.
  - DeployPlan gained `warnings` and `analysis` fields (additive). ProjectAnalyzer.analyze accepts Partial<DeployConfig>.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/config@0.6.0
  - @cogitator-ai/types@0.23.0

## 0.1.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.3
  - @cogitator-ai/config@0.5.6

## 0.1.8

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/config@0.5.5

## 0.1.7

### Patch Changes

- Bound Docker and Fly.io preflight command checks so unavailable CLIs or daemons cannot hang CI or deployment validation.

## 0.1.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/config@0.5.4
  - @cogitator-ai/types@0.22.2

## 0.1.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/config@0.5.3

## 0.1.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/config@0.5.2

## 0.1.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/config@0.5.1

## 0.1.2

### Patch Changes

- Fix 3 bugs: fly.toml memory parsing ("1gb" -> 1mb), docker status/destroy stubs, fly secrets shell injection

## 0.1.1

### Patch Changes

- Add package README with Quick Start, configuration, auto-detection, and architecture docs
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/config@0.4.0
