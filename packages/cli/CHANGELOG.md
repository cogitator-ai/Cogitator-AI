# @cogitator-ai/cli

## 0.3.0

### Minor Changes

- Add one-command deployment engine (`cogitator deploy`)
  - New deploy types: `DeployTarget`, `DeployConfig`, `DeployResult`, `DeployPlan`
  - Deploy section in `cogitator.yml` schema with target, port, region, instances, registry, services, secrets
  - CLI `deploy` command with `--target`, `--dry-run`, `--push`, `status`, and `destroy` subcommands

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/config@0.4.0
  - @cogitator-ai/deploy@0.1.1

## 0.2.25

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/config@0.3.13

## 0.2.24

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/config@0.3.12

## 0.2.23

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2

## 0.2.22

### Patch Changes

- @cogitator-ai/config@0.3.11
- @cogitator-ai/core@0.17.1

## 0.2.21

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/config@0.3.10

## 0.2.20

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/config@0.3.9

## 0.2.19

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/config@0.3.8

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/config@0.3.7

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/config@0.3.6

## 0.2.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/config@0.3.5

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/config@0.3.4
  - @cogitator-ai/core@0.11.5

## 0.2.14

### Patch Changes

- @cogitator-ai/config@0.3.3
- @cogitator-ai/core@0.11.4

## 0.2.13

### Patch Changes

- @cogitator-ai/config@0.3.2
- @cogitator-ai/core@0.11.3

## 0.2.12

### Patch Changes

- @cogitator-ai/config@0.3.1
- @cogitator-ai/core@0.11.2

## 0.2.11

### Patch Changes

- @cogitator-ai/core@0.11.1

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0
  - @cogitator-ai/config@0.3.0

## 0.2.9

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/config@0.2.8

## 0.2.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.9.0
  - @cogitator-ai/config@0.2.7

## 0.2.7

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/config@0.2.6

## 0.2.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/config@0.2.5

## 0.2.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/config@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/config@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/config@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.3.0
  - @cogitator-ai/config@0.2.1

## 0.2.0

### Features

- **New command: `cogitator status`** - Show status of Docker services and Ollama
- **New command: `cogitator logs`** - View Docker service logs with follow mode
- **New command: `cogitator models`** - List and pull Ollama models
- **Environment variables**: `COGITATOR_MODEL` and `COGITATOR_CONFIG` support
- **Interactive mode improvements**:
  - `/model <name>` - Switch models mid-conversation
  - `/clear` - Reset conversation history
  - `/help` - Show available commands
  - Message counter in prompt

### Fixes

- Version now reads from package.json instead of hardcoded value
- Config loading errors are now logged as warnings instead of silently ignored

## 0.1.1

### Patch Changes

- @cogitator-ai/config@0.1.1
- @cogitator-ai/core@0.1.1

## 0.1.0

### Initial Release

- `cogitator init <name>` - Create new project with Docker setup
- `cogitator up` - Start Docker services (Redis, PostgreSQL, Ollama)
- `cogitator down` - Stop Docker services
- `cogitator run [message]` - Run agent with streaming support
