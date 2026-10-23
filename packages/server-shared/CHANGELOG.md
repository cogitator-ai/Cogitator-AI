# @cogitator-ai/server-shared

## 0.9.8

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/types@0.71.0

## 0.9.7

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0

## 0.9.6

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0

## 0.9.5

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0

## 0.9.4

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0

## 0.9.3

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0

## 0.9.2

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/types@0.64.0

## 0.9.0

### Minor Changes

- [#259](https://github.com/cogitator-ai/Cogitator-AI/pull/259) [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357) - Workflow checkpoints and resume over HTTP in every REST adapter

  With the new `workflowCheckpoints` option (a `CheckpointStore`), a workflow run accepts `options.checkpoint: true` and saves checkpoints there. A finished run answers with its `checkpointId`, and a failed one carries it in the error answer, next to `code` and `message`, and in a `workflow_failed` event before the stream's `error` event. `POST /workflows/:name/resume` and `/workflows/:name/resume/stream` take `{ checkpointId, options? }` and run the remaining nodes, with the server's limits, the caller's auth and the same answers as `/run` and `/stream`. A resumed run saves checkpoints too, so it can be resumed again.

  A checkpoint belongs to the user who ran the workflow: `WorkflowCheckpoint` gets an `owner`, set through `ownedCheckpoints(store, owner)` from server-shared. Another user's checkpoint, one of another workflow, an unknown id and a server without a store all answer `404 CHECKPOINT_NOT_FOUND`, a new error code, before anything runs. Without `workflowCheckpoints`, `options.checkpoint: true` is still refused. OpenAPI documents the resume routes, `WorkflowResumeRequest` and `checkpointId`, and the conformance cases cover the refusals.

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/types@0.63.0

## 0.8.1

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0

## 0.8.0

### Minor Changes

- [#253](https://github.com/cogitator-ai/Cogitator-AI/pull/253) [`8b0fd20`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b0fd2045686cba1675b97163ee7fbea88a723f3) - Stream protocol events as Zod schemas and OpenAPI components, and `/agents/:name/resume/stream` in every REST adapter

  `@cogitator-ai/server-shared` exports a Zod schema for every stream event (`StreamEventSchema`, a discriminated union on `type`, and `StartEventSchema` through `SwarmEventSchema`, `RunUsageSchema`, `PendingApprovalSchema`), so a client can check what a server sends. The schemas have the shapes of the `StreamEvent` types, an unknown event type fails to parse and a field a newer server adds is dropped. `streamEventComponents()` turns them into OpenAPI 3.0 components, and `generateOpenAPISpec` now documents every SSE route as `text/event-stream` with the `StreamEvent` schema, a `oneOf` with a discriminator on `type`. The `RunUsage`, `PendingApproval`, `StreamStartEvent` and `StreamFinishEvent` components keep their names. `documentStreamEvents(document)` adds the same to a document another generator built: Fastify's Swagger document uses it, and a Tetsu document built with `openapi()` can go through it too. `truncated` and `iterationLimitReached` of `AgentRunResponse` and `StreamFinishEvent` are now documented as `true` when present, which is all a server ever sends. `ToolResultEvent.result`, `WorkflowEvent.data` and `SwarmEvent.data` are optional, as on the wire, where a tool that returned nothing sends no `result`.

  Express, Fastify, Hono and Koa serve `POST /agents/:name/resume/stream`, which Tetsu already had: it takes the body of `/resume`, refuses the same requests before the stream opens, and streams the rest of the run like `/stream`. A thread with no paused run ends the stream with an `error` event, `RUN_NOT_PAUSED`.

  The conformance cases now cover `/resume/stream`, and check every event of a stream against `StreamEventSchema`, so an adapter of your own that runs them needs the route.

## 0.7.0

### Minor Changes

- [#251](https://github.com/cogitator-ai/Cogitator-AI/pull/251) [`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc) - Every server adapter keeps one contract: operator run limits, thread authorization, an anonymous policy, one error taxonomy with Retry-After, thread pages and request deps

  `limits: { swarmTimeout, workflowMaxIterations, workflowMaxConcurrency }` on Express, Fastify, Hono, Koa and Tetsu caps what a request may ask a run for. A request gets the smaller of what it asked and the cap, one that asks for nothing gets the cap, over HTTP, streams and WebSocket alike, and the OpenAPI document shows each cap as the default of the field it caps. Next serves no swarms or workflows, so it has no limits.

  `authorizeThread(auth, threadId)` is asked about every thread a request names (agent runs, streams and resumes, swarm runs, the thread routes, WebSocket runs, and the run events a WebSocket subscription receives) on top of the ownership check, and a refusal answers `403 THREAD_FORBIDDEN` before any run starts. On Next it is `authorizeThread(req, threadId)`, asked about the thread the run goes to. `anonymous: 'deny'` answers `401 UNAUTHORIZED` to a caller without a user id, also on paths the server does not know (Tetsu leaves unknown paths and methods to its app, which answers them before any hook), while health, readiness and the docs stay open. Under `'allow'` an unknown path answers `404 NOT_FOUND` in the envelope, and on Koa a wrong method on a known path now answers that `404` too instead of `405`, while `OPTIONS` on a path the router serves answers `204` with the methods it serves in `Allow`, so the router needs no `allowedMethods()`. The default `'allow'` keeps today's behaviour, and on Next the caller is the `userId` that `beforeRun` returns. On Koa the WebSocket server takes the router's `anonymous` unless its own options set one. Tetsu keeps answering `401` when `authenticate` returns `undefined`, as before.

  Errors follow one taxonomy from `@cogitator-ai/server-shared` (`describeHttpError`): a `CogitatorError` answers with its own status or the one of its code, a swarm that ran out of time with `504 RUN_TIMEOUT`, and any other error with `500 INTERNAL_ERROR` without its text, in JSON, stream events and WebSocket frames alike. Answers carry `Retry-After` in whole seconds, at most a day, when the provider said when to retry. Express, Fastify, Hono, Koa and Next answer in the `{ error: { message, code } }` envelope, and Tetsu in its framework's `{ status, message, error }` with the same statuses and codes. Express and Fastify now honour `CogitatorError.statusCode`, and a failed workflow answers with the status of the error that failed it.

  Breaking for `@cogitator-ai/next`: error answers move from the flat `{ error, code }` to the `{ error: { message, code } }` envelope of the other adapters. `useCogitatorChat` and `useCogitatorAgent` read both shapes, so update a client of your own that reads `error` as a string. A `beforeRun` error reaches the client with its message and `code` only when it sets a client error `status` (`400` to `499`) or is a `CogitatorError`, and any other hook error answers `401 Unauthorized` without its text.

  Breaking for `@cogitator-ai/tetsu` streams: an unexpected error in an SSE stream or WebSocket frame now carries `INTERNAL_ERROR`, as on every other adapter, instead of `INTERNAL_SERVER_ERROR`.

  `GET /threads/:id` takes `limit` (1 to 1000) and `cursor`: it answers the newest `limit` messages of what is left and a `nextCursor` for the page before them, until a page reaches the start of the thread. Entries that share one time are counted, so none is skipped or repeated across pages. Without `limit` it answers the whole thread as before, and `updatedAt` is the time of its newest entry when that is later than the thread record. A bad `limit` or `cursor` answers `400 INVALID_INPUT`, or `422 VALIDATION_FAILED` on Tetsu. Next serves no thread routes.

  `deps: (request) => deps` gives agent runs, streams and resumes their `deps` (`context.deps` of their tools) for the request, never read from the body. Over WebSocket, Fastify and Hono build them for every run from the upgrade request, Express and Koa from their own `websocket.deps(req)` hook that takes the raw upgrade request, and Tetsu once per connection at the handshake. On Next a `deps` that `beforeRun` returns wins over the hook.

  `@cogitator-ai/server-shared` exports `RunLimits`, `checkRunLimits`, `swarmTimeoutWithin`, `workflowOptionsWithin`, `AuthorizeThread`, `AnonymousPolicy`, `admitCaller`, `authorizeThreadAccess`, `threadForbidden`, `UNAUTHORIZED`, `describeHttpError`, `cogitatorErrorStatus`, `INTERNAL_ERROR`, `errorEnvelope`, `errorHeaders`, `retryAfterSeconds`, the types `ErrorEnvelope` and `HttpErrorDescription`, `parseThreadPageQuery`, `readThreadPage`, `MAX_THREAD_PAGE_LIMIT`, the types `ThreadPage` and `ThreadPageQuery`, and `SwaggerConfig.limits`. Its conformance cases now cover Retry-After, hidden internal errors, anonymous callers, `THREAD_FORBIDDEN` on runs, streams, resumes and the thread routes, thread pages and deps. `ConformanceRuntime` takes the case so it can fail runs and hold thread entries, and `ConformanceResponse` carries headers. The adapters export their guards (`createAnonymousGuard` on Express, `createAnonymousMiddleware` on Hono and Koa) and Fastify its request schema factories (`workflowRunRequestSchema`, `swarmRunRequestSchema`, `ThreadPageQuerySchema`, `ThreadResponseSchema`), and Tetsu `ThreadQuery` and `DepsBuilder`.

  `@cogitator-ai/memory`: the Redis adapter reads `getEntries` with `before` and `limit` backwards a page at a time from `before`, so reading a long thread one page after another no longer reads everything before each page. Entries of one time written before entries had a `seq` now keep one order (by id) in the Redis and Postgres adapters, whichever way they are read, the order their tree migration already chains them in. MongoDB and SQLite keep the order they were added in. `@cogitator-ai/test-utils` adds the `entry-limit-before` case to the memory adapter conformance cases.

## 0.6.6

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0

## 0.6.5

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0

## 0.6.4

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0

## 0.6.3

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0

## 0.6.2

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0

## 0.6.0

### Minor Changes

- [#227](https://github.com/cogitator-ai/Cogitator-AI/pull/227) [`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Readiness checks and memory adapter health check contract ([#103](https://github.com/cogitator-ai/Cogitator-AI/issues/103)).

  - Add optional `healthCheck(): Promise<MemoryResult<void>>` to `MemoryAdapter` in `@cogitator-ai/types` and implement it for all five built-in memory adapters (in-memory, redis, postgres, sqlite, mongodb) using lightweight, non-mutating checks.
  - Add shared readiness check logic in `@cogitator-ai/server-shared` with a 3-second timeout per check. Adapters without `healthCheck()` report `unchecked` and fail open, and unconfigured memory does not fail readiness.
  - Update Express, Fastify, Hono, and Koa server adapters to check readiness against memory, returning HTTP 200 when ready and HTTP 503 on failure without exposing internal driver or network details.
  - Add `health-check` scenario to memory adapter conformance suite in `@cogitator-ai/test-utils`.
  - Update OpenAPI specification for `/ready` endpoint with `ReadinessResponse` schema.

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0

## 0.5.19

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0

## 0.5.18

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0

## 0.5.17

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0

## 0.5.16

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0

## 0.5.15

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0

## 0.5.14

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0

## 0.5.13

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/types@0.48.0

## 0.5.12

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/types@0.47.0

## 0.5.11

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/types@0.46.0

## 0.5.10

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/types@0.45.0

## 0.5.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0

## 0.5.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/types@0.43.0

## 0.5.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0

## 0.5.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/types@0.41.1

## 0.5.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0

## 0.5.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/types@0.40.0

## 0.5.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/types@0.39.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0

## 0.5.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The package becomes the one source of the server protocol. `toAgentRunResponse()` builds the answer of an agent run for every adapter: output, thread, usage, tool calls (`{ id, name, arguments }`), `status` and `traceId`, plus `reasoning`, `pendingApprovals`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached` when they apply, never the system prompt, the history, trace spans or a paused run's checkpoint. `AgentStreamSession` builds the events of a streamed run: `start` and `finish` name the run's thread (a new one when the request sent none), parts close before a tool call, an answer given in one piece is sent as text, and `finish` carries the run's outcome. `parseRunRequest()` takes an `acceptContext` policy that refuses `context` keys clients may not set (none by default), `parseAddMessageRequest()` refuses roles the server does not accept (`system` by default), and `parseResumeRequest()` and `parseWorkflowRunRequest()` (which refuses `checkpoint: true`) join them. `refuseNonJsonBody()`, `parseJsonBody()` and `readJsonRequestBody()` refuse bodies that are not JSON with `415`, `withSwarm()` closes a swarm once its run ends, `swarmAgentNames()` lists every agent of a swarm, router and pipeline stages included, and `CONFORMANCE_CASES` with `ConformanceRuntime` and `checkConformance()` let an adapter's tests check it answers like every other.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0

## 0.4.1

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.

## 0.4.0

### Minor Changes

- [`9d40b76`](https://github.com/cogitator-ai/Cogitator-AI/commit/9d40b763f9fb25f9cb7cb2aba8a52ff2989fc5e9) - The `finish` event of a stream now carries the same usage as the JSON run response. The protocol's `Usage` type gains the optional `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` (`RunUsage` is now the same type), and `createFinishEvent` passes its usage through `toRunUsage`, so a run's `RunResult.usage` can be given as is: the event keeps the counts the model reported and leaves out the run's cost and duration, exactly like the JSON answer. Before, a client streaming a run lost the reasoning and cache token counts that `/run` returned. The OpenAPI document gains a shared `RunUsage` schema, used by `AgentRunResponse` and by the new `StreamFinishEvent`.

- [`1c16684`](https://github.com/cogitator-ai/Cogitator-AI/commit/1c16684976705ab5c34778728f27f7efd247242f) - One run contract for every server adapter. `parseRunRequest` and `parseSwarmRunRequest` validate the body of agent and swarm runs (an `input` of only whitespace is refused, so a request that says nothing never reaches the model), `RUN_INPUT_SCHEMA` and `NON_BLANK_PATTERN` give schema-driven adapters the same rule, and `isNonBlankString` checks a single value. `toRunUsage` and the `RunUsage` type describe the usage of a run answer, now with the optional `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens`. `DEFAULT_SSE_HEARTBEAT_MS`, `encodeHeartbeat`, `resolveSseHeartbeatMs` and `startHeartbeat` let SSE streams write a comment every 5 seconds while a run is silent. The OpenAPI document now states that `input` must contain more than whitespace and lists the three optional usage counts.

## 0.3.1

### Patch Changes

- 65d0cc0: Swagger UI calls the right URLs and offers a bearer token when the server checks credentials. The spec's `servers` now defaults to where the routes are mounted (Express `basePath`, the Hono/Koa mount prefix), and with `auth` configured the spec declares `bearerAuth` as an optional requirement (`swagger.auth` overrides it). The Swagger page escapes the title and the embedded spec, so agent names and descriptions can't inject markup.

## 0.3.0

### Minor Changes

- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

- 7bee3ef: Runs pause for a person to approve sensitive tool calls and continue later.

  - A tool with `requiresApproval` never runs without a decision. `RunOptions.onApproval` (or `guardrails.onToolApproval`) decides inline; otherwise the run pauses before executing the turn and returns `status: 'paused'`, `pendingApprovals` and a JSON `checkpoint`. `cogitator.resume(agent, threadId | checkpoint, { decisions, defaultDecision, userId })` executes the approved calls, answers declined ones with the reason, and goes on. A new message on the thread instead declines the waiting calls.
  - Paused runs are kept per thread in the memory adapter's thread metadata (`ThreadRunCheckpointStore`), in process memory without memory (`InMemoryRunCheckpointStore`), or in `runCheckpoints`. Resuming by thread checks the caller (`THREAD_ACCESS_DENIED`); a thread with nothing paused answers the new `RUN_NOT_PAUSED` (409).
  - `agentAsTool` passes the caller's `userId` to the delegated run and declines its approvals unless given `onApproval`, instead of reporting a paused sub-run as success.
  - Server adapters answer paused runs with `status` / `pendingApprovals` (never the checkpoint), stream `approval-required`, and take `POST /agents/:name/resume` (plus a WebSocket `resume` message); Next.js has `createResumeHandler` and `pendingApprovals` / `approve()` / `deny()` in its hooks; channels ask in the chat and resume on "approve" / "deny <reason>" (also "да" / "нет").

  **Behaviour change:** `requiresApproval` used to be enforced only with constitutional guardrails and an `onToolApproval` callback; without them such tools ran unasked. They now pause the run. WebSocket `complete` events no longer include a paused run's checkpoint.

## 0.2.1

### Patch Changes

- ed996c4: One agent can serve many users without them seeing each other's conversations or memory.

  - **Threads have owners.** The run that creates a thread records its `userId` (`thread.metadata.userId`). A run that passes a `threadId` continues it only for its owner and otherwise fails with the new `THREAD_ACCESS_DENIED` (403) before any history is loaded; a thread that cannot be read fails with `MEMORY_READ_FAILED` instead of being recreated without its owner. `RunOptions.threadAccess: 'shared'` opts out for threads your server derives itself (channels uses it, so group chats keep working). `assertThreadAccess`, `ensureThreadAccess`, `threadOwner` and `threadMetadata` are exported for your own endpoints.
  - **Memory is scoped by user.** `ContextBuilder.build({ userId })` leaves out facts, embeddings and knowledge graph nodes whose `metadata.userId` belongs to someone else; memory without an owner stays shared. The vector search filters in the adapter (`filter.userId` on the in-memory, Postgres and Qdrant adapters), so other users' memories cannot crowd out the user's own. Agent runs build the context for their `userId`, and the runtime now hands the context builder the memory adapter's facts and embeddings and the `memory.embedding` service, so `includeFacts`, `includeSemanticContext` and the `relevant`/`hybrid` strategies work in runs.
  - **Swarms and worker jobs** carry `userId` (`SwarmRunOptions.userId`, `addAgentJob(..., { userId })`) to every agent run.
  - **Server adapters** scope `/threads/:id` (read, append, clear) to the authenticated user and pass it to agent, stream, WebSocket and swarm runs. hono and koa now pass `auth`'s `userId` to runs at all (HTTP and WebSocket); next answers a run's `CogitatorError` with its status and `code` instead of 500, and chat streams cancel the run on client disconnect even after the Request object is no longer referenced. The shared OpenAPI spec lists the 403 of `/threads/:id` and agent runs.

  **Behaviour change:** threads created before, or by runs without a `userId`, have no owner and are open only to callers without one. Hand such a thread to a user by setting `metadata.userId` with `updateThread`.

## 0.2.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).
