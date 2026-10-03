# @cogitator-ai/tetsu

## 0.1.1

### Patch Changes

- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/memory@0.8.1

## 0.1.0

### Minor Changes

- 6fca176: New package: the Cogitator HTTP API as a [Tetsu](https://tetsujs.com) controller for Bun. `cogitatorController()` serves agents, memory threads, workflows and swarms with Zod-validated requests and responses, SSE streams through `@tetsujs/sse`, an optional WebSocket endpoint, errors in Tetsu's `{ status, message, error }` envelope with `CogitatorError` codes mapped to their HTTP status, an `auth` hook that can be documented with `secured()` from `@tetsujs/openapi`, per-user thread access through `authorizeThread`, and `until` to end streams and sockets when the server drains.

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1
