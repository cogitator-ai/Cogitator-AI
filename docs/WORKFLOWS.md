# Workflows

> DAG-based orchestration for multi-step agent tasks

## Overview

Workflows allow you to orchestrate complex, multi-step tasks with:

- **Directed Acyclic Graphs (DAGs)** — Define dependencies between nodes
- **State Management** — Pass typed state between nodes
- **Parallel Execution** — Run independent nodes concurrently
- **Conditional Routing** — Branch based on state
- **Loops** — Iterate until a condition is met
- **Checkpointing** — Survive restarts by saving progress
- **Human-in-the-Loop** — Pause for approvals or input

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Workflow Engine                                     │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Workflow Definition                             │   │
│   │                                                                         │   │
│   │   ┌─────┐      ┌─────┐      ┌─────┐      ┌─────┐                       │   │
│   │   │Node1│─────►│Node2│─────►│Node3│─────►│Node4│                       │   │
│   │   └─────┘      └──┬──┘      └─────┘      └─────┘                       │   │
│   │                   │                                                     │   │
│   │                   └────────►┌─────┐                                    │   │
│   │                             │Node5│ (parallel branch)                  │   │
│   │                             └─────┘                                    │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Execution Engine                                │   │
│   │                                                                         │   │
│   │   WorkflowBuilder  │  WorkflowExecutor  │  WorkflowManager             │   │
│   │                                                                         │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Creating Workflows

Workflows are built with `WorkflowBuilder` and executed with `WorkflowExecutor`.

### Basic Workflow

```typescript
import { WorkflowBuilder, WorkflowExecutor, agentNode } from '@cogitator-ai/workflows';
import { Cogitator } from '@cogitator-ai/core';

interface ResearchState {
  topic: string;
  searchResults?: string;
  analysis?: string;
  summary?: string;
}

const cog = new Cogitator({ llm: { defaultModel: 'openai/gpt-4o' } });

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

### Parallel Execution

Nodes without dependencies (or with the same dependencies) run in parallel automatically. Use `addParallel` for explicit fan-out:

```typescript
const parallelWorkflow = new WorkflowBuilder<MultiSearchState>('multi-source-research')
  .initialState({ query: '' })
  // fan-out: execute a, b, c in parallel
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

### Conditional Branching

Use `addConditional` to route based on state:

```typescript
interface ReviewState {
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
      stateMapper: (result) => ({
        hasIssues: (result.output as string).includes('issue'),
      }),
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
    customNode('approve', async (ctx) => ({
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

### Loops

Use `addLoop` to iterate until a condition is met:

```typescript
interface WritingState {
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
      inputMapper: (state) => `Score this draft 1-10:\n${state.draft}`,
      stateMapper: (result) => ({
        score: parseInt(result.output as string, 10),
        iteration: state.iteration + 1,
      }),
    }),
    { after: ['draft'] }
  )
  .addNode(
    'refine',
    agentNode(writerAgent, {
      inputMapper: (state) => `Improve this draft:\n${state.draft}`,
      stateMapper: (result) => ({ draft: result.output }),
    }),
    { after: ['evaluate'] }
  )
  .addLoop('check', {
    condition: (state: WritingState) => (state.score ?? 0) < 8 && state.iteration < 5,
    back: 'evaluate',
    exit: 'finalize',
    after: ['refine'],
  })
  .addNode(
    'finalize',
    customNode('finalize', async (ctx) => ({
      output: ctx.state.draft,
    }))
  )
  .build();
```

---

## Node Types

### Agent Node

Runs a Cogitator agent as a workflow node:

```typescript
import { agentNode } from '@cogitator-ai/workflows';

const node = agentNode(myAgent, {
  // map state to agent input string
  inputMapper: (state, input) => `Process: ${state.data}`,

  // map agent result back to state
  stateMapper: (result) => ({ processed: result.output }),

  // additional run options
  runOptions: { temperature: 0.7 },
});

builder.addNode('my-step', node);
```

### Tool Node

Runs a tool directly, without an agent:

```typescript
import { toolNode } from '@cogitator-ai/workflows';

const node = toolNode(webFetchTool, {
  // map state to tool arguments
  argsMapper: (state) => ({ url: state.sourceUrl }),

  // map tool result to state
  stateMapper: (result) => ({ content: result }),
});

builder.addNode('fetch-data', node);
```

### Function Node

Runs a custom async function:

```typescript
import { functionNode } from '@cogitator-ai/workflows';

const node = functionNode(
  'transform',
  async (state: MyState, input) => {
    const raw = state.rawData;
    return normalizeData(raw);
  },
  {
    stateMapper: (output) => ({ normalizedData: output }),
  }
);

builder.addNode('transform', node);
```

### Custom Node

Full control over context and result:

```typescript
import { customNode } from '@cogitator-ai/workflows';

const node = customNode('my-node', async (ctx) => {
  // ctx.state — current workflow state
  // ctx.input — output(s) from dependency nodes
  // ctx.nodeId, ctx.workflowId, ctx.step
  // ctx.reportProgress(0-100)

  return {
    state: { counter: ctx.state.counter + 1 },
    output: 'done',
    // next: 'specific-node', // override routing
  };
});

builder.addNode('my-node', node);
```

### Timer / Delay Nodes

```typescript
import { delayNode, dynamicDelayNode, cronWaitNode } from '@cogitator-ai/workflows';

// fixed delay
const waitNode = delayNode('wait-5s', 5000);

// dynamic delay based on state
const dynamicWait = dynamicDelayNode('wait-dynamic', (state) => state.retryDelay);

// wait until next cron occurrence
const cronWait = cronWaitNode('wait-daily', '0 9 * * *', { timezone: 'America/New_York' });

builder.addNode('wait-5s', waitNode);
builder.addNode('wait-dynamic', dynamicWait);
```

### Human-in-the-Loop Nodes

```typescript
import { approvalNode, choiceNode, inputNode } from '@cogitator-ai/workflows';

// approve/reject
const approval = approvalNode('manager-approval', {
  title: 'Approve expense report',
  description: (state) => `Amount: $${state.amount}`,
  assignee: (state) => state.managerEmail,
  timeout: 24 * 60 * 60 * 1000, // 24h
  timeoutAction: 'reject',
  priority: 'normal',
});

// multi-choice
const choice = choiceNode('select-route', {
  title: 'Choose processing route',
  choices: [
    { id: 'fast', label: 'Fast', value: 'fast' },
    { id: 'thorough', label: 'Thorough', value: 'thorough' },
  ],
  assignee: 'ops@company.com',
});

// free-form input
const input = inputNode('get-feedback', {
  title: 'Provide feedback on the draft',
  assignee: (state) => state.reviewerEmail,
});

builder.addNode('manager-approval', approval);
```

---

## Execution

### WorkflowExecutor

```typescript
import { WorkflowExecutor, InMemoryCheckpointStore } from '@cogitator-ai/workflows';

const executor = new WorkflowExecutor(cogitator);

// execute
const result = await executor.execute(
  workflow,
  { topic: 'WebGPU' },
  {
    maxConcurrency: 4, // parallel nodes limit
    maxIterations: 100, // loop iteration limit
    checkpoint: true, // enable checkpointing
    checkpointStrategy: 'per-node', // 'per-iteration' | 'per-node'
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
console.log(result.error); // defined if workflow failed

// resume from checkpoint
const resumed = await executor.resume(workflow, result.checkpointId!);

// stream events
for await (const event of executor.stream(workflow, { topic: 'WebGPU' })) {
  if (event.type === 'node_started') console.log(`Starting: ${event.nodeName}`);
  if (event.type === 'node_completed') console.log(`Done: ${event.nodeName}`);
  if (event.type === 'workflow_completed') console.log('Done!', event.result.state);
}
```

### WorkflowResult

```typescript
interface WorkflowResult<S> {
  workflowId: string;
  workflowName: string;
  state: S; // final state
  nodeResults: Map<string, { output: unknown; duration: number }>;
  duration: number; // total ms
  checkpointId?: string; // if checkpointing enabled
  error?: Error; // if execution failed
}
```

### NodeContext

The context object passed to every node function:

```typescript
interface NodeContext<S> {
  state: S; // current workflow state
  input?: unknown; // output(s) from dependency nodes
  nodeId: string;
  workflowId: string;
  step: number; // iteration count
  reportProgress?: (progress: number) => void; // 0-100
}
```

When a node has multiple dependencies, `ctx.input` is an array of their outputs. For a single dependency, it's the output directly.

---

## Checkpointing

Persist workflow progress to survive restarts:

```typescript
import {
  WorkflowExecutor,
  InMemoryCheckpointStore,
  FileCheckpointStore,
} from '@cogitator-ai/workflows';

// in-memory (default, for testing)
const executor = new WorkflowExecutor(cogitator, new InMemoryCheckpointStore());

// file-based (for development/single-node)
const executor = new WorkflowExecutor(cogitator, new FileCheckpointStore('./checkpoints'));

// execute with checkpointing enabled
const result = await executor.execute(workflow, input, {
  checkpoint: true,
  checkpointStrategy: 'per-node', // save after each individual node completes
});

// resume a workflow from its checkpoint
if (result.checkpointId) {
  const resumed = await executor.resume(workflow, result.checkpointId);
}
```

---

## Error Handling

Errors in nodes are caught and surfaced in `result.error`. Use `onNodeError` to react during execution:

```typescript
const result = await executor.execute(workflow, input, {
  onNodeError: (node, error) => {
    alertService.notify({ node, error: error.message });
  },
});

if (result.error) {
  console.error('Workflow failed:', result.error.message);
}
```

### Retry with Circuit Breaker

Use the saga utilities for per-node retry and circuit breaking:

```typescript
import { executeWithRetry, CircuitBreaker } from '@cogitator-ai/workflows';

const circuitBreaker = new CircuitBreaker({
  threshold: 5,
  resetTimeout: 30_000,
});

const node = customNode('call-api', async (ctx) => {
  const result = await executeWithRetry(() => callExternalAPI(ctx.state.url), {
    maxRetries: 3,
    backoff: 'exponential',
    initialDelay: 1000,
    maxDelay: 30_000,
    isRetryable: (error) => error.message.includes('TIMEOUT'),
  });
  return { output: result };
});
```

### Saga / Compensation Pattern

Use `CompensationManager` to register compensations and roll back on failure:

```typescript
import { CompensationManager, customNode } from '@cogitator-ai/workflows';

const compensation = new CompensationManager();

const reserveNode = customNode('reserve-inventory', async (ctx) => {
  const reservation = await inventoryService.reserve(ctx.state.items);

  // register compensation before returning
  compensation.registerCompensation('reserve-inventory', async (state, originalResult) => {
    const res = originalResult as { reservationId: string };
    await inventoryService.release(res.reservationId);
  });

  compensation.markCompleted('reserve-inventory', reservation);
  return { state: { reservationId: reservation.id }, output: reservation };
});

const chargeNode = customNode('charge-payment', async (ctx) => {
  const charge = await paymentService.charge(ctx.state.amount);

  compensation.registerCompensation('charge-payment', async (state, originalResult) => {
    const c = originalResult as { chargeId: string };
    await paymentService.refund(c.chargeId);
  });

  compensation.markCompleted('charge-payment', charge);
  return { state: { chargeId: charge.id }, output: charge };
});

// on failure, run compensations in reverse order
const result = await executor.execute(orderWorkflow, input);
if (result.error) {
  await compensation.compensate(result.state, 'ship-order', result.error);
}
```

---

## Workflow Patterns

### Map-Reduce

Process items in parallel, then combine:

```typescript
import { executeMapReduce } from '@cogitator-ai/workflows';

interface DocState {
  documents: string[];
  analyses?: string[];
  report?: string;
}

const mapReduceNode = customNode('analyze-documents', async (ctx) => {
  const mapReduceResult = await executeMapReduce(ctx.state, {
    name: 'document-analysis',
    map: {
      items: (state) => state.documents,
      mapper: async (doc) => {
        const result = await analyzerAgent.run({ input: `Analyze: ${doc}` });
        return result.output;
      },
      concurrency: 10,
      continueOnError: false,
    },
    reduce: {
      initial: [] as string[],
      reducer: (acc, item) => [...acc, item.result as string],
    },
  });

  return {
    state: { analyses: mapReduceResult.reduced as string[] },
    output: mapReduceResult,
  };
});

const builder = new WorkflowBuilder<DocState>('analyze-documents')
  .initialState({ documents: [] })
  .addNode('analyze-documents', mapReduceNode)
  .addNode(
    'report',
    agentNode(summarizerAgent, {
      inputMapper: (state) => `Combine these analyses:\n${state.analyses?.join('\n---\n')}`,
      stateMapper: (result) => ({ report: result.output }),
    }),
    { after: ['analyze-documents'] }
  );
```

### Event-Driven (Webhooks & Cron)

Register triggers separately using `TriggerManager`:

```typescript
import {
  createTriggerManager,
  DefaultWorkflowManager,
  createWorkflowManager,
} from '@cogitator-ai/workflows';

const manager = createWorkflowManager({ cogitator });
manager.start();

const triggerManager = createTriggerManager({
  runStore: manager['runStore'],
});

// register a webhook trigger
const webhookId = await triggerManager.register({
  workflowName: 'pr-review',
  type: 'webhook',
  config: {
    path: '/github/pr',
    method: 'POST',
  },
  enabled: true,
});

// register a cron trigger
const cronId = await triggerManager.register({
  workflowName: 'daily-report',
  type: 'cron',
  config: {
    expression: '0 9 * * *',
    timezone: 'America/New_York',
    enabled: true,
  },
  enabled: true,
});

// fire a trigger manually
await triggerManager.fire(webhookId, { payload: { pull_request: { number: 42 } } });
```

### Approval Chain

Multi-stage human approvals:

```typescript
import { managementChain, executeHumanNode, InMemoryApprovalStore } from '@cogitator-ai/workflows';

const approvalStore = new InMemoryApprovalStore();

const expenseApprovalNode = customNode('expense-approval', async (ctx) => {
  const config = managementChain('expense-approval', {
    title: `Expense Approval: $${ctx.state.amount}`,
    description: (state) => `Description: ${state.description}`,
    manager: ctx.state.managerEmail,
    director: ctx.state.amount > 5000 ? ctx.state.directorEmail : undefined,
    timeoutPerStep: 24 * 60 * 60 * 1000,
  });

  const humanResult = await executeHumanNode(ctx.state, config, {
    workflowId: ctx.workflowId,
    runId: ctx.workflowId,
    nodeId: ctx.nodeId,
    approvalStore,
  });

  return {
    state: { approved: humanResult.approved },
    output: humanResult,
  };
});
```

---

## Workflow Manager

`DefaultWorkflowManager` provides run tracking, scheduling, retry, and more:

```typescript
import { createWorkflowManager, InMemoryRunStore, FileRunStore } from '@cogitator-ai/workflows';

const manager = createWorkflowManager({
  cogitator,
  runStore: new InMemoryRunStore(),
  maxConcurrency: 4,
  onRunStateChange: (run) => console.log(`Run ${run.id}: ${run.status}`),
});

manager.start();

// execute immediately
const result = await manager.execute(
  workflow,
  { topic: 'WebGPU' },
  {
    priority: 10,
    tags: ['production'],
  }
);

// schedule for later
const runId = await manager.schedule(workflow, {
  at: Date.now() + 60 * 60 * 1000, // 1 hour from now
  input: { topic: 'WebGPU' },
});

// or with cron
const runId2 = await manager.schedule(workflow, {
  cron: '0 9 * * *',
  timezone: 'America/New_York',
});

// manage runs
const run = await manager.getStatus(runId);
const runs = await manager.listRuns({ status: 'running', workflowName: 'research-topic' });
const stats = await manager.getStats('research-topic');

await manager.cancel(runId, 'User cancelled');
await manager.pause(runId);
await manager.resume(runId);

const newRunId = await manager.retry(runId); // retry a failed run
const replayed = await manager.replay(workflow, runId, 'analyze'); // re-run from node

await manager.cleanup(Date.now() - 7 * 24 * 60 * 60 * 1000); // delete runs older than 7d

// subscribe to state changes
const unsub = manager.onRunStateChange((run) => {
  console.log(`${run.workflowName} → ${run.status}`);
});

manager.stop();
```

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

```typescript
import { createTracer, OTLPSpanExporter, setGlobalTracer } from '@cogitator-ai/workflows';

const tracer = createTracer({
  serviceName: 'my-workflow-service',
  exporter: new OTLPSpanExporter({ url: 'http://otel-collector:4318' }),
});

setGlobalTracer(tracer);
```

### Metrics

```typescript
import { createMetricsCollector, setGlobalMetrics } from '@cogitator-ai/workflows';

const metrics = createMetricsCollector({
  enabled: true,
  prefix: 'cogitator',
});

setGlobalMetrics(metrics);

// retrieve metrics
const workflowMetrics = metrics.getWorkflowMetrics('research-topic');
console.log(workflowMetrics.latency.p99);
```

---

## API Reference

### WorkflowBuilder

```typescript
class WorkflowBuilder<S extends WorkflowState> {
  constructor(name: string);

  initialState(state: S): this;
  entryPoint(nodeName: string): this;

  addNode(name: string, fn: NodeFn<S> | WorkflowNode<S>, options?: AddNodeOptions): this;
  addConditional(
    name: string,
    condition: (state: S) => string | string[],
    options?: AddConditionalOptions
  ): this;
  addLoop(name: string, options: AddLoopOptions): this;
  addParallel(name: string, targets: string[], options?: AddParallelOptions): this;

  build(): Workflow<S>;
}

interface AddNodeOptions {
  after?: string[]; // node names this node depends on
  config?: NodeConfig;
}

interface AddLoopOptions {
  condition: (state: S) => boolean; // true = continue looping
  back: string; // node to go back to
  exit: string; // node to go to when done
  after?: string[];
}
```

### WorkflowExecutor

```typescript
class WorkflowExecutor {
  constructor(cogitator: Cogitator, checkpointStore?: CheckpointStore);

  execute<S>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: WorkflowExecuteOptions
  ): Promise<WorkflowResult<S>>;

  resume<S>(
    workflow: Workflow<S>,
    checkpointId: string,
    options?: WorkflowExecuteOptions
  ): Promise<WorkflowResult<S>>;

  stream<S>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: Omit<WorkflowExecuteOptions, 'onNode*'>
  ): AsyncIterable<StreamingWorkflowEvent>;
}

interface WorkflowExecuteOptions {
  maxConcurrency?: number; // default: 4
  maxIterations?: number; // default: 100
  checkpoint?: boolean; // default: false
  checkpointStrategy?: 'per-iteration' | 'per-node';
  onNodeStart?: (node: string) => void;
  onNodeComplete?: (node: string, result: unknown, duration: number) => void;
  onNodeError?: (node: string, error: Error) => void;
  onNodeProgress?: (node: string, progress: number) => void;
}
```

### Workflow (type)

The `Workflow` type is a plain data object (not a class):

```typescript
interface Workflow<S = WorkflowState> {
  name: string;
  initialState: S;
  nodes: Map<string, WorkflowNode<S>>;
  edges: Edge[];
  entryPoint: string;
}
```

### WorkflowResult

```typescript
interface WorkflowResult<S> {
  workflowId: string;
  workflowName: string;
  state: S;
  nodeResults: Map<string, { output: unknown; duration: number }>;
  duration: number;
  checkpointId?: string;
  error?: Error;
}
```

### NodeContext

```typescript
interface NodeContext<S = WorkflowState> {
  state: S;
  input?: unknown; // output(s) from dependency nodes (array if multiple deps)
  nodeId: string;
  workflowId: string;
  step: number; // current iteration count
  reportProgress?: (progress: number) => void;
}
```

### NodeResult

```typescript
interface NodeResult<S = WorkflowState> {
  state?: Partial<S>; // state updates to merge in
  output?: unknown; // value accessible via ctx.input in dependent nodes
  next?: string | string[]; // override routing (optional)
}
```
