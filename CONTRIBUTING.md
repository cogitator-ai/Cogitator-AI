# Contributing to Cogitator

Thank you for your interest in contributing to Cogitator! This document explains how the repository is organised, how to run it locally and what a good pull request looks like.

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md): be respectful, inclusive and constructive.

Found a security issue? Please **don't** open a public issue — follow the [security policy](./.github/SECURITY.md) and report it privately.

## Getting Started

### Prerequisites

- Node.js 22.12+
- pnpm 11+ (`corepack enable` picks the exact version from `packageManager`)
- Bun (only to run the `@cogitator-ai/tetsu` tests)
- Docker (optional: sandbox, deploy and database-backed tests)
- Ollama (optional: local LLM for end-to-end tests)

### Setup

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/YOUR_USERNAME/Cogitator-AI.git
cd Cogitator-AI
git remote add upstream https://github.com/cogitator-ai/Cogitator-AI.git

pnpm install      # install dependencies
pnpm build        # build every package (Turborepo)
pnpm test         # unit tests of every package
pnpm dev          # watch mode
```

### Project Structure

The repository is a pnpm + Turborepo monorepo. Every package lives in `packages/<name>` and is published as `@cogitator-ai/<name>` (except `create-cogitator-app`, `dashboard` and `e2e`).

```
Cogitator-AI/
├── packages/
│   ├── types/                 # Shared TypeScript interfaces
│   ├── core/                  # Runtime: Cogitator, Agent, tool(), LLM backends
│   ├── models/                # Model registry with pricing
│   ├── config/                # YAML / env configuration
│   ├── memory/                # Memory adapters (Postgres, Redis, SQLite, MongoDB, Qdrant, in-memory)
│   ├── rag/                   # RAG pipeline: loaders, chunkers, retrieval, reranking
│   ├── workflows/             # DAG workflow engine: checkpoints, approvals, sagas, scheduling
│   ├── swarms/                # Multi-agent swarm strategies
│   ├── a2a/                   # Agent-to-Agent Protocol v0.3
│   ├── mcp/                   # Model Context Protocol client and server
│   ├── browser/               # Browser automation (Playwright)
│   ├── voice/                 # Voice and realtime agents (STT, TTS, VAD)
│   ├── channels/              # Telegram, Discord, Slack, WhatsApp, web chat
│   ├── evals/                 # Evaluation framework
│   ├── sandbox/               # Docker and WASM execution isolation
│   ├── wasm-tools/            # Pre-built WASM tools
│   ├── self-modifying/        # Runtime tool generation and meta-reasoning
│   ├── neuro-symbolic/        # Logic programming, SAT/SMT
│   ├── redis/                 # Redis client (standalone + cluster)
│   ├── worker/                # BullMQ distributed job queue
│   ├── server-shared/         # Shared streaming protocol for server adapters
│   ├── express/ fastify/ hono/ koa/ next/ tetsu/   # Server adapters
│   ├── ai-sdk/                # Vercel AI SDK adapter
│   ├── openai-compat/         # OpenAI Assistants API compatibility
│   ├── deploy/                # Docker and Fly.io deployment
│   ├── cli/                   # `cogitator` CLI
│   ├── create-cogitator-app/  # Project scaffolder
│   ├── test-utils/            # Mock backends, fixtures and helpers for tests
│   ├── e2e/                   # End-to-end test suite (not published)
│   └── dashboard/             # Website: landing, docs, cookbook (not published)
├── examples/                  # Runnable examples, grouped by package
├── docs/                      # Repository guides (architecture, security, deployment, …)
└── scripts/                   # Build and maintenance scripts
```

The user-facing documentation lives on [cogitator.app/docs](https://cogitator.app/docs); its source is the MDX in `packages/dashboard/content/docs/`.

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates
2. Use the bug report template
3. Include:
   - A clear description of the problem
   - Steps to reproduce (a minimal snippet is ideal)
   - Expected vs actual behaviour
   - Environment: OS, Node.js version, package versions, LLM provider and model
   - Relevant logs or error messages

### Suggesting Features

Start in [GitHub Discussions](https://github.com/cogitator-ai/Cogitator-AI/discussions) or use the feature request template. Describe the problem you are solving, your proposed solution and the alternatives you considered.

### Pull Requests

1. **Branch** from `main`:

   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Write code** following the standards below.

3. **Test** the packages you touched:

   ```bash
   pnpm --filter @cogitator-ai/<package> test
   pnpm typecheck
   pnpm lint
   ```

4. **Add a changeset** if a published package changes (see [Changesets](#changesets)).

5. **Update the docs**: the package README, the MDX page on the website and the examples if behaviour or API changed.

6. **Commit** with a [conventional commit message](#commit-messages), push and open a pull request.

### Changesets

Releases are driven by [Changesets](https://github.com/changesets/changesets). Every pull request that changes a published package needs one:

```bash
pnpm changeset
```

Pick the affected packages and the bump (`patch` for fixes, `minor` for features; for `0.x` packages a breaking change is `minor` too, and a `major` bump needs a maintainer's agreement) and describe the change for users: what changed and why it matters to them. Docs-only, test-only and website changes need no changeset.

When changes land on `main`, the release workflow versions the packages, writes the changelogs and publishes to npm.

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

<what changed and why>
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, `ci`.

The scope is the package folder name (`core`, `workflows`, `memory`, `create-cogitator-app`, `dashboard`, …), or `e2e`, `examples`, `deps` for the rest of the repository. Keep the first line under 72 characters and explain _why_ in the body.

```
feat(workflows): resume approvals after a process restart
fix(memory): keep Redis thread order stable under concurrent writes
docs(rag): document the hybrid retriever options
```

## Coding Standards

### TypeScript

- Strict mode, ESM modules
- Prefer `interface` over `type` for object shapes
- No `any` — use `unknown` and narrow it; no `@ts-ignore`
- Validate external input with Zod
- Explicit return types on public APIs

```typescript
// Good
export interface RetryOptions {
  attempts: number;
  backoffMs?: number;
}

export function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  // ...
}

// Bad
export function withRetry(fn: any, options: any) {
  // ...
}
```

### Code Style

Prettier and ESLint are configured in the repository and run on staged files before every commit:

- 2 spaces, single quotes, semicolons, trailing commas (`es5`)
- Max line length: 100 characters
- Comments: JSDoc on public APIs; otherwise let names and structure explain the code (the pre-commit hook strips line comments from package sources)

```bash
pnpm format       # format everything
pnpm lint         # lint package sources
```

### Testing

- **Unit tests** live next to the code: `packages/<package>/src/__tests__/*.test.ts` (Vitest; `tetsu` uses `bun test`).
- **End-to-end tests** live in `packages/e2e/src/__tests__/<package>/*.e2e.ts` and run against real providers and services. Each suite is enabled by environment variables and skipped otherwise:

  | Variable                                 | Enables                                   |
  | ---------------------------------------- | ----------------------------------------- |
  | `TEST_OLLAMA=true`, `TEST_MODEL`         | Local Ollama runs (default `gpt-oss:20b`) |
  | `GOOGLE_API_KEY`, `OPENAI_API_KEY`       | Hosted provider runs                      |
  | `TEST_REDIS=true`, `TEST_POSTGRES_URL`   | Redis and Postgres adapters               |
  | `TEST_DOCKER=true`                       | Docker sandbox and deployment             |
  | `TEST_BROWSER=true`                      | Browser automation (Playwright)           |
  | `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` | Voice providers                           |

- Use `@cogitator-ai/test-utils` (`MockLLMBackend`, `MockMemoryAdapter`, fixtures) instead of calling real providers in unit tests.
- Regression tests for every bug fix; describe behaviour in the test name.

```typescript
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool';

describe('tool()', () => {
  it('describes zod parameters as JSON Schema for the LLM', () => {
    const add = tool({
      name: 'add',
      description: 'Add two numbers',
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    });

    expect(add.toJSON().parameters).toMatchObject({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    });
  });
});
```

```bash
pnpm --filter @cogitator-ai/core test                       # one package
pnpm --filter @cogitator-ai/e2e exec vitest run src/__tests__/memory   # one e2e area
```

### Documentation

When behaviour or API changes, update in the same pull request:

- the package `README.md`;
- the website docs in `packages/dashboard/content/docs/` (MDX);
- the runnable examples in `examples/`;
- the root `README.md`, if the change is user-visible enough to belong there.

## Development Workflow

### Working on One Package

```bash
pnpm --filter @cogitator-ai/core build
pnpm --filter @cogitator-ai/core test
pnpm --filter @cogitator-ai/core dev          # watch mode
pnpm dashboard                                # website at http://localhost:3000
```

### Adding Dependencies

```bash
pnpm --filter @cogitator-ai/core add zod      # runtime dependency
pnpm --filter @cogitator-ai/core add -D msw   # dev dependency
pnpm add -w -D typescript                     # workspace tooling
```

### Creating a New Package

1. Copy the layout of a small existing package (for example `packages/redis`): `package.json`, `tsconfig.json`, `src/index.ts`, `src/__tests__/`, `README.md`.
2. Name it `@cogitator-ai/<name>`; the workspace picks it up automatically.
3. Add it to the package table and examples in the root `README.md`, add a docs section in `packages/dashboard/content/docs/`, and add e2e tests in `packages/e2e/src/__tests__/<name>/`.

## Where Help Is Welcome

1. **LLM backends and models**: new providers and keeping the model registry current
2. **Memory and RAG**: storage adapters, loaders, retrievers
3. **Server adapters and channels**: new frameworks and messaging platforms
4. **Documentation and examples**: guides, recipes for the [cookbook](https://cogitator.app/cookbook)
5. **Tests**: end-to-end coverage against real providers
6. **Performance**: profiling and benchmarks

## Getting Help

- **Questions and ideas**: [GitHub Discussions](https://github.com/cogitator-ai/Cogitator-AI/discussions)
- **Bugs and feature requests**: [GitHub Issues](https://github.com/cogitator-ai/Cogitator-AI/issues)
- **Docs**: [cogitator.app/docs](https://cogitator.app/docs)

## License

By contributing to Cogitator, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

---

Thank you for contributing to Cogitator!
