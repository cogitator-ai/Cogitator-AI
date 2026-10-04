# @cogitator-ai/worker

Distributed job queue for Cogitator agent execution. Built on BullMQ for reliable, scalable background processing.

## Installation

```bash
pnpm add @cogitator-ai/worker @cogitator-ai/core ioredis
```

BullMQ and `@cogitator-ai/swarms` come as dependencies; `ioredis` is a peer dependency. Website docs: [Worker Queues](https://cogitator.app/docs/deployment/worker-queues), [Distributed Swarms](https://cogitator.app/docs/swarms/distributed).

## Features

- **BullMQ-Based** - Reliable job processing with Redis
- **Job Types** - Agents, workflow graphs, swarms and distributed swarm turns
- **Worker Runtime** - Run jobs with your own `Cogitator` (provider keys, memory) and tool implementations
- **Distributed Swarms** - `DistributedSwarmWorker` executes agent turns for `@cogitator-ai/swarms`
- **Auto-Retry** - Exponential backoff for failed jobs
- **Priority Queue** - Process important jobs first
- **Delayed Jobs** - Schedule jobs for later execution
- **Prometheus Metrics** - Built-in HPA support
- **Redis Cluster** - Production-ready scalability
- **Graceful Shutdown** - Wait for active jobs before stopping

---

## Quick Start

### Producer: Add Jobs

```typescript
import { JobQueue } from '@cogitator-ai/worker';

const queue = new JobQueue({
  redis: { host: 'localhost', port: 6379 },
});

const agentConfig = {
  name: 'Assistant',
  instructions: 'You are a helpful assistant.',
  model: 'openai/gpt-6.1-sol',
  provider: 'openai' as const,
  tools: [],
};

const job = await queue.addAgentJob(agentConfig, 'Hello, world!', {
  threadId: 'user-123',
  priority: 1,
});

console.log(`Job added: ${job.id}`);
```

### Consumer: Process Jobs

```typescript
import { Cogitator } from '@cogitator-ai/core';
import { WorkerPool } from '@cogitator-ai/worker';

const pool = new WorkerPool({
  redis: { host: 'localhost', port: 6379 },
  concurrency: 5,
  workerCount: 2,
  cogitator: new Cogitator({
    llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
  }),
  tools: [searchTool], // implementations for tools referenced by serialized agents
});

await pool.start();
```

Serialized agents reference tools by name. The worker resolves them from its `tools`; a job whose agent needs a tool the worker does not provide fails with `Tools not registered on this worker: <names>`.

---

## Job Queue

The `JobQueue` class manages job creation and status tracking.

### Creating a Queue

```typescript
import { JobQueue } from '@cogitator-ai/worker';

const queue = new JobQueue({
  name: 'my-queue',
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'secret',
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
```

### Queue Configuration

```typescript
interface QueueConfig {
  name?: string; // Default: 'cogitator-jobs'
  redis: {
    host?: string; // Default: 'localhost'
    port?: number; // Default: 6379
    password?: string;
    cluster?: {
      nodes: { host: string; port: number }[];
    };
  };
  defaultJobOptions?: {
    attempts?: number; // Default: 3
    backoff?: {
      type: 'exponential' | 'fixed';
      delay: number; // Delay in ms
    };
    removeOnComplete?: boolean | number; // Default: 100
    removeOnFail?: boolean | number; // Default: 500
  };
}
```

### Adding Jobs

**Agent Jobs:**

```typescript
const agentConfig: SerializedAgent = {
  name: 'Researcher',
  instructions: 'Research and summarize topics.',
  model: 'openai/gpt-6.1-sol', // or 'gpt-6.1-sol' - the provider is prepended when missing
  provider: 'openai',
  temperature: 0.7,
  maxTokens: 2048,
  maxIterations: 5,
  tools: [
    {
      name: 'search',
      description: 'Search the web',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ],
};

const job = await queue.addAgentJob(agentConfig, 'Research quantum computing', {
  threadId: 'thread-123', // default: a new id per job
  userId: 'user-456', // the run's userId: owns the thread, reaches tools as context.userId
  priority: 1, // Lower = higher priority
  delay: 5000, // Delay 5 seconds
  metadata: { source: 'api' },
});
```

The worker routes `model` exactly like the same agent in-process: a prefix that names a built-in provider, a backend in the worker Cogitator's `llm.backends` or a registered plugin picks that provider, so `'openrouter/deepseek/deepseek-v4-pro'` runs on an `openrouter` backend whatever `provider` says. `provider` (optional, any provider the worker routes to, custom backends and plugins included) is prepended only to a model whose prefix names none, such as `'meta-llama/llama-4-scout'` with `provider: 'openrouter'`. Without `provider` such a model runs on the worker's `llm.defaultProvider`, and a `provider` the worker cannot route to fails the job.

**Workflow Jobs:**

Workflow jobs run a DAG over a shared state object initialised from the job input. Nodes run as soon as their predecessors settle; independent branches run concurrently.

```typescript
const workflowConfig: SerializedWorkflow = {
  id: 'triage',
  name: 'Ticket triage',
  nodes: [
    {
      id: 'classify',
      type: 'agent',
      config: {
        agentConfig: classifierAgent, // SerializedAgent
        prompt: 'Classify this ticket as BUG or QUESTION: {{ticket}}',
        outputKey: 'category',
      },
    },
    { id: 'normalize', type: 'transform', config: { transform: 'trim', inputKey: 'category' } },
    {
      id: 'is-bug',
      type: 'condition',
      config: { key: 'normalize', operator: 'contains', value: 'BUG' },
    },
    {
      id: 'summary',
      type: 'transform',
      config: { transform: 'template', template: 'Bug report: {{ticket}}' },
    },
  ],
  edges: [
    { from: 'classify', to: 'normalize' },
    { from: 'normalize', to: 'is-bug' },
    { from: 'is-bug', to: 'summary', condition: 'true' },
  ],
};

await queue.addWorkflowJob(workflowConfig, { ticket: 'App crashes on login' });
```

| Node type   | Config                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`     | `{ agentConfig, prompt?, outputKey? }` — `prompt` supports `{{path}}` placeholders; default prompt is the state as JSON                   |
| `transform` | `{ transform, inputKey?, outputKey?, template? }` — `uppercase`, `lowercase`, `trim`, `json-parse`, `json-stringify`, `template`          |
| `condition` | `{ key, operator, value? }` — `equals`, `not-equals`, `contains`, `exists`, `gt`, `lt`; outgoing edges use `condition: 'true' \| 'false'` |
| `parallel`  | `{}` — fan-out marker; successors run concurrently                                                                                        |

Node outputs are stored in the state under `outputKey` (default: node id). Nodes reachable only through untaken condition branches are skipped (`{ skipped: true }` in `nodeResults`). Graphs are validated before execution (unknown nodes, invalid configs, cycles).

**Swarm Jobs:**

```typescript
const swarmConfig: SerializedSwarm = {
  topology: 'voting',
  agents: [researcherConfig, writerConfig, editorConfig],
  coordinator: coordinatorConfig, // decides when no consensus is reached
  maxRounds: 3,
  consensusThreshold: 0.8,
};

await queue.addSwarmJob(swarmConfig, 'Write an article about AI', {
  priority: 1,
  metadata: { project: 'blog' },
});
```

| Topology        | Swarm strategy | Notes                                                        |
| --------------- | -------------- | ------------------------------------------------------------ |
| `sequential`    | `pipeline`     | One stage per agent, in order                                |
| `hierarchical`  | `hierarchical` | `coordinator` is required and becomes the supervisor         |
| `collaborative` | `round-robin`  |                                                              |
| `debate`        | `debate`       | `maxRounds` rounds, `coordinator` moderates                  |
| `voting`        | `consensus`    | `consensusThreshold`, `maxRounds`; `coordinator` breaks ties |

### Queue Methods

```typescript
const job = await queue.getJob('job-id');

const state: JobState = await queue.getJobState('job-id');
// 'waiting' | 'prioritized' | 'delayed' | 'active' | 'completed' | 'failed'
// | 'waiting-children' | 'unknown'

const metrics = await queue.getMetrics();
// { waiting, active, completed, failed, delayed, depth, workerCount }

await queue.pause();
await queue.resume();

await queue.clean(60 * 60 * 1000, 1000, 'completed');
await queue.clean(24 * 60 * 60 * 1000, 100, 'failed');

const bullQueue = queue.getQueue();

await queue.close();
```

A job added with a `priority` waits in BullMQ's `prioritized` state instead of `waiting`. `getMetrics()` counts it in `waiting` and `depth` all the same, so `cogitator_queue_depth` covers every job that still has to run. `waiting-children` is the parent of a BullMQ flow (added through `getQueue()`) that waits for its children and is not counted, as its children are.

---

## Worker Pool

The `WorkerPool` processes jobs with configurable concurrency.

### Creating a Worker Pool

```typescript
import { WorkerPool } from '@cogitator-ai/worker';

const pool = new WorkerPool(
  {
    redis: { host: 'localhost', port: 6379 },
    workerCount: 2,
    concurrency: 5,
    lockDuration: 30000,
    stalledInterval: 30000,
  },
  {
    onJobStarted: (jobId, type) => {
      console.log(`Job ${jobId} (${type}) started`);
    },
    onJobCompleted: (jobId, result) => {
      console.log(`Job ${jobId} completed:`, result);
    },
    onJobFailed: (jobId, error) => {
      console.error(`Job ${jobId} failed:`, error);
    },
    onWorkerError: (error) => {
      console.error('Worker error:', error);
    },
  }
);

await pool.start();
```

### Worker Configuration

```typescript
interface WorkerConfig extends QueueConfig {
  workerCount?: number; // Default: 1
  concurrency?: number; // Default: 5
  lockDuration?: number; // Default: 30000ms
  stalledInterval?: number; // Default: 30000ms
  cogitator?: Cogitator; // Default: new Cogitator()
  tools?: Tool[]; // Tool implementations, resolved by name
}
```

| Option            | Default | Description                                |
| ----------------- | ------- | ------------------------------------------ |
| `workerCount`     | 1       | Number of worker instances                 |
| `concurrency`     | 5       | Concurrent jobs per worker                 |
| `lockDuration`    | 30000   | Lock timeout before job considered stalled |
| `stalledInterval` | 30000   | Interval to check for stalled jobs         |

### Worker Events

```typescript
interface WorkerPoolEvents {
  onJobStarted?: (jobId: string, type: 'agent' | 'workflow' | 'swarm' | 'swarm-agent') => void;
  onJobCompleted?: (jobId: string, result: JobResult) => void;
  onJobFailed?: (jobId: string, error: Error) => void;
  onWorkerError?: (error: Error) => void;
}
```

### Pool Methods

```typescript
await pool.start();

pool.isPoolRunning();

pool.getWorkerCount();

const metrics = await pool.getMetrics(await queue.getMetrics());

// Job duration histogram and per-type counters
pool.metrics.format(await pool.getMetrics(await queue.getMetrics()));

// Graceful shutdown (waits up to 30s for active jobs, then force-closes)
await pool.stop(30000);

// Force shutdown
await pool.forceStop();
```

---

## Job Processors

Built-in processors handle each job type.

### Using Processors Directly

Processors take the job payload and an optional runtime (`{ cogitator, tools }`):

```typescript
import { processAgentJob, processWorkflowJob, processSwarmJob } from '@cogitator-ai/worker';

const runtime = { cogitator, tools: [searchTool] };

const agentResult = await processAgentJob(
  { type: 'agent', jobId: 'job-1', agentConfig: myAgentConfig, input: 'Hello!', threadId: 't-1' },
  runtime
);

const workflowResult = await processWorkflowJob(
  { type: 'workflow', jobId: 'job-2', runId: 'run-1', workflowConfig, input: { ticket: '...' } },
  runtime
);

const swarmResult = await processSwarmJob(
  { type: 'swarm', jobId: 'job-3', swarmConfig: mySwarmConfig, input: 'Solve this problem' },
  runtime
);
```

`processSwarmAgentJob(payload, { publisher, isFinalAttempt, ...runtime })` executes one distributed swarm turn and publishes the result (tagged with the job id) to `payload.stateKeys.results`; `executeSwarmAgentJob` returns the result without publishing.

---

## Distributed Swarm Workers

Swarms created with `distributed.enabled` (see `@cogitator-ai/swarms`) dispatch every agent turn to a Redis queue. `DistributedSwarmWorker` consumes those turns:

```typescript
import { Cogitator } from '@cogitator-ai/core';
import { DistributedSwarmWorker } from '@cogitator-ai/worker';

const worker = new DistributedSwarmWorker(
  {
    redis: { host: 'localhost', port: 6379 },
    keyPrefix: 'swarm', // must match the swarm's distributed.redis.keyPrefix
    queue: 'swarm-agent-jobs', // must match distributed.queue
    concurrency: 4,
    cogitator: new Cogitator({ llm: { defaultModel: 'ollama/llama3.2' } }),
    tools: [searchTool],
  },
  {
    onJobCompleted: (job) => console.log('done', job.agentName),
    onJobFailed: (job, error) => console.error(job.agentName, error.message),
    onError: (error) => console.error(error),
  }
);

await worker.start();
process.on('SIGTERM', () => void worker.stop()); // waits for in-flight turns
```

Failed turns are reported back to the swarm as errors, so the swarm's own `errorHandling` (retry, failover, skip) applies. Each turn runs on the model its agent would use in-process, routed by the worker's `cogitator`, so give the worker the same `llm.backends`, plugins and provider keys as the process that runs the swarm.

---

## Job Results

Each job type returns a specific result structure.

### Agent Job Result

```typescript
interface AgentJobResult {
  type: 'agent';
  output: string;
  toolCalls: {
    name: string;
    input: unknown;
    output: unknown;
  }[];
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
}
```

### Workflow Job Result

```typescript
interface WorkflowJobResult {
  type: 'workflow';
  output: Record<string, unknown>;
  nodeResults: Record<string, unknown>;
  duration: number;
}
```

### Swarm Job Result

```typescript
interface SwarmJobResult {
  type: 'swarm';
  output: string;
  rounds: number;
  agentOutputs: {
    agent: string;
    output: string;
  }[];
}
```

---

## Prometheus Metrics

Built-in metrics for monitoring and Kubernetes HPA.

### Exposing Metrics

```typescript
import { JobQueue, WorkerPool } from '@cogitator-ai/worker';
import express from 'express';

const queue = new JobQueue({ redis: { host: 'localhost', port: 6379 } });
const pool = new WorkerPool({ redis: { host: 'localhost', port: 6379 } });
await pool.start();

const app = express();

app.get('/metrics', async (req, res) => {
  const queueMetrics = await queue.getMetrics(); // workerCount = workers connected to the queue
  res.type('text/plain').send(pool.metrics.format(queueMetrics));
});

app.listen(9090);
```

### Available Metrics

| Metric                           | Type      | Description                                                 |
| -------------------------------- | --------- | ----------------------------------------------------------- |
| `cogitator_queue_depth`          | gauge     | Total waiting + delayed jobs                                |
| `cogitator_queue_waiting`        | gauge     | Jobs ready to run, prioritized jobs included                |
| `cogitator_queue_active`         | gauge     | Jobs currently being processed                              |
| `cogitator_queue_completed`      | gauge     | Completed jobs kept in Redis (capped by `removeOnComplete`) |
| `cogitator_queue_failed`         | gauge     | Failed jobs kept in Redis (capped by `removeOnFail`)        |
| `cogitator_queue_delayed`        | gauge     | Scheduled/delayed jobs                                      |
| `cogitator_workers_total`        | gauge     | Workers connected to the queue                              |
| `cogitator_job_duration_seconds` | histogram | Job processing time                                         |
| `cogitator_jobs_by_type_total`   | counter   | Jobs by type                                                |
| `cogitator_jobs_failed_total`    | counter   | Jobs that failed their last attempt, by `type`              |

`cogitator_queue_completed` and `cogitator_queue_failed` can go down as BullMQ trims old jobs, so alert on `cogitator_jobs_failed_total` instead (for example `increase(cogitator_jobs_failed_total[5m]) > 5`). The per-type counters appear after the first job of that kind.

### Duration Histogram

```typescript
import { DurationHistogram } from '@cogitator-ai/worker';

const histogram = new DurationHistogram('my_duration_seconds', 'Custom duration tracking');

histogram.observe(0.5);
histogram.observe(1.2);
histogram.observe(0.8);

console.log(histogram.format({ queue: 'main' }));

histogram.reset();
```

### Metrics Collector

`WorkerPool` keeps one in `pool.metrics`: it calls `recordJob(type, durationMs)` for each completed job and `recordFailure(type)` for each job that failed its last attempt (retried attempts are not counted). Use your own collector when you process jobs outside the pool.

```typescript
import { MetricsCollector } from '@cogitator-ai/worker';

const collector = new MetricsCollector();

collector.recordJob('agent', 1500);
collector.recordJob('workflow', 3200);
collector.recordFailure('agent');

const output = collector.format(queueMetrics, { queue: 'main' });
```

### Kubernetes HPA Example

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cogitator-workers
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cogitator-workers
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: External
      external:
        metric:
          name: cogitator_queue_depth
        target:
          type: AverageValue
          averageValue: 10
```

---

## Redis Configuration

### Single Node

```typescript
const queue = new JobQueue({
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'secret',
  },
});
```

### Redis Cluster

Queues and workers connect to all cluster nodes (keys use the `{cogitator}` hash tag so they live in one slot):

```typescript
const queue = new JobQueue({
  redis: {
    cluster: {
      nodes: [
        { host: 'redis-1', port: 6379 },
        { host: 'redis-2', port: 6379 },
        { host: 'redis-3', port: 6379 },
      ],
    },
    password: 'secret',
  },
});
```

---

## Serialized Types

Jobs use serialized configurations that can be stored in Redis.

### SerializedAgent

```typescript
interface SerializedAgent {
  name: string;
  instructions: string;
  model: string; // routed like in-process: a known provider prefix picks the provider
  provider?: LLMBackendProvider; // prepended when model names no provider the worker routes to
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  tools: ToolSchema[]; // resolved by name against the worker's tools
}
```

### SerializedWorkflow

```typescript
interface SerializedWorkflow {
  id: string;
  name: string;
  nodes: SerializedWorkflowNode[];
  edges: SerializedWorkflowEdge[];
}

interface SerializedWorkflowNode {
  id: string;
  type: 'agent' | 'transform' | 'condition' | 'parallel';
  config: Record<string, unknown>;
}

interface SerializedWorkflowEdge {
  from: string;
  to: string;
  condition?: string; // 'true' | 'false' for edges leaving condition nodes
}
```

Node configs are typed as `AgentNodeConfig`, `TransformNodeConfig` and `ConditionNodeConfig`.

### SerializedSwarm

```typescript
interface SerializedSwarm {
  topology: 'sequential' | 'hierarchical' | 'collaborative' | 'debate' | 'voting';
  agents: SerializedAgent[];
  coordinator?: SerializedAgent;
  maxRounds?: number;
  consensusThreshold?: number;
}
```

---

## Examples

### Complete Producer/Consumer

**Producer (producer.ts):**

```typescript
import { JobQueue } from '@cogitator-ai/worker';

const queue = new JobQueue({
  redis: { host: 'localhost', port: 6379 },
});

async function main() {
  const agentConfig = {
    name: 'Summarizer',
    instructions: 'Summarize the given text concisely.',
    model: 'openai/gpt-6.1-sol',
    provider: 'openai' as const,
    tools: [],
  };

  const texts = [
    'Long article about technology...',
    'Research paper on climate change...',
    'News story about economics...',
  ];

  for (const text of texts) {
    const job = await queue.addAgentJob(agentConfig, text, {
      priority: 1,
    });
    console.log(`Queued job: ${job.id}`);
  }

  await queue.close();
}

main();
```

**Consumer (consumer.ts):**

```typescript
import { WorkerPool } from '@cogitator-ai/worker';

const pool = new WorkerPool(
  {
    redis: { host: 'localhost', port: 6379 },
    concurrency: 5,
  },
  {
    onJobStarted: (id, type) => console.log(`Starting ${type} job: ${id}`),
    onJobCompleted: (id, result) => console.log(`Completed: ${id}`, result),
    onJobFailed: (id, error) => console.error(`Failed: ${id}`, error),
  }
);

async function main() {
  await pool.start();
  console.log('Worker pool started');

  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await pool.stop(30000);
    process.exit(0);
  });
}

main();
```

### Job Status Monitoring

```typescript
import { JobQueue } from '@cogitator-ai/worker';

const queue = new JobQueue({
  redis: { host: 'localhost', port: 6379 },
});

async function monitorJob(jobId: string) {
  let lastState = '';

  while (true) {
    const state = await queue.getJobState(jobId);

    if (state !== lastState) {
      console.log(`Job ${jobId}: ${state}`);
      lastState = state;
    }

    if (state === 'completed' || state === 'failed') {
      const job = await queue.getJob(jobId);
      if (job) {
        console.log('Result:', await job.returnvalue);
      }
      break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

### Priority Processing

```typescript
await queue.addAgentJob(config, 'Low priority', { priority: 10 });
await queue.addAgentJob(config, 'Medium priority', { priority: 5 });
await queue.addAgentJob(config, 'High priority', { priority: 1 });
await queue.addAgentJob(config, 'Critical', { priority: 0 });
```

### Delayed Jobs

```typescript
await queue.addAgentJob(config, 'Run in 5 seconds', { delay: 5000 });
await queue.addAgentJob(config, 'Run in 1 minute', { delay: 60000 });
await queue.addAgentJob(config, 'Run in 1 hour', { delay: 3600000 });
```

---

## Type Reference

```typescript
import type {
  // Serialized configs
  SerializedAgent,
  SerializedWorkflow,
  SerializedWorkflowNode,
  SerializedWorkflowEdge,
  AgentNodeConfig,
  TransformNodeConfig,
  ConditionNodeConfig,
  SerializedSwarm,

  // Job payloads
  JobPayload,
  AgentJobPayload,
  WorkflowJobPayload,
  SwarmJobPayload,
  SwarmAgentJobPayload,

  // Job results
  JobResult,
  AgentJobResult,
  WorkflowJobResult,
  SwarmJobResult,
  SwarmAgentJobResult,

  // Configuration
  QueueConfig,
  WorkerConfig,
  WorkerRuntime,
  QueueMetrics,
  JobState,
  DistributedSwarmWorkerConfig,
  DistributedSwarmWorkerEvents,
} from '@cogitator-ai/worker';
```

---

## License

MIT
