# @cogitator-ai/openai-compat

## 21.0.0

### Major Changes

- ioredis peer accepts ^5 || ^6.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

## 20.0.0

### Major Changes

- Re-audit; the old report was renamed to openai-compat-audit-2026-02-25.md. Critical: RedisThreadStorage and PostgresThreadStorage used require() in an ESM package and could never connect; they now load the optional peers with a dynamic import. The adapter and server could not use persistent storage at all; a `storage` option was added. The per-process cache served stale data to other instances; it was removed, and per-thread locks prevent lost updates. Client function tools were a dead end, with submitToolOutputs leaving runs in_progress forever. They now drive a real requires_action → submit → resume flow on the same agent run, with expiry and cancel handling. Streaming fixes: SSE headers were never sent, early events were lost, emitting 'error' crashed, delta index grew per token (the SDK built N parts), and the stored message id did not match the streamed one. Run fixes: multi-turn context was lost, cancel never aborted the agent, the advertised 'cogitator' model was unusable (defaultModel added), run options were ignored, images were dropped, and the active-run guard was missing. Server/route fixes: the setup race (examples slept before start), logging:true crashing on pino-pretty, message desc ordering, limit parsing, files purpose and Content-Disposition, timing-safe auth with public /health, and list runs.

  **Breaking changes**
  - Assistant `function` tools are now executed client-side via requires_action (previously ignored)
  - cancelRun throws (HTTP 400) for runs that already finished
  - A thread rejects a second run while one is active (HTTP 400)
  - Message listing order is by insertion (desc = newest first) instead of second-resolution timestamps
  - OpenAIServer.start() no longer prints to the console unless logging is enabled; logging uses plain pino JSON instead of pino-pretty
  - Model id 'cogitator' requires the new defaultModel option
  - ThreadManager no longer caches; every read goes to storage

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 19.0.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/types@0.22.3

## 19.0.16

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 19.0.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 19.0.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 19.0.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 19.0.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 19.0.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 19.0.10

### Patch Changes

- @cogitator-ai/core@0.18.4

## 19.0.9

### Patch Changes

- fix(openai-compat): audit — 9 bugs fixed, +44 tests, v19.0.9
  - Fix SQL injection in PostgresThreadStorage (identifier validation)
  - Fix thread update route not persisting metadata changes
  - Fix unsafe type casts in ThreadManager (normalizeContent, extractTextContent)
  - Fix `as any` in tests → proper typing
  - Remove unused zod dependency
  - Move @types/node to devDependencies
  - Add missing exports (OpenAIServerConfig, AuthConfig, formatOpenAIError, etc.)
  - Fix 4 incorrect code examples in README
  - Add 44 new unit tests (storage, thread-manager, middleware)

## 19.0.8

### Patch Changes

- @cogitator-ai/core@0.18.3

## 19.0.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 19.0.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 19.0.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 19.0.3

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/types@0.19.2

## 19.0.2

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/types@0.19.1

## 19.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2

## 19.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/core@0.17.1

## 18.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/types@0.18.0

## 17.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/types@0.17.0

## 16.0.0

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/types@0.16.0

## 15.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/types@0.15.0

## 14.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/types@0.14.0

## 13.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/types@0.13.0

## 12.0.1

### Patch Changes

- @cogitator-ai/core@0.11.5

## 12.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/core@0.11.4

## 11.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/core@0.11.3

## 10.0.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/core@0.11.2

## 10.0.1

### Patch Changes

- @cogitator-ai/core@0.11.1

## 10.0.0

### Minor Changes

- DX Improvements - Phases 1-3

  Phase 1: Foundation
  - Added comprehensive JSDoc documentation to core public APIs
  - Extended config schema with memory, sandbox, reflection, guardrails, costRouting, logging

  Phase 2: Critical Fixes
  - ThreadManager: Added persistent storage with InMemoryThreadStorage, RedisThreadStorage, PostgresThreadStorage
  - SSE Streaming: EventEmitter-based real-time streaming for openai-compat
  - MCP Retry: Exponential backoff with auto-reconnect and connection recovery

  Phase 3: Polish
  - New examples: memory-persistence, openai-compat-server, mcp-integration, constitutional-guardrails

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0

## 9.0.0

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/types@0.10.0

## 8.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/core@0.9.0

## 7.0.0

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/types@0.8.1

## 6.0.0

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/types@0.8.0

## 5.0.1

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1

## 5.0.0

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/types@0.7.0

## 4.0.0

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/types@0.6.0

## 3.0.0

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/core@0.3.0

## 1.1.0

### Minor Changes

- Add `listFiles()` method to ThreadManager
- Fix `/v1/files` endpoint returning empty array (now returns actual files)
- Add console.warn for run execution failures (was silent fire-and-forget)
- Improve type safety: `unknown[]` → `AssistantTool[]` in StoredAssistant

### Tests

- Add tests for `listFiles()` method

## 1.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/core@0.1.1
