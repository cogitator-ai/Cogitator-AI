# Audit: @cogitator-ai/deploy

Started: 2026-02-25

## Status

Complete
Last updated: 2026-02-25 03:27

## Completed Steps

### Step 1: Build — PASS

No issues.

### Step 2: Lint — PASS

No issues.

### Step 3: Remove comments — PASS

No changes, 0 comments found.

### Step 4: Full source review — 3 bugs fixed

**Bug 1 (fly-toml.ts:8)**: Memory parsing — `parseInt("1gb")` = 1, not 1024. If user specifies `memory: "1gb"`, fly.toml gets `memory = "1mb"`. Fixed: added `parseMemoryMb()` helper that handles both `gb` and `mb` suffixes.

**Bug 2 (docker.ts:114-118)**: `status()` always returned `{running: false}`, `destroy()` was empty. Fixed: `status()` now checks docker-compose ps, `destroy()` runs docker-compose down -v.

**Bug 3 (fly.ts:106)**: Shell injection — secret values (API keys) embedded in double-quoted shell string via `execSync`. Values with `$`, `"` or spaces would break the command or leak. Fixed: use `flyctl secrets import --app` with stdin piping via `input:` option.

## Pending Steps

All steps complete.

## Insights & Notes

- 3 bugs fixed in code:
  1. fly-toml.ts: memory "1gb" parsed to 1mb instead of 1024mb — added parseMemoryMb()
  2. docker.ts: status() stub + destroy() stub — implemented using docker-compose
  3. fly.ts: shell injection in secrets passthrough — switched to flyctl secrets import with stdin
- Added @cogitator-ai/deploy to e2e package dependencies
- 13 new tests added: exec.test.ts ×7, generator.test.ts ×6
- Created packages/e2e/src/**tests**/deploy/deploy.e2e.ts (15 E2E tests)
- Created packages/dashboard/content/docs/deployment/deploy-package.mdx
- Fixed README: removed dryRun from plan() example (plan() ignores it)
