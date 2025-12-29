# Workflows

> DAG-based orchestration for multi-step agent tasks

## Overview

Workflows allow you to orchestrate complex, multi-step tasks with:

- **Directed Acyclic Graphs (DAGs)** — Define dependencies between steps
- **State Management** — Pass data between steps
- **Error Handling** — Retry, compensation, and fallback strategies
- **Human-in-the-Loop** — Pause for human approval or input
- **Observability** — Full tracing of workflow execution

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Workflow Engine                                     │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Workflow Definition                             │   │
│   │                                                                         │   │
│   │   ┌─────┐      ┌─────┐      ┌─────┐      ┌─────┐                       │   │
│   │   │Step1│─────►│Step2│─────►│Step3│─────►│Step4│                       │   │
│   │   └─────┘      └──┬──┘      └─────┘      └─────┘                       │   │
│   │                   │                                                     │   │
│   │                   └────────►┌─────┐                                    │   │
│   │                             │Step5│ (parallel branch)                  │   │
│   │                             └─────┘                                    │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Execution Engine                                │   │
│   │                                                                         │   │
│   │   Scheduler  │  State Store  │  Event Bus  │  Retry Handler            │   │
│   │                                                                         │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Creating Workflows

### Basic Workflow

```typescript
import { Workflow, step } from '@cogitator/workflows';

const researchWorkflow = new Workflow({
  name: 'research-topic',
  description: 'Research a topic and produce a summary',

  steps: [
    step('search', {
      agent: researcherAgent,
      input: (ctx) => `Search for information about: ${ctx.input.topic}`,
    }),

    step('analyze', {
      agent: analyzerAgent,
      input: (ctx) => `Analyze these search results: ${ctx.steps.search.output}`,
      dependsOn: ['search'],
    }),

    step('summarize', {
      agent: writerAgent,
      input: (ctx) => `Write a summary based on: ${ctx.steps.analyze.output}`,
      dependsOn: ['analyze'],
    }),
  ],
});

// Execute
const result = await cog.workflow(researchWorkflow).run({
  topic: 'WebGPU graphics API',
});

console.log(result.output); // Final summary
```

### Parallel Execution

```typescript
const parallelWorkflow = new Workflow({
  name: 'multi-source-research',

  steps: [
    // These run in parallel (no dependencies)
    step('search-web', {
      agent: webSearchAgent,
      input: (ctx) => `Search web for: ${ctx.input.query}`,
    }),

    step('search-papers', {
      agent: academicSearchAgent,
      input: (ctx) => `Search academic papers for: ${ctx.input.query}`,
    }),

    step('search-code', {
      agent: codeSearchAgent,
      input: (ctx) => `Search GitHub for: ${ctx.input.query}`,
    }),

    // This waits for all searches to complete
    step('combine', {
      agent: synthesizerAgent,
      input: (ctx) => `
        Combine these sources:
        Web: ${ctx.steps['search-web'].output}
        Papers: ${ctx.steps['search-papers'].output}
        Code: ${ctx.steps['search-code'].output}
      `,
      dependsOn: ['search-web', 'search-papers', 'search-code'],
    }),
  ],
});
```

### Conditional Branching

```typescript
const conditionalWorkflow = new Workflow({
  name: 'code-review',

  steps: [
    step('analyze', {
      agent: codeAnalyzerAgent,
      input: (ctx) => ctx.input.code,
    }),

    // Only runs if analysis found issues
    step('fix-issues', {
      agent: coderAgent,
      input: (ctx) => `Fix these issues: ${ctx.steps.analyze.output.issues}`,
      dependsOn: ['analyze'],
      condition: (ctx) => ctx.steps.analyze.output.hasIssues,
    }),

    // Only runs if no issues found
    step('approve', {
      type: 'passthrough',
      input: (ctx) => ({ approved: true, code: ctx.input.code }),
      dependsOn: ['analyze'],
      condition: (ctx) => !ctx.steps.analyze.output.hasIssues,
    }),

    // Runs after either fix-issues or approve
    step('finalize', {
      agent: reviewerAgent,
      input: (ctx) => {
        const code = ctx.steps['fix-issues']?.output || ctx.steps.approve?.output.code;
        return `Final review of: ${code}`;
      },
      dependsOn: ['fix-issues', 'approve'],
      dependencyMode: 'any', // Run when ANY dependency completes
    }),
  ],
});
```

---

## Step Types

### Agent Step

Execute an agent with input:

```typescript
step('research', {
  type: 'agent', // default
  agent: researcherAgent,
  input: (ctx) => `Research: ${ctx.input.topic}`,
  timeout: 60_000,
});
```

### Tool Step

Execute a tool directly:

```typescript
step('fetch-data', {
  type: 'tool',
  tool: webFetch,
  input: (ctx) => ({ url: ctx.input.url }),
});
```

### Function Step

Execute custom JavaScript:

```typescript
step('transform', {
  type: 'function',
  execute: async (ctx) => {
    const data = ctx.steps['fetch-data'].output;
    return data.items.filter((item) => item.score > 0.5);
  },
});
```

### Human-in-the-Loop Step

Pause for human input:

```typescript
step('approve', {
  type: 'human',
  prompt: (ctx) => `
    Please review the following changes:
    ${ctx.steps.generate.output}

    Do you approve these changes?
  `,
  options: ['approve', 'reject', 'modify'],
  timeout: 24 * 60 * 60 * 1000, // 24 hours
  onTimeout: 'reject',
});
```

### Delay Step

Wait for a specified duration:

```typescript
step('wait', {
  type: 'delay',
  duration: 5000, // 5 seconds
});
```

### Subworkflow Step

Execute another workflow:

```typescript
step('detailed-analysis', {
  type: 'subworkflow',
  workflow: detailedAnalysisWorkflow,
  input: (ctx) => ({ data: ctx.steps.fetch.output }),
});
```

---

## State Management

### Workflow Context

```typescript
interface WorkflowContext<TInput = any> {
  // Original input to the workflow
  input: TInput;

  // Results from completed steps
  steps: Record<string, StepResult>;

  // Shared state (mutable)
  state: Record<string, any>;

  // Workflow metadata
  meta: {
    workflowId: string;
    runId: string;
    startedAt: Date;
    currentStep: string;
  };
}

// Accessing context in steps
step('process', {
  input: (ctx) => ({
    originalInput: ctx.input,
    previousResult: ctx.steps['fetch'].output,
    counter: ctx.state.counter || 0,
  }),

  // Update shared state
  onComplete: (result, ctx) => {
    ctx.state.counter = (ctx.state.counter || 0) + 1;
    ctx.state.lastProcessedId = result.id;
  },
});
```

### Persisted State

Workflows can survive restarts:

```typescript
const workflow = new Workflow({
  name: 'long-running',

  // Persist state to database
  persistence: {
    store: 'postgres',
    checkpointInterval: 'after-each-step',
  },

  steps: [
    // ... steps
  ],
});

// Resume a paused workflow
const run = await cog.workflow(workflow).resume(runId);
```

---

## Error Handling

### Retry Configuration

```typescript
step('unreliable-api', {
  agent: apiAgent,
  retry: {
    maxRetries: 3,
    backoff: 'exponential',
    initialDelay: 1000,
    maxDelay: 30000,
    retryOn: (error) => {
      // Only retry on transient errors
      return error.code === 'TIMEOUT' || error.status >= 500;
    },
  },
});
```

### Fallback Steps

```typescript
step('primary-source', {
  agent: primaryAgent,
  fallback: {
    step: 'backup-source',
    condition: (error) => error.code === 'NOT_FOUND',
  },
});

step('backup-source', {
  agent: backupAgent,
  disabled: true, // Only runs as fallback
});
```

### Compensation (Saga Pattern)

```typescript
const orderWorkflow = new Workflow({
  name: 'process-order',

  steps: [
    step('reserve-inventory', {
      agent: inventoryAgent,
      input: (ctx) => ({ items: ctx.input.items }),
      // Compensation if later steps fail
      compensate: async (ctx) => {
        await inventoryService.release(ctx.steps['reserve-inventory'].output.reservationId);
      },
    }),

    step('charge-payment', {
      agent: paymentAgent,
      input: (ctx) => ({ amount: ctx.input.total }),
      dependsOn: ['reserve-inventory'],
      compensate: async (ctx) => {
        await paymentService.refund(ctx.steps['charge-payment'].output.chargeId);
      },
    }),

    step('ship-order', {
      agent: shippingAgent,
      input: (ctx) => ({ address: ctx.input.address }),
      dependsOn: ['charge-payment'],
      // If this fails, previous compensations run in reverse order
    }),
  ],

  onError: 'compensate', // Run compensations on failure
});
```

### Error Handlers

```typescript
const workflow = new Workflow({
  name: 'with-error-handling',

  steps: [
    /* ... */
  ],

  // Global error handler
  onError: async (error, ctx) => {
    await alertService.notify({
      workflow: ctx.meta.workflowId,
      step: ctx.meta.currentStep,
      error: error.message,
    });

    // Return action
    return {
      action: 'abort', // 'abort' | 'retry' | 'skip' | 'compensate'
      reason: error.message,
    };
  },
});
```

---

## Workflow Patterns

### 1. Map-Reduce

Process items in parallel, then combine:

```typescript
const mapReduceWorkflow = new Workflow({
  name: 'analyze-documents',

  steps: [
    // Fan out: process each document in parallel
    step('map', {
      type: 'map',
      items: (ctx) => ctx.input.documents,
      step: {
        agent: analyzerAgent,
        input: (item) => `Analyze: ${item.content}`,
      },
      maxConcurrency: 10,
    }),

    // Reduce: combine all results
    step('reduce', {
      agent: summarizerAgent,
      input: (ctx) => `
        Combine these analyses into a single report:
        ${ctx.steps.map.outputs.map((o) => o.output).join('\n---\n')}
      `,
      dependsOn: ['map'],
    }),
  ],
});
```

### 2. Pipeline

Sequential processing with transformations:

```typescript
const pipelineWorkflow = new Workflow({
  name: 'data-pipeline',

  steps: [
    step('extract', {
      tool: dataScraper,
      input: (ctx) => ({ url: ctx.input.sourceUrl }),
    }),

    step('transform', {
      type: 'function',
      execute: (ctx) => {
        const raw = ctx.steps.extract.output;
        return normalizeData(raw);
      },
      dependsOn: ['extract'],
    }),

    step('validate', {
      agent: validatorAgent,
      input: (ctx) => `Validate this data: ${JSON.stringify(ctx.steps.transform.output)}`,
      dependsOn: ['transform'],
    }),

    step('load', {
      tool: databaseInsert,
      input: (ctx) => ({
        table: 'processed_data',
        data: ctx.steps.transform.output,
      }),
      dependsOn: ['validate'],
      condition: (ctx) => ctx.steps.validate.output.isValid,
    }),
  ],
});
```

### 3. Event-Driven

React to external events:

```typescript
const eventDrivenWorkflow = new Workflow({
  name: 'pr-review',

  triggers: [
    {
      type: 'webhook',
      path: '/github/pr',
      filter: (event) => event.action === 'opened',
    },
  ],

  steps: [
    step('fetch-diff', {
      tool: githubTool,
      input: (ctx) => ({ action: 'get_diff', pr: ctx.input.pull_request.number }),
    }),

    step('review', {
      agent: codeReviewAgent,
      input: (ctx) => `Review this PR diff:\n${ctx.steps['fetch-diff'].output}`,
      dependsOn: ['fetch-diff'],
    }),

    step('post-comment', {
      tool: githubTool,
      input: (ctx) => ({
        action: 'create_comment',
        pr: ctx.input.pull_request.number,
        body: ctx.steps.review.output,
      }),
      dependsOn: ['review'],
    }),
  ],
});
```

### 4. Approval Chain

Multi-stage approvals:

```typescript
const approvalWorkflow = new Workflow({
  name: 'expense-approval',

  steps: [
    step('validate', {
      agent: validatorAgent,
      input: (ctx) => ctx.input.expenseReport,
    }),

    step('manager-approval', {
      type: 'human',
      assignee: (ctx) => ctx.input.managerEmail,
      prompt: (ctx) => `
        Please review expense report:
        Amount: ${ctx.input.amount}
        Description: ${ctx.input.description}
      `,
      dependsOn: ['validate'],
    }),

    // High amounts need director approval
    step('director-approval', {
      type: 'human',
      assignee: (ctx) => ctx.input.directorEmail,
      prompt: (ctx) => `High-value expense requires your approval...`,
      dependsOn: ['manager-approval'],
      condition: (ctx) => ctx.input.amount > 5000,
    }),

    step('process-payment', {
      agent: paymentAgent,
      input: (ctx) => ctx.input,
      dependsOn: ['manager-approval', 'director-approval'],
      dependencyMode: 'completed', // All applicable dependencies must pass
    }),
  ],
});
```

### 5. Iterative Refinement

Loop until quality threshold:

```typescript
const refinementWorkflow = new Workflow({
  name: 'iterative-writing',

  steps: [
    step('draft', {
      agent: writerAgent,
      input: (ctx) => `Write about: ${ctx.input.topic}`,
    }),

    step('evaluate', {
      agent: criticAgent,
      input: (ctx) => {
        const draft = ctx.state.currentDraft || ctx.steps.draft.output;
        return `Evaluate this draft (score 1-10):\n${draft}`;
      },
      dependsOn: ['draft'],
    }),

    step('refine', {
      agent: writerAgent,
      input: (ctx) => `
        Improve this draft based on feedback:
        Draft: ${ctx.state.currentDraft || ctx.steps.draft.output}
        Feedback: ${ctx.steps.evaluate.output.feedback}
      `,
      dependsOn: ['evaluate'],
      condition: (ctx) => ctx.steps.evaluate.output.score < 8,
      onComplete: (result, ctx) => {
        ctx.state.currentDraft = result;
        ctx.state.iteration = (ctx.state.iteration || 0) + 1;
      },
    }),

    // Loop back to evaluate
    step('loop', {
      type: 'goto',
      target: 'evaluate',
      condition: (ctx) => ctx.state.iteration < 5 && ctx.steps.evaluate.output.score < 8,
      dependsOn: ['refine'],
    }),

    step('finalize', {
      type: 'function',
      execute: (ctx) => ctx.state.currentDraft || ctx.steps.draft.output,
      dependsOn: ['evaluate', 'refine'],
      dependencyMode: 'any',
      condition: (ctx) => ctx.steps.evaluate.output.score >= 8 || ctx.state.iteration >= 5,
    }),
  ],
});
```

---

## Scheduling

### Cron Triggers

```typescript
const scheduledWorkflow = new Workflow({
  name: 'daily-report',

  triggers: [
    {
      type: 'cron',
      schedule: '0 9 * * *', // 9 AM daily
      timezone: 'America/New_York',
    },
  ],

  steps: [
    /* ... */
  ],
});
```

### Delayed Execution

```typescript
// Run workflow after delay
const run = await cog.workflow(myWorkflow).schedule({
  runAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
  input: { ... },
});
```

---

## Observability

### Workflow Tracing

```typescript
const result = await cog.workflow(myWorkflow).run(input);

console.log(result.trace);
// {
//   workflowId: 'research-topic',
//   runId: 'run_abc123',
//   duration: 45000,
//   status: 'completed',
//   steps: [
//     { name: 'search', status: 'completed', duration: 12000 },
//     { name: 'analyze', status: 'completed', duration: 18000 },
//     { name: 'summarize', status: 'completed', duration: 15000 },
//   ],
//   totalTokens: 5600,
//   totalCost: 0.028,
// }
```

### Events

```typescript
cog.workflow(myWorkflow).on('step:start', (event) => {
  console.log(`Starting step: ${event.stepName}`);
});

cog.workflow(myWorkflow).on('step:complete', (event) => {
  console.log(`Completed step: ${event.stepName} in ${event.duration}ms`);
});

cog.workflow(myWorkflow).on('step:error', (event) => {
  console.error(`Step ${event.stepName} failed:`, event.error);
});

cog.workflow(myWorkflow).on('workflow:complete', (event) => {
  console.log(`Workflow completed in ${event.duration}ms`);
});
```

### Dashboard Integration

```typescript
const workflow = new Workflow({
  name: 'my-workflow',

  // Enable dashboard tracking
  dashboard: {
    enabled: true,
    tags: ['production', 'critical'],
    alertOn: {
      duration: { gt: 60000 }, // Alert if > 1 minute
      failure: true,
    },
  },
});
```

---

## API Reference

### Workflow Class

```typescript
class Workflow {
  constructor(config: WorkflowConfig);

  // Execute workflow
  run(input: any): Promise<WorkflowResult>;

  // Schedule for later
  schedule(options: ScheduleOptions): Promise<ScheduledRun>;

  // Resume paused workflow
  resume(runId: string): Promise<WorkflowResult>;

  // Cancel running workflow
  cancel(runId: string): Promise<void>;

  // Get run status
  getStatus(runId: string): Promise<RunStatus>;

  // List runs
  listRuns(options?: ListOptions): Promise<Run[]>;

  // Event handlers
  on(event: string, handler: Function): void;
}
```

### Step Function

```typescript
function step(name: string, config: StepConfig): Step;

interface StepConfig {
  // Step type
  type?: 'agent' | 'tool' | 'function' | 'human' | 'delay' | 'subworkflow' | 'map' | 'goto';

  // For agent steps
  agent?: Agent;
  input?: (ctx: WorkflowContext) => any;

  // For tool steps
  tool?: Tool;

  // For function steps
  execute?: (ctx: WorkflowContext) => Promise<any>;

  // Dependencies
  dependsOn?: string[];
  dependencyMode?: 'all' | 'any' | 'completed';

  // Conditions
  condition?: (ctx: WorkflowContext) => boolean;

  // Error handling
  retry?: RetryConfig;
  fallback?: FallbackConfig;
  compensate?: (ctx: WorkflowContext) => Promise<void>;

  // Timeouts
  timeout?: number;

  // Hooks
  onStart?: (ctx: WorkflowContext) => void;
  onComplete?: (result: any, ctx: WorkflowContext) => void;
  onError?: (error: Error, ctx: WorkflowContext) => void;
}
```
