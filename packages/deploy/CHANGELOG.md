# @cogitator-ai/deploy

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
