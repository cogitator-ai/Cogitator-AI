# @cogitator-ai/openai-compat

## 21.3.13

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/server-shared@0.7.0
  - @cogitator-ai/core@0.56.4

## 21.3.12

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/server-shared@0.6.6

## 21.3.11

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/server-shared@0.6.5

## 21.3.10

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/server-shared@0.6.4

## 21.3.9

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/server-shared@0.6.3

## 21.3.8

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/server-shared@0.6.2

## 21.3.7

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/server-shared@0.6.1

## 21.3.6

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/server-shared@0.6.0

## 21.3.5

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/server-shared@0.5.19

## 21.3.4

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/server-shared@0.5.18

## 21.3.3

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/server-shared@0.5.17

## 21.3.2

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/server-shared@0.5.16

## 21.3.1

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/server-shared@0.5.15

## 21.3.0

### Minor Changes

- [#223](https://github.com/cogitator-ai/Cogitator-AI/pull/223) [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913) - Run steps and threads scoped to the API key.

  - Runs record their steps as the Assistants API does: a `tool_calls` step per model turn that called tools, with each call's output once known, and a `message_creation` step for the message the run wrote, with usage and the run's error when it stops early. `GET /v1/threads/:thread_id/runs/:run_id/steps` lists them (with `limit`, `order`, `after`, `before`) and `GET .../steps/:step_id` reads one. Streaming runs emit `thread.run.step.created`, `in_progress`, `delta` and `completed` in the order the OpenAI SDK expects.
  - When the server checks API keys, threads and runs belong to the key that created them, kept as a digest, never the key itself. Another key gets `404` for them, their messages, runs and steps. Threads created before this change stay reachable by every key. Assistants, files and responses stay shared.
  - `ThreadStorage.listThreads(options)` returns a page (`{ threads, nextCursor? }`) filtered by owner and ordered by creation time, instead of every thread: storage implementations of your own need to follow. Postgres pages in SQL with a new index, Redis reads every thread key per page.
  - A message a run had begun to stream is kept as `incomplete` when the run is cancelled, expires or fails.
  - A turn that writes text and calls tools becomes its own message, with the text every middleware left, with or without `stream: true`.
  - `thread.message.completed` goes out once the message is stored, and the events after it wait for it. A run reaches `requires_action` only once the messages before the pause are stored. A store that fails, or a thread deleted while the run writes to it, fails the run, and the message ends as `incomplete` with a `failed` step instead.
  - A listener of run events that throws is logged and no longer stops the run.

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/core@0.47.0
  - @cogitator-ai/server-shared@0.5.14

## 21.2.13

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/server-shared@0.5.13

## 21.2.12

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/server-shared@0.5.12

## 21.2.11

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/server-shared@0.5.11

## 21.2.10

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/server-shared@0.5.10

## 21.2.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/server-shared@0.5.9

## 21.2.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/server-shared@0.5.8

## 21.2.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/server-shared@0.5.7

## 21.2.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - `OpenAIAdapter.createThread`, `getThread` and `updateThread` are typed as returning `Thread` for TypeScript projects on `moduleResolution: node16` or `nodenext`. Their declarations pointed at a module path those settings cannot resolve, so the methods came out as `any` there.

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/server-shared@0.5.6
  - @cogitator-ai/types@0.41.1

## 21.2.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/server-shared@0.5.5

## 21.2.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/server-shared@0.5.4

## 21.2.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/server-shared@0.5.3

## 21.2.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/server-shared@0.5.2

## 21.2.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/server-shared@0.5.1

## 21.2.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The server now speaks the OpenAI APIs current clients use: `POST /v1/chat/completions` and `POST /v1/responses`, streaming and not, with the agent as the `model`. Register agents with the new `agents` option and every OpenAI client (the official SDKs, Open WebUI, LibreChat) talks to them:

  - Each request runs the agent with its own instructions, model and tools, the client's system prompt after its instructions, and the request's sampling settings, token limit, stop sequences and response format.
  - Functions the client declares come back as tool calls (`finish_reason: 'tool_calls'`, `function_call` items), and the outputs the client sends resume the same run.
  - Usage includes cached and reasoning tokens, `finish_reason` and the Responses `incomplete_details` report truncated and filtered answers, and errors use the OpenAI error format (`model_not_found` for an unknown agent).
  - Responses streams send the Responses events, responses are kept for `previous_response_id`, `GET /v1/responses/{id}`, its `input_items` and `DELETE`.
  - `GET /v1/models` lists the agents, and `GET /v1/models/{id}` returns one. A client that disconnects aborts the run.

  New options: `agents`, `maxRequestBodyBytes` (default 20 MB) and `maxStoredResponses` (default 1000). The Assistants API endpoints keep working but are deprecated, since OpenAI sunset that API on 2026-08-26.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Runs no longer complete when a server tool waits for approval, and no longer time out while the client works on `requires_action`.

  - A server tool that needs approval puts the run in `requires_action` with the call, instead of completing it with the model's text from before the call and `required_action: null`. The submitted output decides it: `{"approved": true}` or `approve` runs the tool, anything else declines it (with the output or `reason` as the reason). A configured `guardrails.onToolApproval` still decides server tools without asking the client.
  - Client-side `function` calls pause the agent run instead of holding it open, so the run timeout (120 s by default) no longer fails a run whose client answers within the 10 minute `expires_at`, and a waiting run no longer holds a `maxConcurrentRuns` slot. Tool call ids in `required_action` are now the model's own call ids.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The server is no longer open to the network and to every web page by default. It binds `127.0.0.1` instead of `0.0.0.0`, `start()` refuses a public host without `apiKeys` unless `allowUnauthenticatedPublicAccess: true` says a gateway authenticates callers, and CORS is off until `cors.origin` names the origins browsers may call from. Run streams write a `: keep-alive` comment every `sseHeartbeatMs` (5 seconds by default) while a run is silent, so proxies no longer cut runs that wait on slow tools.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A run whose answer stopped at the output token limit (`max_completion_tokens`, or the model's own) now ends `incomplete` with `incomplete_details.reason: 'max_completion_tokens'`, as the OpenAI API reports it, instead of `completed`. The answer is kept as a message with `status: 'incomplete'` and `incomplete_details.reason: 'max_tokens'`, and a stream sends `thread.message.incomplete` and `thread.run.incomplete`, so a client no longer takes a cut-off answer (half a JSON object, for instance) for a finished one. An answer the provider's content filter withheld is an `incomplete` message with reason `content_filter`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `RunOptions.toolChoice` sets which tools the model may or must call in a run. `'none'` holds for every turn. `'required'` or a named function forces a call on each turn until the model makes one, then the run goes back to `'auto'`, so the model answers from the results instead of calling tools until `maxIterations`. A named function the agent does not have fails the run with `VALIDATION_ERROR`.

  The OpenAI-compatible endpoints pass `tool_choice: 'required'` and a named function on to the run, where before they only narrowed the tools and a model could still answer in plain text. The AI SDK bridge forces `required` and a named tool of the agent the same way instead of warning that it cannot.

- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/server-shared@0.5.0

## 21.1.13

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0

## 21.1.12

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0

## 21.1.11

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2

## 21.1.10

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4

## 21.1.9

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3

## 21.1.8

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/types@0.33.1

## 21.1.7

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1

## 21.1.6

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0

## 21.1.5

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0

## 21.1.4

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/types@0.31.0

## 21.1.3

### Patch Changes

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0

## 21.1.2

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2

## 21.1.1

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1

## 21.1.0

### Minor Changes

- 201bd72: Server failures no longer reach API clients with their text: the error handler answers every 5xx with `Internal server error`, a failed run's `last_error` says `Internal server error` unless the cause is a `CogitatorError` or a refused request, and storage failures while creating, cancelling or resuming a run answer 500 instead of 400. Refused requests throw the new exported `InvalidRequestError` and answer 400 with their `param`. `GET /v1/files` honours `limit` (up to 10 000, all files by default), `order` and `after`. `max_prompt_tokens` is applied: the oldest thread messages are left out of the prompt until it fits, and a run whose last message alone does not fit ends `incomplete` with `incomplete_details.reason: 'max_prompt_tokens'`.

### Patch Changes

- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
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
- Updated dependencies [b8c9eca]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [d35ef2a]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0

## 21.0.5

### Patch Changes

- Updated dependencies [e211b6a]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/types@0.28.0

## 21.0.4

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

## 21.0.3

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0

## 21.0.2

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

## 21.0.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1

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
