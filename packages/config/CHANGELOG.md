# @cogitator-ai/config

## 0.4.0

### Minor Changes

- Add one-command deployment engine (`cogitator deploy`)
  - New deploy types: `DeployTarget`, `DeployConfig`, `DeployResult`, `DeployPlan`
  - Deploy section in `cogitator.yml` schema with target, port, region, instances, registry, services, secrets
  - CLI `deploy` command with `--target`, `--dry-run`, `--push`, `status`, and `destroy` subcommands

- Add Ollama Cloud support with API key authentication
  - `apiKey` field in `OllamaProviderConfig` for cloud authentication
  - `OLLAMA_API_KEY` env variable auto-detection with default base URL `https://ollama.com`
  - `Authorization: Bearer` header in OllamaBackend when API key is configured

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 0.3.13

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 0.3.12

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 0.3.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 0.3.8

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 0.3.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 0.3.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 0.3.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 0.3.4

### Patch Changes

- docs: sync package READMEs with main documentation

## 0.3.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 0.3.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 0.3.0

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

## 0.2.8

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 0.2.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 0.2.5

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 0.2.0

### Minor Changes

- Add YAML loader tests (file not found, parsing, default paths)
- Add config merge tests (priority order, deep merge, validation)
- Fix unsafe type cast for LLM provider validation
- Fix parseInt edge case (stricter number parsing with regex)

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
