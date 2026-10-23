# @cogitator-ai/tetsu

## 0.8.9

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b), [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/memory@0.26.0
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/server-shared@0.9.8

## 0.8.8

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/memory@0.25.6
  - @cogitator-ai/server-shared@0.9.7

## 0.8.7

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - @cogitator-ai/memory@0.25.5
  - @cogitator-ai/server-shared@0.9.6

## 0.8.6

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/memory@0.25.4
  - @cogitator-ai/server-shared@0.9.5

## 0.8.5

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/memory@0.25.3
  - @cogitator-ai/server-shared@0.9.4

## 0.8.4

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/memory@0.25.2
  - @cogitator-ai/server-shared@0.9.3

## 0.8.3

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/memory@0.25.1
  - @cogitator-ai/server-shared@0.9.2

## 0.8.2

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/memory@0.25.0
  - @cogitator-ai/server-shared@0.9.1

## 0.8.1

No changes in this release.

## 0.8.0

### Minor Changes

- [#259](https://github.com/cogitator-ai/Cogitator-AI/pull/259) [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357) - Workflow checkpoints and resume over HTTP in every REST adapter

  With the new `workflowCheckpoints` option (a `CheckpointStore`), a workflow run accepts `options.checkpoint: true` and saves checkpoints there. A finished run answers with its `checkpointId`, and a failed one carries it in the error answer, next to `code` and `message`, and in a `workflow_failed` event before the stream's `error` event. `POST /workflows/:name/resume` and `/workflows/:name/resume/stream` take `{ checkpointId, options? }` and run the remaining nodes, with the server's limits, the caller's auth and the same answers as `/run` and `/stream`. A resumed run saves checkpoints too, so it can be resumed again.

  A checkpoint belongs to the user who ran the workflow: `WorkflowCheckpoint` gets an `owner`, set through `ownedCheckpoints(store, owner)` from server-shared. Another user's checkpoint, one of another workflow, an unknown id and a server without a store all answer `404 CHECKPOINT_NOT_FOUND`, a new error code, before anything runs. Without `workflowCheckpoints`, `options.checkpoint: true` is still refused. OpenAPI documents the resume routes, `WorkflowResumeRequest` and `checkpointId`, and the conformance cases cover the refusals.

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/server-shared@0.9.0
  - @cogitator-ai/memory@0.24.5

## 0.7.1

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/memory@0.24.4
  - @cogitator-ai/server-shared@0.8.1

## 0.7.0

### Minor Changes

- [#255](https://github.com/cogitator-ai/Cogitator-AI/pull/255) [`008ad3e`](https://github.com/cogitator-ai/Cogitator-AI/commit/008ad3e4a8a0227138594c225b795731576cda24) - Tetsu's WebSocket runs several agents, workflows and swarms per socket and keeps every frame under backpressure

  A socket now runs side by side the runs its frames start with different `id`s, up to `websocket.maxRuns` (8 by default, one more gets `TOO_MANY_RUNS`). A run with the `id` of one still going, or a second one without an `id`, still gets `RUN_IN_PROGRESS`. `stop` with an `id` cancels that run, `stop` without one cancels every run of the socket, as it cancelled the only one before. A `stop` whose `id` matches no run now does nothing, where it used to cancel the only run, so a client that stops by `id` must send the `id` of the run. A duplicate `id` gets the message `A run with id '<id>' is already in progress`, and `code` stays `RUN_IN_PROGRESS`.

  The runs of a socket share the `deps` built at the handshake and now run at the same time, also two runs on the same thread, so `deps` holding a connection or transaction must be safe for concurrent use. `maxRuns` and `maxBufferedBytes` hold per socket: cap sockets or runs per user in `auth` or a rate limiter.

  A stop answers `cancelled` at once, also for a workflow whose node is still running, and the run sends nothing after it. Its `id` is free for a new run at once, and it keeps its place among the `maxRuns` until it actually ends.

  Frames are no longer lost in silence under backpressure. Once Bun reports it, the frames after it wait in order and go out as the socket drains. When more than `websocket.maxBufferedBytes` wait (4 MiB by default), or Bun drops a frame, the socket is closed with `1008`, which cancels its runs. Both options must be positive integers, or building the controller throws.

## 0.6.1

### Patch Changes

- Updated dependencies [[`8b0fd20`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b0fd2045686cba1675b97163ee7fbea88a723f3)]:
  - @cogitator-ai/server-shared@0.8.0

## 0.6.0

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

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/server-shared@0.7.0
  - @cogitator-ai/memory@0.24.3
  - @cogitator-ai/core@0.56.4

## 0.5.26

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/memory@0.24.2
  - @cogitator-ai/server-shared@0.6.6

## 0.5.25

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/memory@0.24.1
  - @cogitator-ai/server-shared@0.6.5

## 0.5.24

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/memory@0.24.0
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/server-shared@0.6.4

## 0.5.23

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/memory@0.23.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/server-shared@0.6.3

## 0.5.22

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/memory@0.22.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/server-shared@0.6.2

## 0.5.21

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/memory@0.21.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/server-shared@0.6.1

## 0.5.20

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/memory@0.20.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/server-shared@0.6.0

## 0.5.19

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/memory@0.19.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/server-shared@0.5.19

## 0.5.18

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/memory@0.18.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/server-shared@0.5.18

## 0.5.17

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/memory@0.17.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/server-shared@0.5.17

## 0.5.16

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/memory@0.16.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/server-shared@0.5.16

## 0.5.15

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/memory@0.15.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/server-shared@0.5.15

## 0.5.14

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/memory@0.14.0
  - @cogitator-ai/core@0.47.0
  - @cogitator-ai/server-shared@0.5.14

## 0.5.13

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/memory@0.13.3
  - @cogitator-ai/server-shared@0.5.13

## 0.5.12

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/memory@0.13.2
  - @cogitator-ai/server-shared@0.5.12

## 0.5.11

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/memory@0.13.1
  - @cogitator-ai/server-shared@0.5.11

## 0.5.10

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/memory@0.13.0
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/server-shared@0.5.10

## 0.5.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/memory@0.12.9
  - @cogitator-ai/server-shared@0.5.9

## 0.5.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/memory@0.12.8
  - @cogitator-ai/server-shared@0.5.8

## 0.5.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/memory@0.12.7
  - @cogitator-ai/server-shared@0.5.7

## 0.5.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/memory@0.12.6
  - @cogitator-ai/server-shared@0.5.6
  - @cogitator-ai/types@0.41.1

## 0.5.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/memory@0.12.5
  - @cogitator-ai/server-shared@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/memory@0.12.4
  - @cogitator-ai/server-shared@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/memory@0.12.3
  - @cogitator-ai/server-shared@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/memory@0.12.2
  - @cogitator-ai/server-shared@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/memory@0.12.1
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/server-shared@0.5.1

## 0.5.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The controller speaks the shared server protocol. `acceptContext` and `threadMessageRoles` refuse `context` keys and `system` thread messages from clients unless allowed, with `422 VALIDATION_FAILED`, and a body that is not JSON answers `415` before it is read. The schemas refuse a blank `threadId` and a swarm `timeout` above `2147483647` ms, and `options.checkpoint: true` on workflows. An `auth` function that throws or rejects answers `401` instead of `500`. Agent streams name the run's thread in `start` and `finish`, close the text part before a tool call, and send an answer given in one piece. The JSON answer carries `structuredError`, `truncated`, `blocked`, `iterationLimitReached` and `traceId` like every other adapter. Swarm routes close the swarm they build, `GET /swarms` lists a router and pipeline stages, and the OpenAPI document declares the `200` of the stream routes. The README and docs now list the in-stream `THREAD_ACCESS_DENIED`, the swarm's own stream events and the `400 MALFORMED_JSON`, `413 BODY_TOO_LARGE` and `415` answers.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/memory@0.12.0
  - @cogitator-ai/server-shared@0.5.0

## 0.4.11

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/memory@0.11.8

## 0.4.10

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0
  - @cogitator-ai/memory@0.11.7

## 0.4.9

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/memory@0.11.6

## 0.4.8

No changes in this release.

## 0.4.7

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4

## 0.4.6

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3

## 0.4.5

### Patch Changes

- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/memory@0.11.5
  - @cogitator-ai/types@0.33.1

## 0.4.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1
  - @cogitator-ai/memory@0.11.4

## 0.4.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/memory@0.11.3

## 0.4.2

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/server-shared@0.4.1
  - @cogitator-ai/memory@0.11.2
  - @cogitator-ai/types@0.31.0

## 0.4.0

### Minor Changes

- [`1c16684`](https://github.com/cogitator-ai/Cogitator-AI/commit/1c16684976705ab5c34778728f27f7efd247242f) - An `input` of only whitespace is now refused with `422 VALIDATION_FAILED` on run, stream and swarm routes and over the WebSocket. It used to reach the model, which answered and was billed.

  Long runs on Bun are no longer cut off. `Bun.serve` closes a connection silent for 10 seconds, but streams sent their keep-alive comment only every 15, so a stream waiting on a slow tool ended with "terminated (other side closed)", and a JSON run did too. Streams now write a heartbeat every 5 seconds (new `sseHeartbeatMs` option, `0` turns it off), and the JSON run routes lift Bun's idle timeout for their own request once the body is validated.

### Patch Changes

- [`9d40b76`](https://github.com/cogitator-ai/Cogitator-AI/commit/9d40b763f9fb25f9cb7cb2aba8a52ff2989fc5e9) - The `finish` event of `/agents/:name/stream` and `/agents/:name/resume/stream` now carries the same `usage` as the JSON run response: `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` are included when the model reported them. Before, the stream sent only the input, output and total tokens, so a streaming client lost the reasoning and cache counts. The OpenAPI description of both routes says so.
- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7), [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6), [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2), [`9d40b76`](https://github.com/cogitator-ai/Cogitator-AI/commit/9d40b763f9fb25f9cb7cb2aba8a52ff2989fc5e9), [`1c16684`](https://github.com/cogitator-ai/Cogitator-AI/commit/1c16684976705ab5c34778728f27f7efd247242f)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/memory@0.11.1
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/server-shared@0.4.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2

## 0.3.3

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1

## 0.3.2

### Patch Changes

- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [a3c2ee1]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [e7925d5]
- Updated dependencies [b8c9eca]
- Updated dependencies [bb17767]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [e7925d5]
- Updated dependencies [d35ef2a]
- Updated dependencies [4a2925f]
- Updated dependencies [db2e373]
- Updated dependencies [65d0cc0]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/memory@0.11.0
  - @cogitator-ai/server-shared@0.3.1

## 0.3.1

### Patch Changes

- e211b6a: `cog.getMemory()` connects the configured memory adapter on first use, so threads can be read before any agent has run; `cog.memory` stays `undefined` until then. The `/threads` routes of every server adapter use it, so they no longer answer `503 Memory not configured` on a fresh server.
- 3e756f3: Errors that are not a `CogitatorError` no longer reach the client with their text, which can carry internals such as connection strings or file paths. They are logged on the server and answered as `Internal server error` everywhere: the Next.js agent, chat and resume handlers (now with `code: 'INTERNAL_ERROR'`), WebSocket run errors in Express and Fastify, `Workflow failed: …` responses, and the `node_error` / `agent_error` stream events of workflows and swarms in every adapter. A `CogitatorError` keeps its message and code.
- Updated dependencies [e211b6a]
- Updated dependencies [333e4ad]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/memory@0.10.0
  - @cogitator-ai/types@0.28.0

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

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/server-shared@0.3.0
  - @cogitator-ai/memory@0.9.1

## 0.2.0

### Minor Changes

- ed996c4: One agent can serve many users without them seeing each other's conversations or memory.

  - **Threads have owners.** The run that creates a thread records its `userId` (`thread.metadata.userId`). A run that passes a `threadId` continues it only for its owner and otherwise fails with the new `THREAD_ACCESS_DENIED` (403) before any history is loaded; a thread that cannot be read fails with `MEMORY_READ_FAILED` instead of being recreated without its owner. `RunOptions.threadAccess: 'shared'` opts out for threads your server derives itself (channels uses it, so group chats keep working). `assertThreadAccess`, `ensureThreadAccess`, `threadOwner` and `threadMetadata` are exported for your own endpoints.
  - **Memory is scoped by user.** `ContextBuilder.build({ userId })` leaves out facts, embeddings and knowledge graph nodes whose `metadata.userId` belongs to someone else; memory without an owner stays shared. The vector search filters in the adapter (`filter.userId` on the in-memory, Postgres and Qdrant adapters), so other users' memories cannot crowd out the user's own. Agent runs build the context for their `userId`, and the runtime now hands the context builder the memory adapter's facts and embeddings and the `memory.embedding` service, so `includeFacts`, `includeSemanticContext` and the `relevant`/`hybrid` strategies work in runs.
  - **Swarms and worker jobs** carry `userId` (`SwarmRunOptions.userId`, `addAgentJob(..., { userId })`) to every agent run.
  - **Server adapters** scope `/threads/:id` (read, append, clear) to the authenticated user and pass it to agent, stream, WebSocket and swarm runs. hono and koa now pass `auth`'s `userId` to runs at all (HTTP and WebSocket); next answers a run's `CogitatorError` with its status and `code` instead of 500, and chat streams cancel the run on client disconnect even after the Request object is no longer referenced. The shared OpenAPI spec lists the 403 of `/threads/:id` and agent runs.

  **Behaviour change:** threads created before, or by runs without a `userId`, have no owner and are open only to callers without one. Hand such a thread to a user by setting `metadata.userId` with `updateThread`.

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0
  - @cogitator-ai/memory@0.9.0
  - @cogitator-ai/server-shared@0.2.1

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
