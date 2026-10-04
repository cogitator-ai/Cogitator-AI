# @cogitator-ai/workflows

[![npm version](https://img.shields.io/npm/v/@cogitator-ai/workflows.svg)](https://www.npmjs.com/package/@cogitator-ai/workflows)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

DAG-based workflow engine for Cogitator agents. Build multi-step workflows with branching, loops, joins, checkpoints, human-in-the-loop steps, timers, sagas, subworkflows, map-reduce, triggers and observability.

## Installation

```bash
pnpm add @cogitator-ai/workflows @cogitator-ai/core

# Optional, for the durable stores
pnpm add pg                                 # PostgreSQL stores
pnpm add @cogitator-ai/redis ioredis        # Redis stores
```

Website docs: [Workflows](https://cogitator.app/docs/workflows), [Builder](https://cogitator.app/docs/workflows/builder), [Nodes](https://cogitator.app/docs/workflows/nodes), [Execution](https://cogitator.app/docs/workflows/execution), [Patterns](https://cogitator.app/docs/workflows/patterns), [Sagas](https://cogitator.app/docs/workflows/sagas), [Scheduling](https://cogitator.app/docs/workflows/scheduling).

## Features

- **DAG Builder** — nodes, conditionals, loops and parallel fan-out with validation and entry-point detection
- **Correct joins** — a node with several upstream branches runs once, after all of them finished
- **Node policies** — per-node `timeout`, `retries` and `retryDelay`
- **Real-time Streaming** — async generator of execution events
- **Checkpoints** — save and resume workflow state
- **Durable Stores** — checkpoints, runs, approvals and timers in Redis or PostgreSQL, shared by several processes
- **Pre-built Nodes** — agent, tool, function and custom nodes, plus adapters for timers, human approvals, map-reduce and subworkflows
- **Saga Patterns** — retries, circuit breakers, compensation, dead-letter queue, idempotency
- **Triggers** — cron, webhook and event triggers
- **Observability** — tracing (console, OTLP, Zipkin) and metrics (Prometheus format)
- **Workflow Management** — run store, scheduling, cancellation, retries, replay

## Quick Start

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { WorkflowBuilder, WorkflowExecutor, agentNode } from '@cogitator-ai/workflows';

type ReportState = {
  topic: string;
  analysis?: string;
};

const cogitator = new Cogitator({ llm: { defaultModel: 'ollama/llama3.2' } });
const analyst = new Agent({
  name: 'analyst',
  model: 'ollama/llama3.2',
  instructions: 'Analyze topics concisely.',
});

const workflow = new WorkflowBuilder<ReportState>('report')
  .initialState({ topic: '' })
  .addNode(
    'analyze',
    agentNode<ReportState>(analyst, {
      inputMapper: (state) => `Analyze: ${state.topic}`,
      stateMapper: (result) => ({ analysis: result.output }),
    })
  )
  .addNode('report', async (ctx) => ({ output: `Report: ${ctx.state.analysis}` }), {
    after: ['analyze'],
  })
  .build();

const result = await new WorkflowExecutor(cogitator).execute(workflow, { topic: 'Edge AI' });
console.log(result.state.analysis, result.error);
```

---

## Core Concepts

### WorkflowBuilder

```typescript
const workflow = new WorkflowBuilder<{ count: number }>('counter')
  .initialState({ count: 0 })
  .addNode('increment', async (ctx) => ({ state: { count: ctx.state.count + 1 } }))
  .addNode('print', async (ctx) => ({ output: `Count: ${ctx.state.count}` }), {
    after: ['increment'],
    config: { timeout: 5_000, retries: 2, retryDelay: 500 },
  })
  .build();
```

- State types must satisfy `WorkflowState` (`Record<string, unknown>`): declare them with `type`, or as `interface MyState extends WorkflowState { ... }` (`import type { WorkflowState } from '@cogitator-ai/types'`). A plain `interface` does not satisfy the constraint.
- `addNode(name, fnOrNode, { after, config })` accepts a node function or a node created by a factory.
- The entry point is the single node (or conditional/parallel/loop construct) without `after`. Independent roots are rejected — add a parallel fan-out or call `.entryPoint(name)`.
- Node functions receive `ctx.state` (a copy), `ctx.input` (outputs of upstream nodes), `ctx.nodeId`, `ctx.workflowId`, `ctx.step`, `ctx.reportProgress()` and — for built-in nodes — `cogitator`, `signal` (run cancellation) and `depth` (subworkflow nesting).
- Return `{ state }` to merge into the workflow state, `{ output }` for downstream nodes and `{ next }` to route dynamically.

### WorkflowExecutor

```typescript
const executor = new WorkflowExecutor(cogitator);

const result = await executor.execute(
  workflow,
  { count: 5 },
  {
    maxConcurrency: 4, // parallel nodes per step
    maxIterations: 100, // guards loops
    signal: abortController.signal,
    onNodeStart: (node) => console.log('start', node),
    onNodeComplete: (node, output, duration) => console.log('done', node, duration),
    onNodeError: (node, error) => console.error(node, error.message),
  }
);

console.log(result.state, result.nodeResults, result.duration, result.error);
```

`execute()` never throws for node failures: the failure is returned in `result.error` (`NodeTimeoutError` for node timeouts).

Run-level policies apply to every node:

```typescript
await executor.execute(workflow, input, {
  defaultRetry: { maxRetries: 3, backoff: 'exponential', initialDelay: 500 }, // nodes without config.retries
  defaultCircuitBreaker: breakerConfig, // per-node breaker, shared across runs of this executor
  deadLetterQueue: createInMemoryDLQ(), // entry for every node that finally failed
  idempotencyStore, // reuse results of nodes that already completed for this workflowId
  approvalStore, // default store for humanWorkflowNode
  timerStore, // default store for persisted timers
  tracer,
  metricsCollector,
});
```

---

## Real-time Streaming

```typescript
for await (const event of executor.stream(workflow, { count: 0 })) {
  switch (event.type) {
    case 'workflow_started':
    case 'node_started':
    case 'node_progress':
    case 'node_completed':
    case 'node_error':
      console.log(event.type);
      break;
    case 'workflow_completed':
      console.log('final state', event.result.state);
      break;
  }
}
```

Nodes report progress with `ctx.reportProgress(0..100)`; `execute()` exposes it through `onNodeProgress`.

---

## Pre-built Nodes

```typescript
import { agentNode, toolNode, functionNode, customNode } from '@cogitator-ai/workflows';

builder
  .addNode(
    'research',
    agentNode<MyState>(researcher, {
      inputMapper: (state) => state.question,
      stateMapper: (result) => ({ findings: result.output }),
      runOptions: { timeout: 60_000 },
    })
  )
  .addNode(
    'calculate',
    toolNode<MyState, { expression: string }>(calculator, {
      argsMapper: (state) => ({ expression: state.formula }),
      stateMapper: (result) => ({ value: result }),
    }),
    { after: ['research'] }
  )
  .addNode(
    'normalize',
    functionNode<MyState, string>('normalize', async (state) => state.findings!.trim(), {
      stateMapper: (output) => ({ findings: output as string }),
    }),
    { after: ['calculate'] }
  );
```

Agent and tool nodes use the run's abort signal, so cancelling the workflow cancels in-flight LLM and tool calls.

---

## Branching, Loops and Joins

```typescript
const workflow = new WorkflowBuilder<{ approved: boolean }>('review-flow')
  .initialState({ approved: false })
  .addNode('review', reviewFn)
  .addConditional('check', (state) => (state.approved ? 'publish' : 'revise'), {
    after: ['review'],
  })
  .addNode('publish', publishFn, { after: ['check'] })
  .addNode('revise', reviseFn, { after: ['check'] })
  .addNode('notify', notifyFn, { after: ['publish', 'revise'] })
  .build();
```

A conditional returns the name(s) of the branch(es) to take; every node (or construct) with `after: ['check']` is a candidate branch.

```typescript
const workflow = new WorkflowBuilder<{ attempts: number; done: boolean }>('retry-flow')
  .initialState({ attempts: 0, done: false })
  .addNode('attempt', async (ctx) => ({
    state: { attempts: ctx.state.attempts + 1, done: await tryIt() },
  }))
  .addLoop('again', {
    condition: (state) => !state.done && state.attempts < 3, // typed with the builder's state
    back: 'attempt',
    exit: 'finish',
    after: ['attempt'],
  })
  .addNode('finish', finishFn)
  .build();
```

Only the loop's `back` and `exit` nodes may follow it; any other node with the loop in `after` makes `build()` throw. A root `addParallel` is the workflow's entry point:

```typescript
const workflow = new WorkflowBuilder('fan-out')
  .addParallel('fan', ['fetch-a', 'fetch-b'])
  .addNode('fetch-a', fetchA)
  .addNode('fetch-b', fetchB)
  .addNode('normalize-b', normalizeB, { after: ['fetch-b'] })
  .addNode('merge', async (ctx) => ({ output: ctx.input }), { after: ['fetch-a', 'normalize-b'] })
  .build();
```

`merge` runs once, after both branches finished, and receives both outputs as `ctx.input`.

---

## Checkpoints

```typescript
import { FileCheckpointStore } from '@cogitator-ai/workflows';

const executor = new WorkflowExecutor(cogitator, new FileCheckpointStore('./checkpoints'));

const first = await executor.execute(workflow, input, {
  checkpoint: true,
  checkpointStrategy: 'per-node', // or 'per-iteration' (default)
});

if (first.error && first.checkpointId) {
  const resumed = await executor.resume(workflow, first.checkpointId);
}
```

Checkpoints shared between processes live in Redis or Postgres; the stores take your existing client (an `@cogitator-ai/redis` client or ioredis, a `pg` Pool):

```typescript
import { RedisCheckpointStore, PostgresCheckpointStore } from '@cogitator-ai/workflows';

new RedisCheckpointStore({ client: redis, keyPrefix: 'myapp:checkpoints' });
new PostgresCheckpointStore({ client: pool, table: 'workflow_checkpoints' }); // created on first use
```

Resuming runs only the nodes that did not finish, and the nodes after them get the finished nodes' outputs as input.

Runs, approvals and timers have the same kind of durable stores:

```typescript
import {
  PostgresRunStore,
  RedisApprovalStore,
  PostgresTimerStore,
  createWorkflowManager,
} from '@cogitator-ai/workflows';

createWorkflowManager({ cogitator, runStore: new PostgresRunStore({ client: pool }) });
new RedisApprovalStore({ client: redis, pollInterval: 1000 }); // answers from other processes arrive by polling
new PostgresTimerStore({ client: pool, claimTtl: 60_000 }); // each overdue timer is claimed by one TimerManager
```

Postgres stores create their tables on first use (safe when two processes start at once); Redis stores index runs and requests in sorted sets instead of scanning keys. Approvals answered in another process reach the waiting human node within `pollInterval` (default 1 s); overdue timers are claimed for `claimTtl` (default 60 s) so several `TimerManager`s can share a store without firing a timer twice, and a crashed worker's timers come back once their claim expires.

A `TimerManager` renews a claim right before a handler starts and every `claimTtl / 3` while it runs, so slow handlers keep their timer. If the claim was lost (another worker took it), the handler is skipped or `onClaimLost` reports it; timers without a handler, or beyond a poll's `batchSize`, are released so another manager can take them at once. A failed handler keeps the claim until the lease ends, which spaces out retries:

```typescript
import { createTimerManager, RedisTimerStore } from '@cogitator-ai/workflows';

const timers = createTimerManager(new RedisTimerStore({ client: redis, claimTtl: 30_000 }), {
  pollInterval: 1_000,
  onClaimLost: (entry) => console.warn('another worker took timer', entry.id),
});
timers.setDefaultHandler(async (entry) => console.log('fired', entry.id));
await timers.start();
```

Custom stores implement `TimerStore`; `claimTtl`, `renew(id)` and `release(id)` are optional there and enable the claim handling above.

---

## Timers

```typescript
import {
  delayNode,
  dynamicDelayNode,
  cronWaitNode,
  untilNode,
  timerWorkflowNode,
  parseDuration,
  formatDuration,
} from '@cogitator-ai/workflows';

builder
  .addNode('cool-down', timerWorkflowNode(delayNode('cool-down', parseDuration('5m'))))
  .addNode(
    'backoff',
    timerWorkflowNode(dynamicDelayNode<MyState>('backoff', (state) => state.retries * 1000)),
    { after: ['cool-down'] }
  )
  .addNode('business-hours', timerWorkflowNode(cronWaitNode('business-hours', '0 9 * * 1-5')), {
    after: ['backoff'],
  })
  .addNode('deadline', timerWorkflowNode(untilNode<MyState>('deadline', (state) => state.dueAt)), {
    after: ['business-hours'],
  });

formatDuration(90_000); // '1.5m'
```

Aborting the run (`signal`, a manager's `pause()` or `cancel()`) stops the wait and fails the node with an `AbortError`, so the node is not checkpointed as completed and a resumed run waits again. Pass `{ timerStore }` to `timerWorkflowNode` together with `persist: true` configs (or use `createTimerNodeHelpers(store)`) to persist timers: an interrupted persisted timer is cancelled in its store, and on resume the node waits only until the original `firesAt`, so a pause never shortens or extends the wait. A persisted timer cancelled through its store while the node waits (`TimerManager.cancel`) is not marked fired: the node reports `cancelled: true` and `onCancelled` when the wait ends. `createTimerManager(store)` and `createRecurringScheduler(manager)` process persisted and recurring timers. Cron helpers: `validateCronExpression`, `getNextCronOccurrence(s)`, `describeCronExpression`, `CRON_PRESETS`.

---

## Saga Patterns

### Retry

```typescript
import { executeWithRetry, withRetry } from '@cogitator-ai/workflows';

const outcome = await executeWithRetry((attempt) => callService(attempt), {
  maxRetries: 4,
  backoff: 'exponential', // 'constant' | 'linear' | 'exponential'
  initialDelay: 500,
  maxDelay: 10_000,
  jitter: 0.1,
  isRetryable: (error) => !error.message.includes('invalid'),
});
if (!outcome.success) console.error(outcome.error);

const fetchWithRetry = withRetry((url: string) => fetch(url), { maxRetries: 3 });
```

### Circuit Breaker

```typescript
import { createCircuitBreaker, CircuitBreakerOpenError } from '@cogitator-ai/workflows';

const breaker = createCircuitBreaker({ threshold: 5, resetTimeout: 30_000, successThreshold: 2 });

try {
  await breaker.execute('payments', () => payments.charge(order));
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    // use a fallback
  }
}

console.log(breaker.getStats('payments'));
```

### Compensation

Give a node `config.compensation` and the executor rolls it back when a later node of the run fails:

```typescript
builder
  .addNode('reserve', reserveFn, {
    config: { compensation: { compensate: async (state) => inventory.release(state.orderId) } },
  })
  .addNode('charge', chargeFn, {
    after: ['reserve'],
    config: {
      compensation: {
        compensate: async (state) => payments.refund(state.paymentId!),
        compensateTimeout: 10_000,
      },
    },
  })
  .addNode('ship', shipFn, { after: ['charge'] });

const result = await executor.execute(workflow, input, {
  onCompensationStart: (node) => console.log(`rolling back ${node}`),
  onCompensationComplete: (node) => console.log(`rolled back ${node}`),
});
```

Completed nodes with a `compensate` are rolled back in reverse completion order (`compensateOrder: 'parallel' | 'forward'` changes that, `compensateCondition` skips a step); aborted, paused and cancelled runs are not compensated. For rollbacks outside the executor, use a `CompensationManager`:

```typescript
import { compensationBuilder } from '@cogitator-ai/workflows';

const compensation = compensationBuilder<OrderState>()
  .addStep('reserve', async (state) => inventory.release(state.orderId))
  .addStep('charge', async (state) => payments.refund(state.paymentId!))
  .build();

compensation.markCompleted('reserve', reservation);
compensation.markCompleted('charge', payment);

const report = await compensation.compensate(state, 'ship', new Error('carrier down'), {
  onStepStart: (nodeId) => console.log(`compensating ${nodeId}`),
});
```

Compensations run in reverse completion order for the steps marked completed; the optional `CompensationHooks` argument (`onStepStart`, `onStepComplete`) observes each step that runs.

### Dead Letter Queue and Idempotency

```typescript
import {
  createFileDLQ,
  createDLQEntry,
  createInMemoryIdempotencyStore,
  idempotent,
} from '@cogitator-ai/workflows';

const dlq = createFileDLQ('./dlq');
await dlq.add(createDLQEntry('charge', workflowId, 'checkout', state, error, { attempts: 3 }));
const failed = await dlq.list({ workflowName: 'checkout' });

const store = createInMemoryIdempotencyStore();
const receipt = await idempotent(store, `charge:${orderId}`, () => payments.charge(orderId));
```

#### Retrying a dead letter

`manager.retryDeadLetter(dlq, id)` runs a dead-lettered node again. It replays the node's run from the failed node (the nodes before it keep their checkpointed results and do not run twice), or runs the workflow again from its input when the run failed before its first checkpoint. The attempt is recorded on the entry first, and the entry is removed when the retry succeeds, so an entry that fails again stays with one more attempt. The workflow must be registered with the manager and the manager needs a `checkpointStore`:

```typescript
const manager = createWorkflowManager({ cogitator, checkpointStore, runStore });
await manager.execute(checkout, input, { deadLetterQueue: dlq });

for (const entry of await dlq.list({ workflowName: 'checkout-workflow' })) {
  const result = await manager.retryDeadLetter(dlq, entry.id);
  if (result.error) console.log(`${entry.nodeId} failed again: ${result.error.message}`);
}
```

#### Postgres DLQ

`PostgresDLQ` keeps the queue in Postgres, so failed nodes survive restarts and every process sees the same queue. It takes a `pg` Pool or Client, creates its table on first use, filters in SQL and deletes expired entries with `cleanupExpired()`:

```typescript
import pg from 'pg';
import { PostgresDLQ } from '@cogitator-ai/workflows';

const dlq = new PostgresDLQ({
  client: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  table: 'checkout_dead_letters', // default cogitator_workflow_dead_letters
  defaultTTL: 14 * 24 * 60 * 60 * 1000,
});
```

---

## Subworkflows

```typescript
import {
  subworkflowNode,
  subworkflowWorkflowNode,
  fanOutFanIn,
  parallelSubworkflowsNode,
} from '@cogitator-ai/workflows';

builder
  .addNode(
    'enrich',
    subworkflowWorkflowNode(
      subworkflowNode<ParentState, ChildState>('enrich', {
        workflow: enrichmentWorkflow,
        inputMapper: (state) => ({ record: state.record }),
        outputMapper: (result, state) => ({ ...state, enriched: result.state.record }),
        timeout: 60_000,
        onError: 'retry', // 'propagate' | 'ignore' | 'catch' | 'retry'
        maxDepth: 5,
      })
    )
  )
  .addNode(
    'per-region',
    parallelSubworkflowsNode(
      fanOutFanIn<ParentState, RegionState>('per-region', {
        workflow: regionWorkflow,
        getInputs: (state) => state.regions.map((region) => ({ id: region, input: { region } })),
        aggregator: (results, state) => ({ ...state, regionCount: results.size }),
        concurrency: 3,
      })
    ),
    { after: ['enrich'] }
  );
```

Child failures propagate to the parent (or follow `onError`); timeouts cancel the child run. `scatterGather`, `raceSubworkflows` and `fallbackSubworkflows` cover the other common patterns.

---

## Human-in-the-Loop

```typescript
import {
  approvalNode,
  humanWorkflowNode,
  InMemoryApprovalStore,
  WebhookNotifier,
} from '@cogitator-ai/workflows';

const approvalStore = new InMemoryApprovalStore();
const approvalNotifier = new WebhookNotifier({ url: 'https://hooks.example.com/approvals' });

builder
  .addNode(
    'approve-expense',
    humanWorkflowNode(
      approvalNode<ExpenseState>('approve-expense', {
        title: 'Approve expense',
        description: (state) => `Amount: $${state.amount}`,
        assignee: 'manager@company.com',
        timeout: 24 * 60 * 60 * 1000,
        timeoutAction: 'reject',
      }),
      { approvalStore, approvalNotifier, stateMapper: (result) => ({ approved: result.approved }) }
    )
  )
  .addConditional('route', (state) => (state.approved ? 'pay' : 'decline'), {
    after: ['approve-expense'],
  });

// Elsewhere (API handler, UI, Slack action):
await approvalStore.submitResponse({
  requestId,
  decision: true,
  respondedBy: 'manager@company.com',
  respondedAt: Date.now(),
});
```

Other configs: `choiceNode`, `inputNode`, `ratingNode`, `chainNode`, `managementChain`; all of them return a config whose `name` is set, so `config.name` is a `string`. Notifiers: `ConsoleNotifier`, `WebhookNotifier`, `slackNotifier`, `CompositeNotifier`, `filteredNotifier`, `priorityRouter`. `FileApprovalStore` persists requests; `RedisApprovalStore` and `PostgresApprovalStore` share them between processes.

A request is answered once, in every store (atomically across processes for Redis and Postgres): the first `submitResponse` wins and a later one throws `ApprovalAlreadyAnsweredError` carrying the answer that stands. A human node whose timeout fires just after someone answered keeps that answer. Deleting (or expiring) a request nobody answered withdraws it: waiters in any process get a withdrawal and the node finishes with `withdrawn: true` instead of waiting forever. A timeout or withdrawal never counts as approval, also for `multi-choice` requests.

```typescript
import { ApprovalAlreadyAnsweredError } from '@cogitator-ai/workflows';

try {
  await approvalStore.submitResponse({
    requestId,
    decision: false,
    respondedBy: 'cfo@company.com',
    respondedAt: Date.now(),
  });
} catch (error) {
  if (error instanceof ApprovalAlreadyAnsweredError) {
    console.log('Already decided:', error.existing?.decision);
  }
}

await approvalStore.deleteRequest(staleRequestId); // a pending request is withdrawn
```

---

## Map-Reduce

```typescript
import { mapReduceNode, mapReduceWorkflowNode } from '@cogitator-ai/workflows';

builder.addNode(
  'score-documents',
  mapReduceWorkflowNode(
    mapReduceNode<DocsState, number, number>('score-documents', {
      map: {
        items: (state) => state.documents,
        mapper: async (doc) => scoreDocument(doc as string),
        concurrency: 5,
        continueOnError: true,
      },
      reduce: {
        initial: 0,
        reducer: (sum, item) => sum + item.result,
        finalize: (sum, state) => sum / state.documents.length,
      },
    }),
    { stateMapper: (result) => ({ averageScore: result.reduced }) }
  )
);
```

`mapNode` + `mapWorkflowNode`, `parallelMap`, `batchedMap` and the reducer presets `collect`, `sum`, `count`, `groupBy`, `partition`, `flatMap` and `stats` cover other shapes.

---

## Triggers

```typescript
import { createTriggerManager, cronTrigger, webhookTrigger } from '@cogitator-ai/workflows';

const triggers = createTriggerManager({
  onTriggerFire: async (trigger, context) => {
    const run = await manager.schedule(workflows[trigger.workflowName], {
      input: { payload: context.payload },
    });
    return run;
  },
});
triggers.start();

await triggers.register({
  workflowName: 'daily-report',
  type: 'cron',
  config: cronTrigger('0 9 * * *', { timezone: 'Europe/Berlin' }),
  enabled: true,
});

await triggers.register({
  workflowName: 'github-sync',
  type: 'webhook',
  config: webhookTrigger('/hooks/github', 'POST', {
    auth: { type: 'hmac', secret: process.env.GH_SECRET! },
  }),
  enabled: true,
});

// In your HTTP handler:
const response = await triggers.handleWebhook({
  path: req.path,
  method: req.method,
  headers,
  body,
});
```

---

## Observability

```typescript
import { createTracer, createMetricsCollector } from '@cogitator-ai/workflows';

const tracer = createTracer({
  enabled: true,
  serviceName: 'billing-workflows',
  exporter: 'otlp', // 'console' | 'otlp' | 'jaeger' | 'zipkin' | 'noop'
  exporterEndpoint: 'http://localhost:4318/v1/traces',
});
const metricsCollector = createMetricsCollector({ prefix: 'cogitator_workflow' });

await executor.execute(workflow, input, { tracer, metricsCollector });
await tracer.flush();

console.log(metricsCollector.getWorkflowMetrics('report'));
console.log(metricsCollector.toPrometheusFormat());
```

The executor creates one workflow span and a child span per node execution (parallel nodes keep correct parents) and records workflow/node counts, latencies and retries. `sampleRate` (0–1) samples traces; with 0, `tracer.isSampled()` is `false` and nothing is exported.

---

## Workflow Management

```typescript
import { createWorkflowManager, createFileRunStore } from '@cogitator-ai/workflows';

const manager = createWorkflowManager({
  cogitator,
  runStore: createFileRunStore({ directory: './runs' }),
  maxConcurrency: 10,
  defaultTimeout: 300_000, // runs exceeding it are cancelled and marked failed
  tracer,
  metrics: metricsCollector,
});
manager.start();

const result = await manager.execute(workflow, input, { tags: ['nightly'] });

const runId = await manager.schedule(workflow, { at: Date.now() + 60_000, input, priority: 1 });
await manager.cancel(runId);

const runs = await manager.listRuns({ status: 'failed', workflowName: 'report', limit: 20 });
const stats = await manager.getStats('report');
await manager.retry(runs[0].id);

const jobId = manager.registerCronJob(workflow, '0 2 * * *', {
  jobOptions: { input, maxRetries: 2 },
});
```

`registerCronJob` queues a run on every occurrence while the manager is started (`schedule({ cron })` queues only the next one); `unregisterCronJob`, `setCronJobEnabled` and `getCronJobs` manage the jobs. Scheduled runs get the manager's checkpoint store, tracer, metrics and their `timeout` (else `defaultTimeout`), and `maxRetries` retries a failed scheduled run automatically. With a `checkpointStore`, `pause(runId)` aborts a running run and keeps it `paused`, and `resume(runId, options?)` continues it from its last checkpoint.

Every run — executed, scheduled or started by a trigger — records `currentNodes`, `completedNodes` and `failedNodes`, all written by the time the run is marked finished. Run stores return copies, so changing a returned run does not change the stored one; `listRuns()` is sorted newest first. `getStats()` counts cancelled runs toward neither the success nor the failure rate. Use `PostgresRunStore` / `RedisRunStore` to share runs between processes: queries, counts and stats run in the database (Postgres) or on sorted-set indexes (Redis).

---

## License

MIT
