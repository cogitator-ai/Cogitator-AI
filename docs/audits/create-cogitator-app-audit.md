# Audit: @cogitator-ai/create-cogitator-app

Started: 2026-02-25

## Status

## Status: Complete

Last updated: 2026-02-25
Last updated: 2026-02-25

## Completed Steps

### Step 15: CLAUDE.md ✅

Package listed at CLAUDE.md line 144 — `create-cogitator-app/ # Interactive project scaffolder`. No changes needed.

### Step 14: Examples ✅

Created `examples/create-cogitator-app/scaffold-programmatic.ts` — demonstrates programmatic scaffold API. Added `create-cogitator-app: workspace:*` dep to examples/package.json. Added section to examples/README.md. Example runs successfully.

### Step 13: Docs site ✅

No dedicated page existed. Created `packages/dashboard/content/docs/getting-started/scaffolding.mdx` with templates table, CLI flags reference, providers table, generated structure, and programmatic API. Added to `meta.json` pages array.

### Step 12: Root README ✅

Package listed in root README packages table (line 262) and referenced in quick start (line 62). No changes needed.

### Step 11: Package README ✅

README was missing — created `packages/create-cogitator-app/README.md` with: usage examples, templates table, CLI flags, providers table, programmatic API, generated project structure.

### Step 10: Test coverage gaps ✅

Extended unit tests to 100 (added providerEnvKey, providerConfig, cogitatorYml, readme coverage). Extended e2e to 12 tests (added git init test, git=false test). All 100 unit + 12 e2e pass.

### Step 9: E2E tests exist and pass ✅

Created `packages/e2e/src/__tests__/create-cogitator-app/scaffold.e2e.ts` — 10 e2e tests. Tests scaffold real files to temp directories and verify: file creation, package.json content, docker-compose, template-specific deps, non-empty dir protection. 10/10 pass. Added lib export (`src/lib.ts`) to package for programmatic usage in tests.

### Step 8: Unit tests pass ✅

80/80 tests pass. Added vitest to devDependencies, `test`/`test:watch` scripts, `vitest.config.ts`.

### Step 7: Unit tests exist ✅

Created 3 test files with 80 tests:

- `src/__tests__/prompts.test.ts` — parseArgs (22 tests)
- `src/__tests__/utils.test.ts` — package-manager, env-example, docker-compose, gitignore, tsconfig (30 tests)
- `src/__tests__/templates.test.ts` — all templates, defaultModels (28 tests)

### Step 6: Dependencies check ✅

Runtime deps: `@clack/prompts`, `picocolors` — both present and used. Node built-ins need no listing. Template strings reference packages like `express`, `react` etc. but those are string content, not actual imports. devDeps clean. No changes needed.

### Step 5: Exports check ✅

This is a CLI binary (bin entry in package.json), not a library. `src/index.ts` has no exports — correct. `dist/index.d.ts` is 13 bytes (empty). No action needed.

### Step 4: Full source review ✅

Issues found and fixed across 21 source files:

**providers.ts:** `gemini-2.0-flash` → `gemini-2.5-flash` (model is 404 on API)
**prompts.ts:** Fixed array bounds on `--template`, `--provider`, `--pm` flags (crash on missing value). Fixed `rawName.trim()` before path operations. Updated Google hint to "Gemini 2.5 Flash".
**workflow.ts:** Complete rewrite of generated code to use correct API: `agentNode(agent, {inputMapper, stateMapper}).fn`, `functionNode(name, fn).fn`, state-based data access (no `ctx.results`). Removed unused `InMemoryCheckpointStore` import.
**swarm.ts:** Fixed `hierarchical` config — removed non-existent `coordination` wrapper, flattened to `{ visibility, workerCommunication }`.
**git.ts:** Fixed initial commit to set git identity via `-c user.name/user.email` flags (prevents failure on unconfigured git).
**docker-compose.ts:** Fixed hardcoded Postgres credentials to use env var defaults (`${POSTGRES_USER:-cogitator}`).
**env-example.ts + scaffold.ts:** Added REDIS_URL to `.env.example` for memory template.
**scaffold.ts:** Added non-empty directory check before scaffolding (prevents silent overwrite).

Build passes after all fixes.

### Step 3: Remove comments ✅

No comments found in packages/create-cogitator-app/ — 0 files modified.

### Step 2: Lint ✅

0 errors in packages/create-cogitator-app/. ESLint passes cleanly.

### Step 1: Build ✅

Build passes cleanly. Package name is `create-cogitator-app` (no `@cogitator-ai/` prefix). ESM output: `dist/index.js` (38.92 KB).

## Pending Steps

2. Lint
3. Remove comments
4. Full source review
5. Exports check
6. Dependencies check
7. Unit tests exist
8. Unit tests pass
9. E2E tests exist
10. Test coverage gaps
11. Package README
12. Root README
13. Docs site
14. Examples
15. CLAUDE.md

## Insights & Notes
