# @cogitator-ai/workflows

## 0.11.1

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0

## 0.11.0

### Minor Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Dead letters can be retried for real and kept in Postgres. `DLQ.retry(id)` only bumped a counter, so retrying a failed node was left to every app. `WorkflowManager.retryDeadLetter(dlq, id)` now replays the entry's run from the failed node, keeping the checkpointed results of the nodes before it, or runs the workflow again from its input when the run failed before its first checkpoint. The attempt is recorded first and the entry is removed when the retry succeeds. `PostgresDLQ` stores the queue in Postgres (one table, created on first use, filters in SQL, `cleanupExpired()`), so failed nodes survive restarts and every process sees one queue. `retryDeadLetter` and `replay` take execute options, such as the `approvalStore` a retried run needs.

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - A human approval wait survives a restart. A request got a random id, so a run picked up again after a crash asked the same question twice and lost an answer given while the process was down. A request's id now comes from the run and the question, so a human node that runs again finds its own request: an answer given in the meantime is used at once, an open request is waited on without a second notification, and the timeout keeps counting from the original deadline. A node visited again in a loop asks about a changed state and opens a new request. `WorkflowManager.recoverRuns(options)` resumes the runs a stopped process left running or waiting from their last checkpoint. An escalation's id comes from the request it escalates and it keeps its own deadline, so a pending escalation is picked up too. `resume`, `replay` and `recoverRuns` start from the newest checkpoint saved for the run, even one the run record never heard of because the process stopped mid-flight.

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/types@0.31.0

## 0.10.3

### Patch Changes

- [`cdc2b80`](https://github.com/cogitator-ai/Cogitator-AI/commit/cdc2b801b6914b50318d080b0eba5d8547b7c23a) - A timer interrupted by a pause or an abort no longer counts as completed. The timer node swallowed the abort and returned `{ cancelled: true }`, so the run checkpointed it as done and `resume()` ran the following nodes at once, skipping the rest of the wait (an embargo of 3 s paused after 0.5 s released 2.4 s early). The node now fails with an `AbortError` like a human node does, so it is not checkpointed and a resumed run waits again. A persisted timer (`persist: true` with a `timerStore`) is cancelled in its store and marked as interrupted, and on resume the node waits only until the original `firesAt`. A persisted timer cancelled through its store while the node waits (`TimerManager.cancel`) now reports `cancelled: true` and `onCancelled` instead of `onFired`.
- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0

## 0.10.2

### Patch Changes

- [#104](https://github.com/cogitator-ai/Cogitator-AI/pull/104) [`c237c48`](https://github.com/cogitator-ai/Cogitator-AI/commit/c237c4836c654c3521c82bb11d3f0ccf4ed3a78f) Thanks [@lb1192176991-lab](https://github.com/lb1192176991-lab)! - Human approval nodes now stop waiting when the workflow run is aborted: the pending approval request is withdrawn from the store and the node fails with an abort error instead of hanging until someone answers or the request times out.
- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2

## 0.10.1

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1

## 0.10.0

### Minor Changes

- 25af97f: `WorkflowManager` no longer overwrites a paused or cancelled run with `failed`, and `resume()` now actually continues a paused run from its last checkpoint (reusing the options it was started with, or new ones passed as a second argument); pausing requires a `checkpointStore`. Scheduled runs now get the manager's checkpoint store, tracer, metrics and `defaultTimeout`, honour `ScheduleOptions.timeout` and retry up to `ScheduleOptions.maxRetries` times, and the manager exposes `registerCronJob`, `unregisterCronJob`, `setCronJobEnabled` and `getCronJobs` for recurring runs.
- ae26101: The run callbacks `onApprovalRequired`, `onTimerScheduled`, `onDeadLetter`, `onCompensationStart` and `onCompensationComplete` are now called by the executor and the manager. Nodes can declare a saga rollback with `config.compensation`: when a later node fails, the executor compensates the completed nodes (reverse order by default) before returning the error.

### Patch Changes

- e7445e2: Cron triggers registered with `catchUp: true` now fire every occurrence that passed while their timer was late (system sleep, a blocked event loop), each with its own timestamp, instead of skipping them.
- ae26101: `WorkflowExecutor.resume()` and `stream()` accept the full executor options (`signal`, `tracer`, `metricsCollector`, stores, ...), and runs without their own tracer or metrics collector now use the ones set with `setGlobalTracer` / `setGlobalMetrics` when those are enabled.
- 1a41760: `humanWorkflowNode` outputs `withdrawn`, and `escalated` is now true when a timed-out request was answered by its `escalateTo` assignee. `subworkflowWorkflowNode` with `onError: 'catch'` keeps the parent running and outputs `{ error: { name, message } }` instead of failing it, and `parallelSubworkflowsNode` accepts configs typed with the child state.
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

## 0.9.0

### Minor Changes

- 3d08d05: Approvals settle once. The first answer to a request wins in every store — in-memory, file, Redis and Postgres, atomically across processes — and a later `submitResponse` throws `ApprovalAlreadyAnsweredError` with the answer that stands; a human node whose timeout fires just after someone answered keeps that answer. Deleting (or expiring) a request nobody answered withdraws it: waiters, in this process or another, get a withdrawal and the node finishes with `withdrawn: true` instead of waiting forever. A timeout or withdrawal no longer counts as approval for `multi-choice` requests, where any decision value did.
- 57ac053: Timer claims belong to the store instance that took them. `TimerStore` gains optional `claimTtl`, `renew(id)` and `release(id)`, which `RedisTimerStore` and `PostgresTimerStore` implement (Postgres adds a `claimed_by` column, also to existing tables). `TimerManager` renews a claim right before a handler starts and every `claimTtl / 3` while it runs, so a handler slower than the lease no longer lets another worker run the same timer; it skips a timer whose claim another worker took while it waited and reports it through the new `onClaimLost` option. A timer without a handler, or beyond a poll's `batchSize`, is released so another manager can take it right away. A failed handler still keeps the claim until the lease ends, which spaces out retries.
- 802388e: Runs, approvals and timers can live in Redis or Postgres, like checkpoints: `RedisRunStore` / `PostgresRunStore`, `RedisApprovalStore` / `PostgresApprovalStore` and `RedisTimerStore` / `PostgresTimerStore` take an existing `@cogitator-ai/redis` client or ioredis, or a `pg` Pool, and create their tables on first use. Run queries, counts and stats run in the database (Postgres) or on sorted-set indexes (Redis); a human node waiting in one process resumes when another process answers (polled every `pollInterval`); and overdue timers are claimed for `claimTtl`, so several `TimerManager`s can share a store without firing a timer twice and a crashed worker's timers come back. All Postgres stores, the checkpoint store included, now survive two processes creating their tables at the same moment.

### Patch Changes

- 4c46b22: `humanNode`, `approvalNode`, `choiceNode`, `inputNode`, `ratingNode`, `chainNode` and `managementChain` return `NamedHumanNodeConfig` — the config with its `name` known to be set — so `config.name` can be passed where a string is required.
- 6b16db1: `InMemoryRunStore` hands out copies of runs, so changing a returned run's node or tag lists no longer changes the stored run, and `list()` without filters is sorted like `list({})` (newest started first), matching the Redis and Postgres stores. `WorkflowRunStats` documents that cancelled runs count toward neither the success nor the failure rate.
- 8d2d1bf: `WorkflowManager` records `currentNodes`, `completedNodes` and `failedNodes` for scheduled and triggered runs too (it did only for `execute()`), and a run's record holds every node update by the time the run is marked finished.
- 35701f9: Workflow typing fixes. `addLoop` conditions receive the builder's state type, like `addConditional`, instead of `unknown`. `executeParallelSubworkflows`, `parallelSubworkflows`, `fanOutFanIn` and `scatterGather` carry the child workflow state (`CS`), so a typed child workflow fits without casts. `'noop'` is a valid tracing exporter, and `WorkflowTracer.isSampled()` is `false` with a sample rate of 0.
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

## 0.8.0

### Minor Changes

- 4964fb6: Workflow checkpoints in Redis and Postgres, and resuming that resumes.

  - `RedisCheckpointStore` (an `@cogitator-ai/redis` client or ioredis) and `PostgresCheckpointStore` (a `pg` Pool; creates its table on first use) keep checkpoints where any process can resume them.
  - **Fixes:** `WorkflowExecutor.resume()` ran finished nodes again when they followed another finished node, and nodes after a finished node lost its output as their input; both are fixed (`WorkflowExecuteOptions.nodeResults` carries the outputs). Checkpoints saved in the same millisecond now get increasing timestamps, so "latest" is the latest. `WorkflowManager.replay(workflow, runId, node)` runs the node and everything after it again (it used to skip some of them) with the earlier nodes' results, and a manager with a `checkpointStore` checkpoints its runs by default, so they can be replayed.

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

## 0.7.3

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0

## 0.7.2

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

## 0.7.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1

## 0.7.0

### Minor Changes

- Timers use cron-parser 5 (next/prev verified against v4 across time zones and DST).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

## 0.6.1

### Patch Changes

- Nodes with `config.timeout` now cancel the timed-out attempt: each attempt gets its own AbortSignal (linked to the run signal) that is aborted with the `NodeTimeoutError`. Previously agent nodes kept their LLM request running in the background after a timeout, and retries stacked parallel generations.

## 0.6.0

### Minor Changes

- Joins were broken: a join node could run once per arriving branch, the first time before slower branches had finished. A reachability-based join barrier fixes this. Entry-point detection in the builder was inverted: only the first of several independent roots ran, and a root addParallel was skipped. Subworkflow child failures were reported as success; they now propagate, and timeouts abort the child. Per-node timeout, retries and retryDelay were ignored and are now enforced. Run-level policies are honoured: defaultRetry, defaultCircuitBreaker, deadLetterQueue, idempotencyStore, approval/timer stores, and the manager's defaultTimeout. The run signal reaches agent and tool nodes, and a tracer and metricsCollector can be passed. New adapters (timerWorkflowNode, humanWorkflowNode, mapWorkflowNode, mapReduceWorkflowNode, subworkflowWorkflowNode, parallelSubworkflowsNode) make the documented helpers usable inside a workflow. Conditionals can target any construct, the scheduler uses an order-preserving pool, and the trigger manager and checkpoint store no longer swallow errors. README rewritten with type-checked snippets; docs updated; examples 01-03 verified with Gemini.

  **Breaking changes**
  - Builds with several independent root nodes now throw; previously only the first root silently ran
  - A root addParallel is now the entry point
  - Nodes placed after a loop must be its back or exit node, otherwise the build throws
  - Subworkflow child failures now fail the parent subworkflow node
  - addNode accepts a WorkflowNode as well as a NodeFn (additive)

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.5.17

### Patch Changes

- Comprehensive audit: ~560 bugs fixed across 16 packages

  Second-pass audit of all major packages with deep source review,
  automated fixes, and test updates. Key security fixes include SSRF
  protection (rag, a2a), sandbox escape prevention via worker_threads
  (self-modifying), broken MD5/Ed25519 crypto (wasm-tools), prototype
  chain bypass (server adapters), and MCP input schema validation.
  - memory: 58 fixes (adapters try/catch, embedding retry/timeout, knowledge graph UNION ALL, BM25 inverted index)
  - workflows: ~100 fixes (concurrency enforcement, cancel/abort wiring, cron double-fire race, setTimeout overflow)
  - swarms: ~70 fixes (Redis atomic writes via Lua, pipeline goto guard, approval Promise hang, delegation race)
  - rag: 31 fixes (SSRF protection, PDF splitPages rewrite, recursive chunker offsets, MMR lambda wiring)
  - a2a: 24 fixes (busy-loop fix, HMAC nested fields, SSRF IPv6 bypass, auth enforcement, Redis atomic update)
  - voice: 45 fixes (VAD race serialization, Deepgram timeout, TTS safe body access, SileroVAD dispose)
  - browser: 41 fixes (stealth flags controllable, smartSelect crash, path traversal, screenshot dimensions)
  - neuro-symbolic: 58 fixes (semicolon lexer, PRNG OOB, Ed25519 curve math, extractJSON string-aware, plan repair)
  - self-modifying: 63 fixes (worker_threads sandbox, safety constraints enforced, dead triggers wired, shouldAdopt logic)
  - wasm-tools: 27 fixes (MD5 BigInt padding, CSPRNG keygen, plugin leak, extism API fix, serialization queue)
  - mcp: 17 fixes (per-request transport, Zod raw shape inputSchema, body size limit, callTool all content blocks)
  - server adapters: 26 fixes (Object.hasOwn prototype bypass, error masking, abort signal, CORS credentials)
  - types: allowReverseTraversal, baseUrl, dimensions fields added
  - CI: retired models updated, http.test.ts mocked, TEST_MODEL upgraded to gpt-oss:20b

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/types@0.22.3

## 0.5.16

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.5.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.5.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.5.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.5.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.5.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.5.9

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.5.8

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.5.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.5.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.5.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.5.3

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/types@0.19.2

## 0.5.2

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/types@0.19.1

## 0.5.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2

## 0.5.0

### Minor Changes

- Add per-node checkpoint granularity with `checkpointStrategy` option
  - `'per-iteration'` (default): checkpoint after all parallel nodes complete
  - `'per-node'`: checkpoint after each node completes, enabling resume from partial parallel execution

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/core@0.17.1

## 0.4.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/types@0.18.0

## 0.4.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/types@0.17.0

## 0.4.5

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/types@0.16.0

## 0.4.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/types@0.15.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/types@0.14.0

## 0.4.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/types@0.13.0

## 0.4.1

### Patch Changes

- docs: sync package READMEs with main documentation
  - @cogitator-ai/core@0.11.5

## 0.4.0

### Minor Changes

- feat(workflows): implement real-time streaming with progress reporting

  Add Server-Sent Events style streaming for workflow execution:
  - Add StreamingWorkflowEvent type with modern underscore-style events
  - Add workflow_started, node_started, node_progress, node_completed, workflow_completed events
  - Add reportProgress callback to NodeContext for nodes to report 0-100% progress
  - Add onNodeProgress callback to WorkflowExecuteOptions

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/core@0.11.4

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/core@0.11.3

## 0.3.0

### Minor Changes

- feat(workflows): implement ParallelEdge support in WorkflowBuilder

  Added `addParallel()` method to WorkflowBuilder for creating parallel fan-out edges:

  ```typescript
  const workflow = new WorkflowBuilder<MyState>('parallel-workflow')
    .addNode('start', async () => ({ output: 'ready' }))
    .addParallel('fanout', ['a', 'b', 'c'], { after: ['start'] })
    .addNode('a', async () => ({ output: 'a' }))
    .addNode('b', async () => ({ output: 'b' }))
    .addNode('c', async () => ({ output: 'c' }))
    .addNode('merge', async (ctx) => ({ output: ctx.input }), {
      after: ['a', 'b', 'c'],
    })
    .build();
  ```

  - Parallel nodes execute concurrently (respects maxConcurrency)
  - Fan-in support: merge node receives array of outputs from parallel branches
  - Works with existing conditional and loop edges

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/core@0.11.2

## 0.2.11

### Patch Changes

- @cogitator-ai/core@0.11.1

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0

## 0.2.9

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/types@0.10.0

## 0.2.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/core@0.9.0

## 0.2.7

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/types@0.8.1

## 0.2.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/types@0.8.0

## 0.2.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/types@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/types@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/core@0.3.0

## 0.2.0

### Minor Changes

- **Type safety**: Fix setTimeout/setInterval type confusion in cron-trigger
  - Added separate `timeouts` Map for one-shot timers vs recurring `intervals`
  - Fixed improper cast `as unknown as ReturnType<typeof setInterval>`
- **Error handling**: Add error guards for safer callback invocation
  - `timer-manager.ts`: Guard `onError` callback with `instanceof Error` check
  - `circuit-breaker.ts`: Guard `recordFailure` with proper error normalization
  - `idempotency.ts`: Guard error storage with proper error normalization

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/core@0.1.1
