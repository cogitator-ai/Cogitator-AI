# create-cogitator-app

## 0.2.0

### Minor Changes

- pnpm projects get a `pnpm-workspace.yaml` allowing the native builds pnpm 10.26+/11 would otherwise refuse, so a fresh project installs again; current default models.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

## 0.1.1

### Patch Changes

- fix: audit — 10 bugs fixed, +112 tests added

  Key fixes:
  - Fix gemini-2.0-flash → gemini-2.5-flash (model was returning 404)
  - Fix array bounds crash when --template/--provider/--pm flags have no value
  - Fix workflow template to use correct agentNode/functionNode API
  - Fix swarm template hierarchical config (remove invalid coordination wrapper)
  - Fix git initial commit to configure identity (prevents failure on unconfigured git)
  - Fix docker-compose Postgres credentials to use env var defaults
  - Add REDIS_URL to .env.example for memory template
  - Add non-empty directory check before scaffolding (prevents silent overwrite)
  - Fix project name trimming before path resolution
  - Add lib.ts export for programmatic usage

  New: 100 unit tests, 12 e2e tests, package README, docs page
