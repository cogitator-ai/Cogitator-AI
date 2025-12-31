# @cogitator-ai/workflows

[![npm version](https://img.shields.io/npm/v/@cogitator-ai/workflows.svg)](https://www.npmjs.com/package/@cogitator-ai/workflows)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

DAG-based workflow engine for Cogitator agents. Build complex multi-step workflows with branching, loops, checkpoints, human-in-the-loop, timers, and more.

## Installation

```bash
pnpm add @cogitator-ai/workflows
```

## Features

- **DAG Builder** — Type-safe workflow construction with nodes, conditionals, loops
- **Checkpoints** — Save and resume workflow state
- **Pre-built Nodes** — Agent, tool, and function nodes
- **Timer System** — Delays, cron schedules, wait-until patterns
- **Saga Patterns** — Retries, circuit breakers, compensation, DLQ
- **Subworkflows** — Nested, parallel, fan-out/fan-in patterns
- **Human-in-the-Loop** — Approvals, choices, inputs, rating
- **Map-Reduce** — Parallel processing with aggregation
- **Triggers** — Cron, webhook, and event triggers
- **Observability** — Tracing and metrics with multiple exporters

## Quick Start

```typescript
import { WorkflowBuilder, WorkflowExecutor, agentNode } from '@cogitator-ai/workflows';
import { Cogitator, Agent } from '@cogitator-ai/core';

const cogitator = new Cogitator({
  /* config */
});
const analyst = new Agent({ name: 'analyst', model: 'openai/gpt-4o', instructions: '...' });

const workflow = new WorkflowBuilder('data-pipeline')
  .addNode('analyze', agentNode(analyst))
  .addNode('report', async (ctx) => ({ output: `Report: ${ctx.state.analysis}` }))
  .build();

const executor = new WorkflowExecutor(cogitator);
const result = await executor.execute(workflow, { input: 'Analyze this data...' });
```

---

## Table of Contents

- [Core Concepts](#core-concepts)
- [Pre-built Nodes](#pre-built-nodes)
- [Conditional Branching](#conditional-branching)
- [Loops](#loops)
- [Checkpoints](#checkpoints)
- [Timer System](#timer-system)
- [Saga Patterns](#saga-patterns)
- [Subworkflows](#subworkflows)
- [Human-in-the-Loop](#human-in-the-loop)
- [Map-Reduce Patterns](#map-reduce-patterns)
- [Triggers](#triggers)
- [Observability](#observability)
- [Workflow Management](#workflow-management)

---

## Core Concepts

### WorkflowBuilder

```typescript
import { WorkflowBuilder } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder<MyState>('my-workflow')
  .initialState({ count: 0 })
  .addNode('step1', async (ctx) => ({
    state: { ...ctx.state, count: ctx.state.count + 1 },
  }))
  .addNode(
    'step2',
    async (ctx) => ({
      output: `Count: ${ctx.state.count}`,
    }),
    { after: ['step1'] }
  )
  .build();
```

### WorkflowExecutor

```typescript
import { WorkflowExecutor } from '@cogitator-ai/workflows';

const executor = new WorkflowExecutor(cogitator);
const result = await executor.execute(workflow, {
  input: 'Start the workflow',
  context: { userId: '123' },
  timeout: 60000,
});

console.log(result.output);
console.log(result.state);
console.log(result.events);
```

---

## Pre-built Nodes

### agentNode

Run an agent as a workflow node:

```typescript
import { agentNode } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('agent-flow')
  .addNode(
    'research',
    agentNode(researchAgent, {
      promptKey: 'researchPrompt', // State key for input
      outputKey: 'researchResult', // State key for output
      timeout: 30000,
      onToolCall: (call) => console.log('Tool:', call.name),
    })
  )
  .build();
```

### toolNode

Execute a tool directly:

```typescript
import { toolNode } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('tool-flow')
  .addNode('calculate', toolNode('calculator', { expression: '2 + 2' }))
  .build();
```

### functionNode

Custom function as a node:

```typescript
import { functionNode } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('func-flow')
  .addNode(
    'transform',
    functionNode(async (ctx) => {
      const transformed = processData(ctx.state.data);
      return { state: { ...ctx.state, transformed } };
    })
  )
  .build();
```

---

## Conditional Branching

```typescript
const workflow = new WorkflowBuilder('approval-flow')
  .addNode('review', reviewNode)
  .addConditional('check', (state) => state.approved, {
    after: ['review'],
  })
  .addNode('approve', approveNode, { after: ['check:true'] })
  .addNode('reject', rejectNode, { after: ['check:false'] })
  .addNode('notify', notifyNode, { after: ['approve', 'reject'] })
  .build();
```

---

## Loops

```typescript
const workflow = new WorkflowBuilder('retry-flow')
  .addNode('attempt', attemptNode)
  .addLoop('retry-check', {
    condition: (state) => !state.success && state.attempts < 3,
    back: 'attempt',
    exit: 'done',
    after: ['attempt'],
  })
  .addNode('done', doneNode)
  .build();
```

---

## Checkpoints

Save and resume workflow execution:

```typescript
import { FileCheckpointStore, InMemoryCheckpointStore } from '@cogitator-ai/workflows';

// File-based persistence
const store = new FileCheckpointStore('./checkpoints');

// Execute with checkpoints
await executor.execute(workflow, {
  checkpointStore: store,
  checkpointInterval: 5000, // Save every 5 seconds
});

// Resume from checkpoint
const result = await executor.resume(checkpointId, store);
```

---

## Timer System

### Delay Nodes

```typescript
import { delayNode, dynamicDelayNode, cronWaitNode, untilNode } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('timer-flow')
  // Fixed delay
  .addNode('wait', delayNode(5000)) // 5 seconds

  // Dynamic delay based on state
  .addNode(
    'dynamic-wait',
    dynamicDelayNode((state) => state.retryCount * 1000)
  )

  // Wait for cron schedule
  .addNode('cron-wait', cronWaitNode('0 9 * * *')) // Wait until 9 AM

  // Wait until specific date
  .addNode(
    'until',
    untilNode((state) => state.scheduledTime)
  )
  .build();
```

### Duration Parsing

```typescript
import { parseDuration, formatDuration } from '@cogitator-ai/workflows';

const ms = parseDuration('1h30m'); // 5400000
const str = formatDuration(5400000); // '1h 30m'
```

### Cron Utilities

```typescript
import {
  validateCronExpression,
  getNextCronOccurrence,
  getNextCronOccurrences,
  describeCronExpression,
  CRON_PRESETS,
} from '@cogitator-ai/workflows';

// Validate
const valid = validateCronExpression('0 9 * * 1-5'); // true

// Get next occurrence
const next = getNextCronOccurrence('0 9 * * *');

// Get multiple occurrences
const nextFive = getNextCronOccurrences('0 9 * * *', 5);

// Human-readable description
const desc = describeCronExpression('0 9 * * 1-5'); // "At 09:00 on weekdays"

// Presets
CRON_PRESETS.EVERY_MINUTE; // '* * * * *'
CRON_PRESETS.HOURLY; // '0 * * * *'
CRON_PRESETS.DAILY; // '0 0 * * *'
CRON_PRESETS.WEEKLY; // '0 0 * * 0'
CRON_PRESETS.MONTHLY; // '0 0 1 * *'
```

### TimerManager

Manage recurring timers:

```typescript
import { createTimerManager, createRecurringScheduler } from '@cogitator-ai/workflows';

const manager = createTimerManager({
  maxConcurrent: 10,
  defaultTimeout: 60000,
});

// One-shot timer
manager.schedule('task-1', 5000, async () => {
  console.log('Executed after 5 seconds');
});

// Recurring timer
const scheduler = createRecurringScheduler();
scheduler.schedule('daily-report', '0 9 * * *', async () => {
  await generateDailyReport();
});
```

---

## Saga Patterns

### Retry with Backoff

```typescript
import { executeWithRetry, withRetry, Retryable } from '@cogitator-ai/workflows';

// Function wrapper
const result = await executeWithRetry(async () => await unreliableOperation(), {
  maxAttempts: 5,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: 0.1,
  shouldRetry: (error) => error.code !== 'FATAL',
  onRetry: (attempt, error, delay) => console.log(`Retry ${attempt} in ${delay}ms`),
});

// Decorator-style
const retryableFetch = withRetry({ maxAttempts: 3 })(async (url: string) => await fetch(url));

// Class decorator
class ApiClient {
  @Retryable({ maxAttempts: 3, initialDelay: 500 })
  async request(endpoint: string) {
    return fetch(endpoint);
  }
}
```

### Circuit Breaker

```typescript
import { CircuitBreaker, createCircuitBreaker, WithCircuitBreaker } from '@cogitator-ai/workflows';

const breaker = createCircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30000,
  halfOpenMaxAttempts: 3,
  onStateChange: (from, to) => console.log(`Circuit: ${from} -> ${to}`),
});

// Use the breaker
try {
  const result = await breaker.execute(async () => {
    return await externalService.call();
  });
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    console.log('Circuit is open, using fallback');
  }
}

// Get stats
const stats = breaker.getStats();
console.log(stats.failures, stats.successes, stats.state);

// Decorator-style
class ServiceClient {
  @WithCircuitBreaker({ failureThreshold: 3 })
  async call() {
    return fetch('/api');
  }
}
```

### Compensation (Saga)

```typescript
import { CompensationManager, compensationBuilder } from '@cogitator-ai/workflows';

const saga = compensationBuilder<{ orderId: string }>()
  .step({
    name: 'reserve-inventory',
    execute: async (ctx) => {
      ctx.state.inventoryReserved = await inventory.reserve(ctx.data.orderId);
    },
    compensate: async (ctx) => {
      await inventory.release(ctx.data.orderId);
    },
  })
  .step({
    name: 'charge-payment',
    execute: async (ctx) => {
      ctx.state.paymentId = await payments.charge(ctx.data.orderId);
    },
    compensate: async (ctx) => {
      await payments.refund(ctx.state.paymentId);
    },
  })
  .step({
    name: 'ship-order',
    execute: async (ctx) => {
      await shipping.ship(ctx.data.orderId);
    },
    compensate: async (ctx) => {
      await shipping.cancel(ctx.data.orderId);
    },
  })
  .build();

const manager = new CompensationManager();
const result = await manager.execute(saga, { orderId: 'order-123' });

if (!result.success) {
  console.log('Saga failed at:', result.failedStep);
  console.log('Compensated steps:', result.compensatedSteps);
}
```

### Dead Letter Queue (DLQ)

```typescript
import { createFileDLQ, createInMemoryDLQ } from '@cogitator-ai/workflows';

const dlq = createFileDLQ('./dlq');

// Add failed item
await dlq.add({
  id: 'job-123',
  payload: { orderId: 'order-456' },
  error: 'Payment failed',
  source: 'checkout-workflow',
  attemptCount: 3,
});

// Process DLQ
const items = await dlq.list({ source: 'checkout-workflow' });
for (const item of items) {
  try {
    await retryJob(item.payload);
    await dlq.remove(item.id);
  } catch {
    await dlq.update(item.id, { attemptCount: item.attemptCount + 1 });
  }
}
```

### Idempotency

```typescript
import { idempotent, Idempotent, createFileIdempotencyStore } from '@cogitator-ai/workflows';

const store = createFileIdempotencyStore('./idempotency');

// Function wrapper
const processOrder = idempotent(store, {
  keyGenerator: (orderId: string) => `order:${orderId}`,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
})(async (orderId: string) => {
  return await processOrderInternal(orderId);
});

// Safe to call multiple times
await processOrder('order-123'); // Executes
await processOrder('order-123'); // Returns cached result

// Decorator-style
class OrderService {
  @Idempotent({ keyGenerator: (id) => `order:${id}`, ttl: 86400000 })
  async process(orderId: string) {
    return processOrderInternal(orderId);
  }
}
```

---

## Subworkflows

### Nested Subworkflows

```typescript
import { subworkflowNode, executeSubworkflow } from '@cogitator-ai/workflows';

const mainWorkflow = new WorkflowBuilder('main')
  .addNode('prepare', prepareNode)
  .addNode(
    'process',
    subworkflowNode(processingWorkflow, {
      inputMapper: (state) => ({ items: state.items }),
      outputMapper: (result) => ({ processedItems: result.output }),
      maxDepth: 5,
      errorStrategy: 'fail', // 'fail' | 'continue' | 'compensate'
    })
  )
  .addNode('finalize', finalizeNode, { after: ['process'] })
  .build();
```

### Parallel Subworkflows

```typescript
import { parallelSubworkflows, fanOutFanIn, scatterGather } from '@cogitator-ai/workflows';

// Fan-out/Fan-in pattern
const workflow = new WorkflowBuilder('parallel')
  .addNode(
    'distribute',
    fanOutFanIn(
      [
        { workflow: workflowA, input: { type: 'a' } },
        { workflow: workflowB, input: { type: 'b' } },
        { workflow: workflowC, input: { type: 'c' } },
      ],
      {
        concurrency: 3,
        onProgress: (completed, total) => console.log(`${completed}/${total}`),
      }
    )
  )
  .build();

// Scatter-Gather (collect all results)
const results = await scatterGather(executor, workflows, inputs);

// Race (first to complete wins)
const winner = await raceSubworkflows(executor, [workflow1, workflow2]);

// Fallback (try until one succeeds)
const result = await fallbackSubworkflows(executor, [primary, secondary, tertiary]);
```

---

## Human-in-the-Loop

### Approval Node

```typescript
import { approvalNode, InMemoryApprovalStore, WebhookNotifier } from '@cogitator-ai/workflows';

const store = new InMemoryApprovalStore();
const notifier = new WebhookNotifier('https://slack.webhook.url');

const workflow = new WorkflowBuilder('approval-flow')
  .addNode(
    'request',
    approvalNode({
      message: (state) => `Approve expense: $${state.amount}`,
      approvers: ['manager@company.com'],
      timeout: 24 * 60 * 60 * 1000, // 24 hours
      store,
      notifier,
    })
  )
  .addConditional('check', (state) => state.approved, { after: ['request'] })
  .addNode('process', processNode, { after: ['check:true'] })
  .addNode('reject', rejectNode, { after: ['check:false'] })
  .build();
```

### Choice Node

```typescript
import { choiceNode } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('choice-flow')
  .addNode(
    'select',
    choiceNode({
      message: 'Select processing method:',
      choices: [
        { id: 'fast', label: 'Fast (less accurate)', value: 'fast' },
        { id: 'accurate', label: 'Accurate (slower)', value: 'accurate' },
      ],
      store,
      notifier,
    })
  )
  .build();
```

### Input Node

```typescript
import { inputNode } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('input-flow')
  .addNode(
    'get-details',
    inputNode({
      message: 'Please provide additional details:',
      fields: [
        { name: 'reason', type: 'text', required: true },
        { name: 'priority', type: 'select', options: ['low', 'medium', 'high'] },
      ],
      store,
      notifier,
    })
  )
  .build();
```

### Approval Chains

```typescript
import { managementChain, chainNode } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('chain-approval')
  .addNode(
    'approval',
    managementChain({
      steps: [
        { approver: 'team-lead@co.com', requiredFor: (state) => state.amount > 100 },
        { approver: 'manager@co.com', requiredFor: (state) => state.amount > 1000 },
        { approver: 'director@co.com', requiredFor: (state) => state.amount > 10000 },
      ],
      store,
      notifier,
    })
  )
  .build();
```

---

## Map-Reduce Patterns

### Map (Parallel Processing)

```typescript
import { mapNode, parallelMap, batchedMap } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('map-flow')
  .addNode(
    'process-items',
    mapNode({
      items: (state) => state.items,
      mapper: async (item, index, ctx) => {
        return await processItem(item);
      },
      concurrency: 5,
      onProgress: ({ completed, total }) => console.log(`${completed}/${total}`),
    })
  )
  .build();

// Batched processing
const results = await batchedMap(items, processItem, { batchSize: 10, concurrency: 3 });
```

### Reduce (Aggregation)

```typescript
import { reduceNode, collect, sum, groupBy, stats } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('reduce-flow')
  .addNode(
    'aggregate',
    reduceNode({
      items: (state) => state.results,
      reducer: (acc, item) => acc + item.value,
      initialValue: 0,
    })
  )
  .build();

// Built-in aggregators
const collected = collect(items); // Collect all
const total = sum(items, (i) => i.value); // Sum values
const grouped = groupBy(items, (i) => i.category); // Group by key
const statistics = stats(items, (i) => i.score); // { min, max, avg, sum, count }
```

### Map-Reduce

```typescript
import { mapReduceNode, executeMapReduce } from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('mapreduce-flow')
  .addNode(
    'word-count',
    mapReduceNode({
      items: (state) => state.documents,
      mapper: async (doc) => {
        const words = doc.text.split(/\s+/);
        return words.map((w) => ({ word: w, count: 1 }));
      },
      reducer: (results) => {
        return results.flat().reduce((acc, { word, count }) => {
          acc[word] = (acc[word] || 0) + count;
          return acc;
        }, {});
      },
      concurrency: 10,
    })
  )
  .build();
```

---

## Triggers

### Cron Trigger

```typescript
import { createCronTrigger, CronTriggerExecutor } from '@cogitator-ai/workflows';

const trigger = createCronTrigger({
  expression: '0 9 * * 1-5', // 9 AM on weekdays
  timezone: 'America/New_York',
  workflow: dailyReportWorkflow,
  executor,
  onTrigger: (time) => console.log('Triggered at:', time),
});

trigger.start();
// Later: trigger.stop();
```

### Webhook Trigger

```typescript
import { createWebhookTrigger, WebhookTriggerExecutor } from '@cogitator-ai/workflows';

const webhook = createWebhookTrigger({
  path: '/webhooks/github',
  workflow: githubEventWorkflow,
  executor,
  auth: {
    type: 'hmac',
    secret: process.env.WEBHOOK_SECRET!,
    header: 'X-Hub-Signature-256',
  },
  rateLimit: {
    maxRequests: 100,
    windowMs: 60000,
  },
  inputMapper: (req) => ({ event: req.body.action, payload: req.body }),
});

// Handle incoming request
const result = await webhook.handle(request);
```

### Trigger Manager

```typescript
import {
  createTriggerManager,
  cronTrigger,
  webhookTrigger,
  eventTrigger,
} from '@cogitator-ai/workflows';

const manager = createTriggerManager({ executor });

manager.register(
  'daily-report',
  cronTrigger({
    expression: '0 9 * * *',
    workflow: reportWorkflow,
  })
);

manager.register(
  'github-webhook',
  webhookTrigger({
    path: '/hooks/github',
    workflow: githubWorkflow,
  })
);

manager.register(
  'order-created',
  eventTrigger({
    event: 'order.created',
    workflow: orderProcessingWorkflow,
  })
);

await manager.startAll();
```

---

## Observability

### Tracing

```typescript
import {
  createTracer,
  OTLPSpanExporter,
  ZipkinSpanExporter,
  CompositeSpanExporter,
} from '@cogitator-ai/workflows';

// OTLP exporter (Jaeger, Tempo, etc.)
const otlpExporter = new OTLPSpanExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  headers: { 'X-Api-Key': 'secret' },
});

// Zipkin exporter
const zipkinExporter = new ZipkinSpanExporter({
  endpoint: 'http://localhost:9411/api/v2/spans',
});

// Composite (multiple exporters)
const exporter = new CompositeSpanExporter([otlpExporter, zipkinExporter]);

const tracer = createTracer({
  serviceName: 'my-workflow-service',
  exporter,
});

// Execute with tracing
await executor.execute(workflow, { tracer });
```

### Metrics

```typescript
import { createMetricsCollector, WorkflowMetricsCollector } from '@cogitator-ai/workflows';

const metrics = createMetricsCollector({
  prefix: 'cogitator_workflow',
  labels: { environment: 'production' },
});

// Execute with metrics
await executor.execute(workflow, { metrics });

// Get metrics
const nodeMetrics = metrics.getNodeMetrics('my-node');
console.log(nodeMetrics.executionCount);
console.log(nodeMetrics.averageDuration);
console.log(nodeMetrics.errorRate);

const workflowMetrics = metrics.getWorkflowMetrics('my-workflow');
console.log(workflowMetrics.completionRate);
console.log(workflowMetrics.averageCompletionTime);
```

---

## Workflow Management

### WorkflowManager

```typescript
import { createWorkflowManager, createFileRunStore } from '@cogitator-ai/workflows';

const runStore = createFileRunStore('./runs');

const manager = createWorkflowManager({
  executor,
  runStore,
  concurrency: 10,
  defaultTimeout: 300000,
});

// Schedule a workflow run
const runId = await manager.schedule(workflow, {
  input: 'Process this',
  priority: 1,
  scheduledAt: new Date(Date.now() + 60000), // 1 minute from now
  tags: ['daily', 'report'],
});

// Get run status
const run = await manager.getRun(runId);
console.log(run.status); // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

// List runs
const runs = await manager.listRuns({
  status: 'running',
  workflowId: 'daily-report',
  fromDate: new Date('2024-01-01'),
});

// Cancel a run
await manager.cancel(runId);

// Get stats
const stats = await manager.getStats();
console.log(stats.pending, stats.running, stats.completed, stats.failed);
```

### JobScheduler

```typescript
import { createJobScheduler, PriorityQueue } from '@cogitator-ai/workflows';

const scheduler = createJobScheduler({
  concurrency: 5,
  maxQueueSize: 1000,
});

// Add jobs with priority
scheduler.enqueue({ id: 'job-1', payload: data1, priority: 1 });
scheduler.enqueue({ id: 'job-2', payload: data2, priority: 10 }); // Higher priority

// Process jobs
scheduler.process(async (job) => {
  await processJob(job.payload);
});

scheduler.start();
```

---

## License

MIT
