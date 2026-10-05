# @cogitator-ai/worker

## 0.8.3

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1
  - @cogitator-ai/swarms@0.10.3

## 0.8.2

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/swarms@0.10.2

## 0.8.1

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0
  - @cogitator-ai/swarms@0.10.1

## 0.8.0

### Minor Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Queued agents now do everything an in-process agent does with its answer and its bill. A job result carries `structured` (the validated answer of a JSON schema agent), the reasoning summary and `usage` with the run's cost, so a producer no longer parses JSON from `output` or prices tokens itself. `serializeAgent(agent)` builds a job from an existing agent, turning its Zod response schema into JSON Schema that the worker turns back into a schema, and carries its reasoning effort and `topP`. The redis config takes a `url` (`redis://`, or `rediss://` for TLS) with a username and a database, and explicit fields override it. Cluster nodes get the same username, password and TLS. `tokenUsage` stays for compatibility and is deprecated.

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/swarms@0.10.0
  - @cogitator-ai/types@0.31.0

## 0.7.3

### Patch Changes

- [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe) - Serialized agents now route like the same agent in-process. The worker only recognised built-in providers as a model prefix, so `model: 'openrouter/deepseek/deepseek-v4-pro'` with `provider: 'openai'` ran as `openai/openrouter/...` on the OpenAI backend (failing with "OpenAI API key is required") instead of on the worker's `openrouter` backend, and plugin providers were lost the same way. A model whose prefix names a built-in provider, a backend in the worker Cogitator's `llm.backends` or a registered plugin now runs there unchanged, and `provider` is prepended only to a model whose prefix names none. `SerializedAgent.provider` accepts any provider name (`LLMBackendProvider`), custom backends and plugins included, and is optional: without it such a model runs on the worker's `llm.defaultProvider`. A `provider` the worker cannot route to now fails the job with a clear error instead of silently running on the default provider.

  `JobQueue.getMetrics()` now counts jobs added with a `priority`. BullMQ keeps them in its `prioritized` state, which `waiting`, `depth` and the `cogitator_queue_depth` metric left out, so a queue of prioritized jobs looked empty to an autoscaler. They now count in `waiting` and `depth`. `getJobState()` returns the new `JobState` type, which lists `'prioritized'` and `'waiting-children'` next to the states documented before.

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/swarms@0.9.3

## 0.7.2

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2
  - @cogitator-ai/swarms@0.9.2

## 0.7.1

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1
  - @cogitator-ai/swarms@0.9.1

## 0.7.0

### Minor Changes

- c8648b0: The completed and failed job counts come from the jobs BullMQ keeps in Redis, which `removeOnComplete`/`removeOnFail` cap, so they drop as old jobs are trimmed, yet they were exported as counters (`cogitator_queue_completed_total`, `cogitator_queue_failed_total`), which broke `rate()` and `increase()`. They are now gauges named `cogitator_queue_completed` and `cogitator_queue_failed`. For a real failure counter, `WorkerPool` records jobs that failed their last attempt in `pool.metrics` (`MetricsCollector.recordFailure`), exported as `cogitator_jobs_failed_total{type}`.

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
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [0e17a89]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/swarms@0.9.0

## 0.6.2

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
  - @cogitator-ai/swarms@0.8.2

## 0.6.1

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
  - @cogitator-ai/swarms@0.8.1

## 0.6.0

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
  - @cogitator-ai/swarms@0.8.0

## 0.5.2

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
  - @cogitator-ai/swarms@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1
  - @cogitator-ai/swarms@0.6.1

## 0.5.0

### Minor Changes

- BullMQ 6; ioredis is a required peer (BullMQ no longer depends on it).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/swarms@0.6.0
  - @cogitator-ai/types@0.24.0

## 0.4.1

### Patch Changes

- @cogitator-ai/swarms@0.5.1

## 0.4.0

### Minor Changes

- Distributed swarm results never reached the coordinator: they had no jobId and nothing consumed the job list. A new DistributedSwarmWorker fixes this and is verified end to end with Redis and Ollama. Model strings were double-prefixed ('openai/openai/gpt-4'). Serialized tools were replaced by stubs that returned fake success; they are now resolved from the worker's tools registry and fail fast when missing. 4 of 5 swarm topologies always threw; the new buildSwarmConfig maps all of them. Workflow jobs threw 'not implemented' and now run on a validated DAG interpreter with agent, transform, condition and parallel nodes. WorkerConfig accepts a shared cogitator and tools runtime instead of creating a bare Cogitator per job. Redis cluster now uses a real ioredis Cluster instead of the first node only. Blocking connections set maxRetriesPerRequest: null. A forced stop closes everything, and the publisher is configured once instead of per job from env. getWorkersCount, job-duration metrics and Prometheus label escaping now work, and tool outputs are recovered. Payload types are aliased from swarms. README, docs and examples/infrastructure/03-worker-queue.ts were updated and verified.

  **Breaking changes**
  - processSwarmAgentJob(payload, { publisher, isFinalAttempt? }) now requires a publisher instead of building an env-based Redis client
  - Agents that reference tools need implementations registered in the worker `tools` option (stubs were removed)
  - SerializedAgent.provider widened to LLMProvider; maxIterations added
  - Workflow jobs now execute instead of throwing
  - Swarm agent job payload/result types now alias the @cogitator-ai/swarms contract

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/swarms@0.5.0
  - @cogitator-ai/types@0.23.0

## 0.3.20

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/swarms@0.4.20
  - @cogitator-ai/types@0.22.3

## 0.3.19

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/swarms@0.4.19

## 0.3.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/swarms@0.4.18

## 0.3.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/swarms@0.4.17

## 0.3.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7
  - @cogitator-ai/swarms@0.4.16

## 0.3.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6
  - @cogitator-ai/swarms@0.4.15

## 0.3.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5
  - @cogitator-ai/swarms@0.4.14
  - @cogitator-ai/workflows@0.5.10

## 0.3.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/swarms@0.4.13

## 0.3.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/redis@0.2.24
  - @cogitator-ai/core@0.18.4
  - @cogitator-ai/swarms@0.4.12
  - @cogitator-ai/workflows@0.5.9

## 0.3.11

### Patch Changes

- @cogitator-ai/core@0.18.3
- @cogitator-ai/swarms@0.4.11
- @cogitator-ai/workflows@0.5.8

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
  - @cogitator-ai/redis@0.2.23
  - @cogitator-ai/swarms@0.4.10
  - @cogitator-ai/workflows@0.5.7

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1
  - @cogitator-ai/swarms@0.4.9
  - @cogitator-ai/workflows@0.5.6

## 0.3.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/swarms@0.4.8
  - @cogitator-ai/workflows@0.5.5
  - @cogitator-ai/redis@0.2.22

## 0.3.6

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/redis@0.2.20
  - @cogitator-ai/swarms@0.4.6
  - @cogitator-ai/workflows@0.5.3

## 0.3.5

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/swarms@0.4.5
  - @cogitator-ai/workflows@0.5.2
  - @cogitator-ai/redis@0.2.19

## 0.3.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2
  - @cogitator-ai/swarms@0.4.4
  - @cogitator-ai/workflows@0.5.1

## 0.3.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.5.0
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/swarms@0.4.3
  - @cogitator-ai/core@0.17.1
  - @cogitator-ai/redis@0.2.18

## 0.3.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/swarms@0.4.2
  - @cogitator-ai/workflows@0.4.7
  - @cogitator-ai/redis@0.2.17

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/swarms@0.4.1
  - @cogitator-ai/workflows@0.4.6
  - @cogitator-ai/redis@0.2.16

## 0.3.0

### Minor Changes

- feat: distributed swarm execution via Redis

### Patch Changes

- Updated dependencies
  - @cogitator-ai/swarms@0.4.0

## 0.2.20

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/swarms@0.3.20
  - @cogitator-ai/workflows@0.4.5
  - @cogitator-ai/redis@0.2.15

## 0.2.19

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/swarms@0.3.19
  - @cogitator-ai/workflows@0.4.4
  - @cogitator-ai/redis@0.2.14

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/swarms@0.3.18
  - @cogitator-ai/workflows@0.4.3
  - @cogitator-ai/redis@0.2.13

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/swarms@0.3.17
  - @cogitator-ai/workflows@0.4.2
  - @cogitator-ai/redis@0.2.12

## 0.2.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.4.1
  - @cogitator-ai/core@0.11.5
  - @cogitator-ai/swarms@0.3.16

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/workflows@0.4.0
  - @cogitator-ai/core@0.11.4
  - @cogitator-ai/redis@0.2.11
  - @cogitator-ai/swarms@0.3.15

## 0.2.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/core@0.11.3
  - @cogitator-ai/redis@0.2.10
  - @cogitator-ai/swarms@0.3.14
  - @cogitator-ai/workflows@0.3.1

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.3.0
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/swarms@0.3.13
  - @cogitator-ai/core@0.11.2
  - @cogitator-ai/redis@0.2.9

## 0.2.12

### Patch Changes

- Updated dependencies [fec45e0]
  - @cogitator-ai/swarms@0.3.12

## 0.2.11

### Patch Changes

- @cogitator-ai/core@0.11.1
- @cogitator-ai/swarms@0.3.11
- @cogitator-ai/workflows@0.2.11

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0
  - @cogitator-ai/swarms@0.3.10
  - @cogitator-ai/workflows@0.2.10

## 0.2.9

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/swarms@0.3.9
  - @cogitator-ai/workflows@0.2.9
  - @cogitator-ai/redis@0.2.8

## 0.2.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/core@0.9.0
  - @cogitator-ai/redis@0.2.7
  - @cogitator-ai/swarms@0.3.8
  - @cogitator-ai/workflows@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/swarms@0.3.7
  - @cogitator-ai/workflows@0.2.7
  - @cogitator-ai/redis@0.2.6

## 0.2.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/swarms@0.3.6
  - @cogitator-ai/workflows@0.2.6
  - @cogitator-ai/redis@0.2.5

## 0.2.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1
  - @cogitator-ai/swarms@0.3.5
  - @cogitator-ai/workflows@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/swarms@0.3.4
  - @cogitator-ai/workflows@0.2.4
  - @cogitator-ai/redis@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/swarms@0.3.3
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/workflows@0.2.3
  - @cogitator-ai/redis@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/swarms@0.3.2
  - @cogitator-ai/workflows@0.2.2
  - @cogitator-ai/redis@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/core@0.3.0
  - @cogitator-ai/redis@0.2.1
  - @cogitator-ai/swarms@0.3.1
  - @cogitator-ai/workflows@0.2.1

## 0.2.0

### Minor Changes

- **Documentation**: Complete README rewrite to match actual API
  - Fixed Redis configuration examples (host/port instead of url)
  - Fixed addAgentJob/addWorkflowJob/addSwarmJob signatures
  - Fixed MetricsCollector usage examples
  - Added Redis cluster configuration examples

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/swarms@0.2.0
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/core@0.1.1
  - @cogitator-ai/redis@0.1.1
  - @cogitator-ai/workflows@0.1.1
