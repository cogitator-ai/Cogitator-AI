# AGENTS.md

Guidance for coding agents, and for anyone else, working in this repository. It is a map and a set of rules. The full contributor guide is [CONTRIBUTING.md](./CONTRIBUTING.md), and the user documentation is [cogitator.app/docs](https://cogitator.app/docs).

## What this repository is

Cogitator is a self-hosted runtime for LLM agents in TypeScript: agents with type-safe tools, memory, multi-agent swarms, DAG workflows, server adapters, MCP and A2A. It is a pnpm and Turborepo monorepo. Every package lives in `packages/<name>` and is published to npm as `@cogitator-ai/<name>`, except `create-cogitator-app` (published under that name) and the private `dashboard`, `e2e` and `gauntlet`.

## Where things are

| Path                                   | What lives there                                                  |
| -------------------------------------- | ----------------------------------------------------------------- |
| `packages/<name>/src/`                 | Package source                                                    |
| `packages/<name>/src/__tests__/`       | Unit tests (Vitest, `tetsu` uses `bun test`)                      |
| `packages/<name>/README.md`            | Package README, shipped to npm                                    |
| `packages/types/`                      | Shared interfaces used across packages                            |
| `packages/core/`                       | The runtime: `Cogitator`, `Agent`, `tool()`, LLM backends         |
| `packages/e2e/src/__tests__/<name>/`   | End-to-end tests against real providers and services              |
| `packages/gauntlet/`                   | Every package wired together and run on real models               |
| `packages/dashboard/content/docs/`     | Website documentation (MDX), the source of cogitator.app/docs     |
| `packages/dashboard/src/app/cookbook/` | Website cookbook recipes                                          |
| `examples/<area>/`                     | Runnable examples, `npx tsx examples/<area>/<file>.ts`            |
| `docs/`                                | Repository guides: architecture, security, deployment, subsystems |
| `scripts/`                             | Build and maintenance scripts                                     |
| `.changeset/`                          | Pending release notes                                             |

## Setup and commands

Requires Node.js 22.12+ and pnpm 11 (`corepack enable` picks the version from `packageManager`). Bun is only needed for the `tetsu` tests, Docker and Ollama only for some e2e suites.

```bash
pnpm install
pnpm build                                   # every package
pnpm --filter @cogitator-ai/<name> build     # one package and nothing else
pnpm --filter @cogitator-ai/<name> test      # unit tests of one package
pnpm typecheck                               # whole monorepo
pnpm lint                                    # ESLint on package sources
pnpm format:check                            # Prettier on ts, tsx, md and json
pnpm changeset                               # add release notes
```

Packages import each other through their built `dist/`, so build a dependency before testing a package that uses a change in it. Prefer filtered commands over whole-repo runs while iterating, and run `pnpm typecheck` before pushing.

## Making a change

1. Keep the change focused on one topic. Do not reformat or refactor unrelated code in the same pull request.
2. Write or update unit tests next to the code. Every bug fix gets a regression test, named after the behaviour it protects.
3. Run the tests of the packages you touched, `pnpm typecheck`, `pnpm lint` and `pnpm format:check`.
4. Add a changeset when a published package changes in a way users can see: `patch` for fixes, `minor` for features (also for breaking changes while a package is `0.x`). Docs-only, test-only, example-only and website changes need none.
5. Update the docs in the same pull request when behaviour or API changes: the package README, the MDX page in `packages/dashboard/content/docs/`, the examples, and the root `README.md` if the change is user-visible enough.
6. Keep the numbers in the READMEs true. The root README counts examples ("N Runnable Examples" and the per-folder counts), packages and built-in tools. When you add one, update every place that counts it.

## Code rules

- TypeScript strict mode, ESM only.
- No `any` and no `@ts-ignore`. Use `unknown` and narrow it.
- Prefer `interface` for object shapes, and give public APIs explicit return types.
- Validate external input (config, HTTP bodies, tool arguments, provider payloads) with Zod at the boundary.
- Follow the patterns of the package you are in before introducing a new one. Add a dependency only when the platform and existing dependencies cannot do the job.
- Comments: JSDoc on public APIs, otherwise let names and structure explain the code. The pre-commit hook removes line comments from staged files under `packages/*/src/`, so a comment written there will not survive the commit. Do not run `scripts/remove-comments.ts` across the whole repository as part of an unrelated change.

## Tests

- Unit tests must not call real LLM providers or databases. Use `@cogitator-ai/test-utils`: `MockLLMBackend`, `MockMemoryAdapter`, fixtures and stream helpers.
- End-to-end tests are enabled by environment variables (`TEST_OLLAMA`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `TEST_REDIS`, `TEST_DOCKER` and others listed in CONTRIBUTING.md) and are skipped without them. Never commit keys or `.env` files.
- Examples run from the repository root after `pnpm build`, with `npx tsx examples/<area>/<file>.ts`. A new example is listed in its folder README and in the root README. An example that needs no API key should not ask for one.

## Writing

All text in the repository is in English: code, comments, docs, changesets, commit messages and pull request descriptions.

- Use a plain hyphen `-`, never an em dash or an en dash.
- Use straight quotes `"` and `'`, never typographic quotes.
- Do not use semicolons in prose, use a comma or a new sentence. Semicolons in code are fine.
- Describe what changed and why it matters to the reader, not the process that produced it. No "generated by" footers and no AI co-author trailers in commits or pull requests.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

<what changed and why>
```

Types are `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore` and `ci`. The scope is the package folder name (`core`, `memory`, `create-cogitator-app`, ...), or `e2e`, `examples` or `deps` for the rest of the repository. Keep the first line under 72 characters and explain the reason in the body.

Pull requests target `main`. If you are picking up an issue, comment on it first so it can be assigned to you, and reference it in the description (`Fixes #123`).

## Do not edit by hand

- `packages/*/CHANGELOG.md`: written by Changesets at release time.
- `packages/*/dist/` and other build output.
- `pnpm-lock.yaml`: change it through `pnpm install`, `pnpm add` or `pnpm update`.
