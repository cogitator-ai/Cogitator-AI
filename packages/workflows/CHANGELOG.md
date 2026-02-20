# @cogitator-ai/workflows

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
