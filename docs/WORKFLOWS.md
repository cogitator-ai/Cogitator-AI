# Workflows

> DAG-based orchestration for multi-step agent tasks

## Overview

`@cogitator-ai/workflows` lets you orchestrate multi-step tasks with:

- **Directed graphs** — define dependencies between nodes
- **State management** — pass typed state between nodes
- **Parallel execution** — run independent nodes concurrently
- **Conditional routing** — branch based on state
- **Loops** — iterate until a condition is met
- **Subworkflows** — run another workflow as a step
- **Checkpointing** — save progress and resume after a failure or restart
- **Human-in-the-loop** — pause for approvals or input
- **Sagas** — retries, circuit breakers, compensation, dead letter queue, idempotency
- **Run management** — run tracking, scheduling, triggers (cron, webhook, event)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Workflow Engine                                    │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Workflow Definition                             │   │
│   │                                                                         │   │
│   │   ┌─────┐      ┌─────┐      ┌─────┐      ┌─────┐                        │   │
│   │   │Node1│─────►│Node2│─────►│Node3│─────►│Node4│                        │   │
│   │   └─────┘      └──┬──┘      └─────┘      └─────┘                        │   │
│   │                   │                                                     │   │
│   │                   └────────►┌─────┐                                     │   │
│   │                             │Node5│ (parallel branch)                   │   │
│   │                             └─────┘                                     │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Execution Engine                                │   │
│   │                                                                         │   │
│   │   WorkflowBuilder  │  WorkflowExecutor  │  WorkflowManager              │   │
│   │                                                                         │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The website docs cover each area in more depth: [builder](https://cogitator.app/docs/workflows/builder), [nodes](https://cogitator.app/docs/workflows/nodes), [execution](https://cogitator.app/docs/workflows/execution), [sagas](https://cogitator.app/docs/workflows/sagas), [scheduling](https://cogitator.app/docs/workflows/scheduling), [patterns](https://cogitator.app/docs/workflows/patterns).

---

## Creating Workflows

Workflows are built with `WorkflowBuilder` and executed with `WorkflowExecutor`. The state type must satisfy `WorkflowState` (`Record<string, unknown>`): extend it in an interface, or use a type alias.

### Basic Workflow

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';
import { WorkflowBuilder, WorkflowExecutor, agentNode } from '@cogitator-ai/workflows';
import type { WorkflowState } from '@cogitator-ai/types';

interface ResearchState extends WorkflowState {
  topic: string;
  searchResults?: string;
  analysis?: string;
  summary?: string;
}

const cog = new Cogitator({ llm: { defaultModel: 'openai/gpt-5.5' } });

const researcherAgent = new Agent({
  name: 'researcher',
  model: 'openai/gpt-5.5',
  instructions: 'Find facts.',
});
const analyzerAgent = new Agent({
  name: 'analyzer',
  model: 'openai/gpt-5.5',
  instructions: 'Analyze findings.',
});
const writerAgent = new Agent({
  name: 'writer',
  model: 'openai/gpt-5.5',
  instructions: 'Write concise summaries.',
});

const researchWorkflow = new WorkflowBuilder<ResearchState>('research-topic')
  .initialState({ topic: '' })
  .addNode(
    'search',
    agentNode(researcherAgent, {
      inputMapper: (state) => `Search for information about: ${state.topic}`,
      stateMapper: (result) => ({ searchResults: result.output }),
    })
  )
  .addNode(
    'analyze',
    agentNode(analyzerAgent, {
      inputMapper: (state) => `Analyze these search results: ${state.searchResults}`,
      stateMapper: (result) => ({ analysis: result.output }),
    }),
    { after: ['search'] }
  )
  .addNode(
    'summarize',
    agentNode(writerAgent, {
      inputMapper: (state) => `Write a summary based on: ${state.analysis}`,
      stateMapper: (result) => ({ summary: result.output }),
    }),
    { after: ['analyze'] }
  )
  .build();

const executor = new WorkflowExecutor(cog);
const result = await executor.execute(researchWorkflow, { topic: 'WebGPU graphics API' });

console.log(result.state.summary);
```

`build()` validates the graph: duplicate node names, unknown nodes in `after` / loop targets, and an ambiguous entry point all throw.

### Parallel Execution

Nodes whose dependencies are met in the same step run in parallel (up to `maxConcurrency`). A workflow must have a single root: several nodes without `after` make `build()` throw (or set one with `.entryPoint(name)`), so start a workflow with `addParallel` when its first steps are independent — a root `addParallel` becomes the entry point:

```typescript
interface MultiSearchState extends WorkflowState {
  query: string;
  webResults?: string;
  papers?: string;
  codeExamples?: string;
  combined?: string;
}

const parallelWorkflow = new WorkflowBuilder<MultiSearchState>('multi-source-research')
  .initialState({ query: '' })
  // fan-out: run the three searches in parallel
  .addParallel('fan-out', ['search-web', 'search-papers', 'search-code'])
  .addNode(
    'search-web',
    agentNode(webSearchAgent, {
      inputMapper: (state) => `Search web for: ${state.query}`,
      stateMapper: (result) => ({ webResults: result.output }),
    })
  )
  .addNode(
    'search-papers',
    agentNode(academicSearchAgent, {
      inputMapper: (state) => `Search academic papers for: ${state.query}`,
      stateMapper: (result) => ({ papers: result.output }),
    })
  )
  .addNode(
    'search-code',
    agentNode(codeSearchAgent, {
      inputMapper: (state) => `Search GitHub for: ${state.query}`,
      stateMapper: (result) => ({ codeExamples: result.output }),
    })
  )
  // fan-in: wait for all three before combining
  .addNode(
    'combine',
    agentNode(synthesizerAgent, {
      inputMapper: (state) => `
      Combine these sources:
      Web: ${state.webResults}
      Papers: ${state.papers}
      Code: ${state.codeExamples}
    `,
      stateMapper: (result) => ({ combined: result.output }),
    }),
    { after: ['search-web', 'search-papers', 'search-code'] }
  )
  .build();
```

`addParallel(name, targets, { after })` can also fan out from the middle of a graph.

### Conditional Branching

Use `addConditional` to route based on state. The condition returns one node name or an array of names; only nodes that list the conditional in their `after` can be targets.

```typescript
import { customNode } from '@cogitator-ai/workflows';

interface ReviewState extends WorkflowState {
  code: string;
  hasIssues?: boolean;
  fixedCode?: string;
  approved?: boolean;
}

const codeReviewWorkflow = new WorkflowBuilder<ReviewState>('code-review')
  .initialState({ code: '' })
  .addNode(
    'analyze',
    agentNode(codeAnalyzerAgent, {
      inputMapper: (state) => state.code,
      stateMapper: (result) => ({ hasIssues: result.output.includes('issue') }),
    })
  )
  .addConditional('route', (state) => (state.hasIssues ? 'fix-issues' : 'approve'), {
    after: ['analyze'],
  })
  .addNode(
    'fix-issues',
    agentNode(coderAgent, {
      inputMapper: (state) => `Fix issues in: ${state.code}`,
      stateMapper: (result) => ({ fixedCode: result.output }),
    }),
    { after: ['route'] }
  )
  .addNode(
    'approve',
    customNode<ReviewState>('approve', async () => ({
      state: { approved: true },
      output: { approved: true },
    })),
    { after: ['route'] }
  )
  .addNode(
    'finalize',
    agentNode(reviewerAgent, {
      inputMapper: (state) => `Final review of: ${state.fixedCode ?? state.code}`,
    }),
    { after: ['fix-issues', 'approve'] }
  )
  .build();
```

`finalize` runs once, after whichever branch was taken.

### Loops

Use `addLoop` to repeat part of the graph. After the nodes in `after` finish, `condition(state)` is evaluated against the current workflow state: `true` routes to `back`, `false` to `exit`. Only the `back` and `exit` nodes may list the loop in their `after`.

Mappers only see what they are given — `agentNode`'s `stateMapper` receives the agent's `RunResult`, not the state — so state-dependent updates such as an iteration counter belong in a `customNode`, which gets the full context:

```typescript
interface WritingState extends WorkflowState {
  topic: string;
  draft?: string;
  score?: number;
  iteration: number;
}

const refinementWorkflow = new WorkflowBuilder<WritingState>('iterative-writing')
  .initialState({ topic: '', iteration: 0 })
  .addNode(
    'draft',
    agentNode(writerAgent, {
      inputMapper: (state) => `Write about: ${state.topic}`,
      stateMapper: (result) => ({ draft: result.output }),
    })
  )
  .addNode(
    'evaluate',
    agentNode(criticAgent, {
      inputMapper: (state) => `Score this draft 1-10, reply with the number only:\n${state.draft}`,
      stateMapper: (result) => ({ score: Number.parseInt(result.output, 10) }),
    }),
    { after: ['draft', 'count'] }
  )
  .addLoop('check', {
    condition: (state) => (state.score ?? 0) < 8 && state.iteration < 5,
    back: 'refine',
    exit: 'finalize',
    after: ['evaluate'],
  })
  .addNode(
    'refine',
    agentNode(writerAgent, {
      inputMapper: (state) => `Improve this draft:\n${state.draft}`,
      stateMapper: (result) => ({ draft: result.output }),
    }),
    { after: ['check'] }
  )
  .addNode(
    'count',
    customNode<WritingState>('count', async (ctx) => ({
      state: { iteration: ctx.state.iteration + 1 },
    })),
    { after: ['refine'] }
  )
  .addNode(
    'finalize',
    customNode<WritingState>('finalize', async (ctx) => ({ output: ctx.state.draft })),
    { after: ['check'] }
  )
  .build();
```

The run stops with an error once it exceeds `maxIterations` scheduling steps (default 100), so a loop whose condition never turns false cannot spin forever.

### Subworkflows

Run another workflow as a step with `subworkflowNode` + `subworkflowWorkflowNode`. `inputMapper` builds the child's input from the parent state; `outputMapper` receives the child result and the parent state and returns the new parent state:

```typescript
import { subworkflowNode, subworkflowWorkflowNode } from '@cogitator-ai/workflows';

interface ArticleState extends WorkflowState {
  topic: string;
  research?: string;
}

const articleWorkflow = new WorkflowBuilder<ArticleState>('article')
  .initialState({ topic: '' })
  .addNode(
    'research',
    subworkflowWorkflowNode(
      subworkflowNode<ArticleState, ResearchState>('research', {
        workflow: researchWorkflow,
        inputMapper: (parent) => ({ topic: parent.topic }),
        outputMapper: (child, parent) => ({ ...parent, research: child.state.summary }),
        onError: 'propagate', // 'catch' | 'retry' | 'ignore'
        maxDepth: 5,
      })
    )
  )
  .build();
```

`simpleSubworkflow`, `nestedSubworkflow`, `conditionalSubworkflow` and the parallel variants (`parallelSubworkflows`, `fanOutFanIn`, `scatterGather`, `raceSubworkflows`, `fallbackSubworkflows`) are covered on the [patterns page](https://cogitator.app/docs/workflows/patterns).

---

## Node Types

`addNode(name, node, options?)` takes a node function `(ctx) => Promise<NodeResult>` or a `WorkflowNode` created by a factory. Timer, human, map-reduce and subworkflow helpers return configurations; wrap them with their adapter (`timerWorkflowNode`, `humanWorkflowNode`, `mapReduceWorkflowNode`, `subworkflowWorkflowNode`, ...) before adding them.

### Agent Node

Runs an agent through the executor's `Cogitator`:

```typescript
import { agentNode } from '@cogitator-ai/workflows';

const node = agentNode<MyState>(myAgent, {
  // state (and the dependency output) → agent input; defaults to ctx.input or the JSON state
  inputMapper: (state, input) => `Process: ${state.data}`,

  // agent RunResult → state update
  stateMapper: (result) => ({ processed: result.output }),

  // extra Cogitator.run options (threadId, timeout, context, reasoning, ...)
  runOptions: { timeout: 60_000 },
});

builder.addNode('my-step', node);
```

The node's output is the agent's `result.output`; the run's abort signal is passed to `cog.run`.

### Tool Node

Runs a tool directly, without an agent:

```typescript
import { tool } from '@cogitator-ai/core';
import { toolNode } from '@cogitator-ai/workflows';
import { z } from 'zod';

const webFetchTool = tool({
  name: 'web_fetch',
  description: 'Fetch a URL',
  parameters: z.object({ url: z.string() }),
  execute: async ({ url }) => (await fetch(url)).text(),
});

const node = toolNode<MyState, { url: string }>(webFetchTool, {
  argsMapper: (state) => ({ url: state.sourceUrl }),
  stateMapper: (result) => ({ content: String(result) }),
});

builder.addNode('fetch-data', node);
```

### Function Node

Runs an async function of `(state, input)`; its return value becomes the node output:

```typescript
import { functionNode } from '@cogitator-ai/workflows';

const node = functionNode<MyState>('transform', async (state) => normalizeData(state.rawData), {
  stateMapper: (output) => ({ normalizedData: output as string[] }),
});

builder.addNode('transform', node);
```

### Custom Node

Full control over context and result:

```typescript
import { customNode } from '@cogitator-ai/workflows';

const node = customNode<CounterState>('my-node', async (ctx) => {
  // ctx.state — copy of the current workflow state
  // ctx.input — output of the dependency node (array if there are several)
  // ctx.nodeId, ctx.workflowId, ctx.step
  // ctx.reportProgress?.(0-100)

  return {
    state: { counter: ctx.state.counter + 1 },
    output: 'done',
    // next: 'specific-node', // override edge routing
  };
});

builder.addNode('my-node', node);
```

At run time the context is an `ExtendedNodeContext` that also carries `cogitator`, the run's abort `signal`, the subworkflow `depth` and the run-level `approvalStore` / `approvalNotifier` / `timerStore`.

### Node Config: Timeouts and Retries

Every node accepts a `NodeConfig` through `addNode(..., { config })`:

```typescript
builder.addNode('call-api', callApiNode, {
  after: ['prepare'],
  config: { timeout: 10_000, retries: 3, retryDelay: 1_000 },
});
```

`timeout` applies per attempt and aborts `ctx.signal` (throwing `NodeTimeoutError`); `retries` adds that many attempts, `retryDelay` ms apart.

### Timer / Delay Nodes

```typescript
import {
  Duration,
  cronWaitNode,
  delayNode,
  dynamicDelayNode,
  timerWorkflowNode,
  untilNode,
} from '@cogitator-ai/workflows';

// fixed delay
builder.addNode('wait-5s', timerWorkflowNode(delayNode('wait-5s', Duration.seconds(5))));

// delay computed from state
builder.addNode(
  'wait-dynamic',
  timerWorkflowNode(dynamicDelayNode<MyState>('wait-dynamic', (state) => state.retryDelay))
);

// wait until the next cron occurrence
builder.addNode(
  'wait-daily',
  timerWorkflowNode(cronWaitNode('wait-daily', '0 9 * * *', { timezone: 'America/New_York' }))
);

// wait until a date from state
builder.addNode(
  'wait-until',
  timerWorkflowNode(untilNode<MyState>('wait-until', (state) => state.publishAt))
);
```

The wait is cancelled when the run is aborted. With `persist: true` in the timer config and a `timerStore` (node option or the `timerStore` execute option), the timer is also recorded in the store — `InMemoryTimerStore`, `FileTimerStore`, `RedisTimerStore` or `PostgresTimerStore` — where a `TimerManager` can pick up overdue timers.

### Human-in-the-Loop Nodes

```typescript
import {
  InMemoryApprovalStore,
  approvalNode,
  choiceNode,
  humanWorkflowNode,
  inputNode,
} from '@cogitator-ai/workflows';

interface ExpenseState extends WorkflowState {
  amount: number;
  managerEmail: string;
  reviewerEmail: string;
  approved?: boolean;
}

// approve/reject
const approval = approvalNode<ExpenseState>('manager-approval', {
  title: 'Approve expense report',
  description: (state) => `Amount: $${state.amount}`,
  assignee: (state) => state.managerEmail,
  timeout: 24 * 60 * 60 * 1000, // 24h
  timeoutAction: 'reject',
  priority: 'normal',
});

// multi-choice
const choice = choiceNode<ExpenseState>('select-route', {
  title: 'Choose processing route',
  choices: [
    { id: 'fast', label: 'Fast', value: 'fast' },
    { id: 'thorough', label: 'Thorough', value: 'thorough' },
  ],
  assignee: 'ops@company.com',
});

// free-form input
const feedback = inputNode<ExpenseState>('get-feedback', {
  title: 'Provide feedback on the draft',
  assignee: (state) => state.reviewerEmail,
});

const expenseWorkflow = new WorkflowBuilder<ExpenseState>('expense')
  .initialState({ amount: 0, managerEmail: '', reviewerEmail: '' })
  .addNode(
    'manager-approval',
    humanWorkflowNode(approval, {
      stateMapper: (result) => ({ approved: result.approved }),
    })
  )
  .build();

const approvalStore = new InMemoryApprovalStore();
const run = executor.execute(
  expenseWorkflow,
  { amount: 420, managerEmail: 'manager@company.com', reviewerEmail: 'qa@company.com' },
  { approvalStore }
);

// elsewhere: answer the pending request
const [pending] = await approvalStore.getPendingForAssignee('manager@company.com');
await approvalStore.submitResponse({
  requestId: pending.id,
  decision: true, // 'approve-reject' accepts true or 'approve'
  respondedBy: 'manager@company.com',
  respondedAt: Date.now(),
});

const { state } = await run;
```

The node's output is `{ approved, decision, timedOut, escalated }`. `ratingNode`, `chainNode` and `managementChain` (sequential approvers) work the same way, and `approvalNotifier` (`ConsoleNotifier`, `WebhookNotifier`, `slackNotifier`, ...) is told about new requests. The first answer wins: a second `submitResponse` for the same request throws `ApprovalAlreadyAnsweredError` (`submitOrExisting` returns the answer that stands instead). Deleting a pending request releases its waiters with a withdrawn answer (`respondedBy: WITHDRAWN`), which counts as not approved.

---

## Execution

### WorkflowExecutor

```typescript
import { WorkflowExecutor } from '@cogitator-ai/workflows';

const executor = new WorkflowExecutor(cog); // optional 2nd argument: a CheckpointStore

const controller = new AbortController();

const result = await executor.execute(
  researchWorkflow,
  { topic: 'WebGPU' }, // merged over the workflow's initialState
  {
    maxConcurrency: 4, // parallel nodes limit (default 4)
    maxIterations: 100, // scheduling steps limit (default 100)
    checkpoint: true, // save checkpoints (default false)
    checkpointStrategy: 'per-node', // 'per-iteration' (default) | 'per-node'
    signal: controller.signal, // abort the run; passed to nodes as ctx.signal
    onNodeStart: (node) => console.log(`Starting: ${node}`),
    onNodeComplete: (node, output, duration) => console.log(`Done: ${node} (${duration}ms)`),
    onNodeError: (node, error) => console.error(`Failed: ${node}`, error),
    onNodeProgress: (node, progress) => console.log(`${node}: ${progress}%`),
  }
);

console.log(result.state); // final workflow state
console.log(result.nodeResults); // Map<nodeName, { output, duration }>
console.log(result.workflowId);
console.log(result.duration);
console.log(result.error); // set if the workflow failed

// resume from the last checkpoint
if (result.checkpointId) {
  const resumed = await executor.resume(researchWorkflow, result.checkpointId);
}

// stream events
for await (const event of executor.stream(researchWorkflow, { topic: 'WebGPU' })) {
  if (event.type === 'node_started') console.log(`Starting: ${event.nodeName}`);
  if (event.type === 'node_completed') console.log(`Done: ${event.nodeName}`);
  if (event.type === 'workflow_completed') console.log('Done!', event.result.state);
}
```

Other execute options: `workflowId`, `tracer`, `metricsCollector`, `defaultRetry`, `defaultCircuitBreaker`, `deadLetterQueue`, `idempotencyStore`, `approvalStore`, `approvalNotifier` and `timerStore` (see [Error Handling](#error-handling) and [Observability](#observability)).

### WorkflowResult

```typescript
interface WorkflowResult<S = WorkflowState> {
  workflowId: string;
  workflowName: string;
  state: S; // final state
  nodeResults: Map<string, { output: unknown; duration: number }>;
  duration: number; // total ms
  checkpointId?: string; // last checkpoint, if checkpointing was enabled
  error?: Error; // if execution failed
}
```

### NodeContext

The context object passed to every node function:

```typescript
interface NodeContext<S = WorkflowState> {
  state: S; // current workflow state
  input?: unknown; // output(s) of dependency nodes
  nodeId: string;
  workflowId: string;
  step: number; // scheduling step
  reportProgress?: (progress: number) => void; // 0-100
}
```

When a node has several dependencies, `ctx.input` is an array of their outputs; with one dependency it is that output directly.

---

## Checkpointing

Persist workflow progress so a failed or interrupted run can continue:

```typescript
import {
  FileCheckpointStore,
  InMemoryCheckpointStore,
  PostgresCheckpointStore,
  RedisCheckpointStore,
  WorkflowExecutor,
} from '@cogitator-ai/workflows';

// in-memory (the default)
const memoryExecutor = new WorkflowExecutor(cog, new InMemoryCheckpointStore());

// file-based, for a single process
const fileExecutor = new WorkflowExecutor(cog, new FileCheckpointStore('./checkpoints'));

// Redis (@cogitator-ai/redis client or ioredis) or Postgres (pg Pool), for several processes
const redisExecutor = new WorkflowExecutor(cog, new RedisCheckpointStore({ client: redis }));
const pgExecutor = new WorkflowExecutor(cog, new PostgresCheckpointStore({ client: pool }));

const result = await pgExecutor.execute(workflow, input, {
  checkpoint: true,
  checkpointStrategy: 'per-node', // save after each node instead of after each step
});

// resume: completed nodes are skipped, the rest run with the saved state
if (result.error && result.checkpointId) {
  const resumed = await pgExecutor.resume(workflow, result.checkpointId);
}
```

### Durable Run, Approval, Timer and Checkpoint Stores

For several processes, keep everything in Redis or Postgres. Each store takes the client you already have and creates its tables on first use:

| Store      | Redis                  | Postgres                  |
| ---------- | ---------------------- | ------------------------- |
| Checkpoint | `RedisCheckpointStore` | `PostgresCheckpointStore` |
| Run        | `RedisRunStore`        | `PostgresRunStore`        |
| Approval   | `RedisApprovalStore`   | `PostgresApprovalStore`   |
| Timer      | `RedisTimerStore`      | `PostgresTimerStore`      |

Approvals answered in another process reach the waiting node through polling (`pollInterval`, default 1000 ms), and the first answer wins. Timer stores claim the overdue timers they return for `claimTtl` ms, so several `TimerManager`s polling one store fire each timer once; the manager renews a claim while its handler runs and releases timers it has no handler for. Details: [execution docs](https://cogitator.app/docs/workflows/execution).

---

## Error Handling

When a node throws, the run stops and `result.error` holds the node's error; `onNodeError` receives the node name:

```typescript
let failedNode: string | undefined;

const result = await executor.execute(workflow, input, {
  onNodeError: (node, error) => {
    failedNode = node;
    alertService.notify({ node, error: error.message });
  },
});

if (result.error) {
  console.error(`Workflow failed at ${failedNode}:`, result.error.message);
}
```

### Run-wide Retries, Circuit Breaker, DLQ and Idempotency

```typescript
import { createInMemoryDLQ, createInMemoryIdempotencyStore } from '@cogitator-ai/workflows';

const breakerConfig = { threshold: 5, resetTimeout: 30_000 }; // reuse the object: one breaker per node name

const result = await executor.execute(workflow, input, {
  // nodes without their own config.retries
  defaultRetry: { maxRetries: 3, backoff: 'exponential', initialDelay: 1000, maxDelay: 30_000 },
  defaultCircuitBreaker: breakerConfig,
  deadLetterQueue: createInMemoryDLQ(), // gets an entry for every node that finally failed
  idempotencyStore: createInMemoryIdempotencyStore(), // reuse results for the same workflowId + node + step
});
```

### Retry and Circuit Breaker Inside a Node

The saga utilities also work on their own:

```typescript
import { CircuitBreaker, customNode, executeWithRetry } from '@cogitator-ai/workflows';

const circuitBreaker = new CircuitBreaker({ threshold: 5, resetTimeout: 30_000 });

const node = customNode<ApiState>('call-api', async (ctx) => {
  const retry = await executeWithRetry(
    () => circuitBreaker.execute('external-api', () => callExternalAPI(ctx.state.url)),
    {
      maxRetries: 3,
      backoff: 'exponential',
      initialDelay: 1000,
      maxDelay: 30_000,
      isRetryable: (error) => error.message.includes('TIMEOUT'),
    }
  );
  if (!retry.success) throw retry.error;
  return { output: retry.result };
});
```

`executeWithRetry` resolves to `{ success, result, error, attempts, totalDuration, delays }` instead of throwing; an open breaker throws `CircuitBreakerOpenError`. See the [sagas page](https://cogitator.app/docs/workflows/sagas).

### Saga / Compensation Pattern

Use `CompensationManager` to register compensations and roll back on failure:

```typescript
import { CompensationManager, customNode } from '@cogitator-ai/workflows';

const compensation = new CompensationManager<OrderState>();

const reserveNode = customNode<OrderState>('reserve-inventory', async (ctx) => {
  const reservation = await inventoryService.reserve(ctx.state.items);

  compensation.registerCompensation('reserve-inventory', async (_state, originalResult) => {
    const res = originalResult as { id: string };
    await inventoryService.release(res.id);
  });
  compensation.markCompleted('reserve-inventory', reservation);

  return { state: { reservationId: reservation.id }, output: reservation };
});

const chargeNode = customNode<OrderState>('charge-payment', async (ctx) => {
  const charge = await paymentService.charge(ctx.state.amount);

  compensation.registerCompensation('charge-payment', async (_state, originalResult) => {
    const c = originalResult as { id: string };
    await paymentService.refund(c.id);
  });
  compensation.markCompleted('charge-payment', charge);

  return { state: { chargeId: charge.id }, output: charge };
});

// on failure, run the compensations of the completed nodes (reverse order by default)
let failedNode = 'unknown';
const result = await executor.execute(orderWorkflow, input, {
  onNodeError: (node) => {
    failedNode = node;
  },
});
if (result.error) {
  const report = await compensation.compensate(result.state, failedNode, result.error);
  console.log(report.allSuccessful, report.partialFailures);
}
```

Create one `CompensationManager` per run when runs can overlap.

---

## Workflow Patterns

### Map-Reduce

Process items in parallel, then combine:

```typescript
import { mapReduceNode, mapReduceWorkflowNode } from '@cogitator-ai/workflows';

interface DocState extends WorkflowState {
  documents: string[];
  analyses?: string[];
  report?: string;
}

const analyzeDocuments = mapReduceNode<DocState, string, string[]>('analyze-documents', {
  map: {
    items: (state) => state.documents,
    mapper: async (doc) => {
      const result = await cog.run(analyzerAgent, { input: `Analyze: ${String(doc)}` });
      return result.output;
    },
    concurrency: 10,
    continueOnError: false,
  },
  reduce: {
    initial: [],
    reducer: (acc, item) => (item.success ? [...acc, item.result] : acc),
  },
});

const docWorkflow = new WorkflowBuilder<DocState>('analyze-documents')
  .initialState({ documents: [] })
  .addNode(
    'analyze-documents',
    mapReduceWorkflowNode(analyzeDocuments, {
      stateMapper: (result) => ({ analyses: result.reduced }),
    })
  )
  .addNode(
    'report',
    agentNode(summarizerAgent, {
      inputMapper: (state) => `Combine these analyses:\n${state.analyses?.join('\n---\n')}`,
      stateMapper: (result) => ({ report: result.output }),
    }),
    { after: ['analyze-documents'] }
  )
  .build();
```

`executeMapReduce(state, config)` runs the same config outside a workflow; built-in reducers (`collect`, `sum`, `count`, `groupBy`, `stats`, ...) are on the [patterns page](https://cogitator.app/docs/workflows/patterns).

### Event-Driven (Webhooks & Cron)

`TriggerManager` keeps triggers and calls `onTriggerFire` when one fires; start the workflow there:

```typescript
import {
  createTriggerManager,
  createWorkflowManager,
  cronTrigger,
  webhookTrigger,
} from '@cogitator-ai/workflows';

const manager = createWorkflowManager({ cogitator: cog });
manager.start();

const workflows = { 'pr-review': prReviewWorkflow, 'daily-report': dailyReportWorkflow };

const triggerManager = createTriggerManager({
  onTriggerFire: (trigger, context) =>
    manager.schedule(workflows[trigger.workflowName as keyof typeof workflows], {
      input: { payload: context.payload },
      triggerId: trigger.id,
    }),
});
triggerManager.start(); // register / fire / handleWebhook throw until started

const webhookId = await triggerManager.register({
  workflowName: 'pr-review',
  type: 'webhook',
  config: webhookTrigger('/github/pr', 'POST', { auth: { type: 'hmac', secret: 'whsec' } }),
  enabled: true,
});

await triggerManager.register({
  workflowName: 'daily-report',
  type: 'cron',
  config: cronTrigger('0 9 * * *', { timezone: 'America/New_York' }),
  enabled: true,
});

// from your HTTP server; null when no webhook trigger matches the method and path
const handled = await triggerManager.handleWebhook({
  method: 'POST',
  path: '/github/pr',
  headers: req.headers,
  body: req.body,
});
const response = handled?.response ?? { status: 404 };

// or fire a trigger manually
await triggerManager.fire(webhookId, { payload: { pull_request: { number: 42 } } });
```

Event triggers (`eventTrigger`, `emitEvent`), rate limiting and webhook auth are on the [scheduling page](https://cogitator.app/docs/workflows/scheduling).

### Approval Chain

Multi-stage human approvals with `managementChain` (manager → director → VP):

```typescript
import { humanWorkflowNode, managementChain } from '@cogitator-ai/workflows';

interface ChainState extends WorkflowState {
  amount: number;
  description: string;
  approved?: boolean;
}

const expenseChain = managementChain<ChainState>('expense-approval', {
  title: 'Expense approval',
  description: (state) => `$${state.amount}: ${state.description}`,
  manager: 'manager@company.com',
  director: 'director@company.com',
  timeoutPerStep: 24 * 60 * 60 * 1000,
});

builder.addNode(
  'expense-approval',
  humanWorkflowNode(expenseChain, {
    stateMapper: (result) => ({ approved: result.approved }),
  })
);
```

Each step creates its own request; the chain is approved only if every required step approves. For approvers that depend on state, build the config inside a `customNode` and call `executeHumanNode(ctx.state, config, { workflowId, runId, nodeId, approvalStore })`.

---

## Workflow Manager

`DefaultWorkflowManager` (from `createWorkflowManager`) adds run tracking, scheduling, retries and replays on top of the executor:

```typescript
import { PostgresRunStore, createWorkflowManager } from '@cogitator-ai/workflows';

const manager = createWorkflowManager({
  cogitator: cog,
  runStore: new PostgresRunStore({ client: pool }), // default: InMemoryRunStore
  checkpointStore: new PostgresCheckpointStore({ client: pool }), // enables checkpoints and replay
  maxConcurrency: 4,
  defaultTimeout: 10 * 60 * 1000, // fail runs that take longer
  onRunStateChange: (run) => console.log(`Run ${run.id}: ${run.status}`),
});

manager.start(); // process scheduled runs

// execute immediately (accepts every execute option plus priority, tags, metadata, tracing)
const result = await manager.execute(
  researchWorkflow,
  { topic: 'WebGPU' },
  { priority: 10, tags: ['production'] }
);

// schedule for later
const runId = await manager.schedule(researchWorkflow, {
  at: Date.now() + 60 * 60 * 1000, // 1 hour from now
  input: { topic: 'WebGPU' },
});

// or at the next cron occurrence (one run; use a cron trigger for recurring runs)
const runId2 = await manager.schedule(researchWorkflow, {
  cron: '0 9 * * *',
  timezone: 'America/New_York',
});

// inspect runs
const run = await manager.getStatus(runId);
const runs = await manager.listRuns({ status: 'running', workflowName: 'research-topic' });
const stats = await manager.getStats('research-topic');

await manager.cancel(runId2, 'User cancelled');

const newRunId = await manager.retry(failedRunId); // failed or cancelled run, scheduled again
const replayed = await manager.replay(researchWorkflow, failedRunId, 'analyze'); // re-run from a node

await manager.cleanup(7 * 24 * 60 * 60 * 1000); // delete finished runs older than 7 days (an age in ms)

const unsubscribe = manager.onRunStateChange((r) => console.log(`${r.workflowName} → ${r.status}`));

manager.stop();
```

`replay` needs a run that saved a checkpoint (a `checkpointStore` on the manager). `pause(runId)` aborts a running run and marks it `paused`; `resume(runId)` only sets the status back to `running` and does not restart execution — continue a run with `replay` or `retry` instead.

---

## Observability

### Streaming Events

```typescript
for await (const event of executor.stream(workflow, input)) {
  switch (event.type) {
    case 'workflow_started':
      console.log(`Workflow ${event.workflowName} started`);
      break;
    case 'node_started':
      console.log(`Node ${event.nodeName} started`);
      break;
    case 'node_progress':
      console.log(`Node ${event.nodeName}: ${event.progress}%`);
      break;
    case 'node_completed':
      console.log(`Node ${event.nodeName} completed in ${event.duration}ms`);
      break;
    case 'node_error':
      console.error(`Node ${event.nodeName} failed:`, event.error);
      break;
    case 'workflow_completed':
      console.log(`Workflow completed in ${event.duration}ms`);
      console.log('Final state:', event.result.state);
      break;
  }
}
```

### Callbacks

```typescript
const result = await executor.execute(workflow, input, {
  onNodeStart: (node) => metrics.increment('node.started', { node }),
  onNodeComplete: (node, output, duration) => {
    metrics.histogram('node.duration', duration, { node });
  },
  onNodeError: (node, error) => {
    alerting.fire({ node, error: error.message });
  },
  onNodeProgress: (node, progress) => {
    dashboard.update({ node, progress });
  },
});
```

### OpenTelemetry Tracing

Create a tracer and pass it to a run (or to the manager): it emits a workflow span and one span per node execution.

```typescript
import { createTracer } from '@cogitator-ai/workflows';

const tracer = createTracer({
  serviceName: 'my-workflow-service',
  exporter: 'otlp', // 'console' (default) | 'otlp' | 'jaeger' | 'zipkin' | 'noop'
  exporterEndpoint: 'http://otel-collector:4318/v1/traces',
  sampleRate: 1,
});

await executor.execute(workflow, input, { tracer });

const tracedManager = createWorkflowManager({ cogitator: cog, tracer });
await tracedManager.execute(workflow, input, {
  tracing: { enabled: true, exporter: 'console' }, // per-run tracer instead of the manager's
});
```

### Metrics

```typescript
import { createMetricsCollector } from '@cogitator-ai/workflows';

const metricsCollector = createMetricsCollector({ enabled: true, prefix: 'cogitator' });

await executor.execute(workflow, input, { metricsCollector });
// or: createWorkflowManager({ cogitator: cog, metrics: metricsCollector })

const workflowMetrics = metricsCollector.getWorkflowMetrics('research-topic');
console.log(workflowMetrics?.latency.p99);
```

`setGlobalTracer` / `setGlobalMetrics` only store an instance for `getGlobalTracer()` / `getGlobalMetrics()`; the executor and manager use the tracer and collector you pass them.

---

## API Reference

### WorkflowBuilder

```typescript
class WorkflowBuilder<S extends WorkflowState = WorkflowState> {
  constructor(name: string);

  initialState(state: S): this;
  entryPoint(nodeName: string): this;

  addNode(name: string, node: NodeFn<S> | WorkflowNode<S>, options?: AddNodeOptions): this;
  addConditional(
    name: string,
    condition: (state: S) => string | string[],
    options?: AddConditionalOptions // { after?: string[] }
  ): this;
  addLoop(name: string, options: AddLoopOptions<S>): this;
  addParallel(name: string, targets: string[], options?: AddParallelOptions): this;

  build(): Workflow<S>;
}

interface AddNodeOptions {
  after?: string[]; // node names this node depends on
  config?: NodeConfig; // { timeout?, retries?, retryDelay? }
}

interface AddLoopOptions<S> {
  condition: (state: S) => boolean; // true = loop back
  back: string; // node to go back to
  exit: string; // node to go to when done
  after?: string[];
}
```

### WorkflowExecutor

```typescript
class WorkflowExecutor {
  constructor(cogitator: Cogitator, checkpointStore?: CheckpointStore);

  execute<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: ExecutorExecuteOptions
  ): Promise<WorkflowResult<S>>;

  resume<S extends WorkflowState>(
    workflow: Workflow<S>,
    checkpointId: string,
    options?: WorkflowExecuteOptions
  ): Promise<WorkflowResult<S>>;

  stream<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: Omit<
      WorkflowExecuteOptions,
      'onNodeStart' | 'onNodeComplete' | 'onNodeError' | 'onNodeProgress'
    >
  ): AsyncIterable<StreamingWorkflowEvent>;
}

interface WorkflowExecuteOptions {
  maxConcurrency?: number; // default: 4
  maxIterations?: number; // default: 100
  checkpoint?: boolean; // default: false
  checkpointStrategy?: 'per-iteration' | 'per-node'; // default: 'per-iteration'
  workflowId?: string;
  onNodeStart?: (node: string) => void;
  onNodeComplete?: (node: string, result: unknown, duration: number) => void;
  onNodeError?: (node: string, error: Error) => void;
  onNodeProgress?: (node: string, progress: number) => void;
}

interface ExecutorExecuteOptions extends WorkflowExecuteOptions {
  signal?: AbortSignal;
  tracer?: WorkflowTracer;
  metricsCollector?: WorkflowMetricsCollector;
  defaultRetry?: RetryConfig;
  defaultCircuitBreaker?: CircuitBreakerConfig;
  deadLetterQueue?: DeadLetterQueue;
  idempotencyStore?: IdempotencyStore;
  approvalStore?: ApprovalStore;
  approvalNotifier?: ApprovalNotifier;
  timerStore?: TimerStore;
}
```

### Workflow (type)

The `Workflow` type is a plain data object (not a class):

```typescript
interface Workflow<S = WorkflowState> {
  name: string;
  initialState: S;
  nodes: Map<string, WorkflowNode<S>>;
  edges: Edge[]; // sequential | conditional | parallel | loop
  entryPoint: string;
}
```

### NodeResult

```typescript
interface NodeResult<S = WorkflowState> {
  state?: Partial<S>; // state updates to merge in
  output?: unknown; // value passed as ctx.input to dependent nodes
  next?: string | string[]; // override routing (optional)
}
```
