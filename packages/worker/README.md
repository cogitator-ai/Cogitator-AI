# @cogitator-ai/worker

Distributed job queue for Cogitator agent execution. Built on BullMQ for reliable, scalable background processing.

## Installation

```bash
pnpm add @cogitator-ai/worker ioredis
```

## Features

- **BullMQ-Based** - Reliable job processing with Redis
- **Job Types** - Agents, workflows, and swarms
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
  model: 'openai/gpt-4',
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
import { WorkerPool } from '@cogitator-ai/worker';

const pool = new WorkerPool({
  redis: { host: 'localhost', port: 6379 },
  concurrency: 5,
  workerCount: 2,
});

await pool.start();
```

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
  model: 'openai/gpt-4',
  provider: 'openai',
  temperature: 0.7,
  maxTokens: 2048,
  tools: [
    {
      name: 'search',
      description: 'Search the web',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ],
};

const job = await queue.addAgentJob(agentConfig, 'Research quantum computing', {
  threadId: 'thread-123',
  priority: 1, // Lower = higher priority
  delay: 5000, // Delay 5 seconds
  metadata: { userId: 'user-456' },
});
```

**Workflow Jobs:**

```typescript
const workflowConfig: SerializedWorkflow = {
  id: 'data-pipeline',
  name: 'Data Pipeline',
  nodes: [
    { id: 'fetch', type: 'agent', config: { agentConfig: fetchAgent } },
    { id: 'process', type: 'transform', config: { transform: 'uppercase' } },
    { id: 'store', type: 'agent', config: { agentConfig: storeAgent } },
  ],
  edges: [
    { from: 'fetch', to: 'process' },
    { from: 'process', to: 'store' },
  ],
};

await queue.addWorkflowJob(
  workflowConfig,
  { source: 'api' },
  {
    runId: 'run-789',
    priority: 2,
  }
);
```

**Swarm Jobs:**

```typescript
const swarmConfig: SerializedSwarm = {
  topology: 'collaborative',
  agents: [researcherConfig, writerConfig, editorConfig],
  coordinator: coordinatorConfig,
  maxRounds: 3,
  consensusThreshold: 0.8,
};

await queue.addSwarmJob(swarmConfig, 'Write an article about AI', {
  priority: 1,
  metadata: { project: 'blog' },
});
```

### Queue Methods

```typescript
const job = await queue.getJob('job-id');

const state = await queue.getJobState('job-id');
// 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown'

const metrics = await queue.getMetrics();

await queue.pause();
await queue.resume();

await queue.clean(60 * 60 * 1000, 1000, 'completed');
await queue.clean(24 * 60 * 60 * 1000, 100, 'failed');

const bullQueue = queue.getQueue();

await queue.close();
```

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
  onJobStarted?: (jobId: string, type: 'agent' | 'workflow' | 'swarm') => void;
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

// Graceful shutdown (waits up to 30s for active jobs)
await pool.stop(30000);

// Force shutdown
await pool.forceStop();
```

---

## Job Processors

Built-in processors handle each job type.

### Using Processors Directly

```typescript
import { processAgentJob, processWorkflowJob, processSwarmJob } from '@cogitator-ai/worker';

const agentResult = await processAgentJob({
  type: 'agent',
  jobId: 'job-1',
  agentConfig: myAgentConfig,
  input: 'Hello!',
  threadId: 'thread-1',
});

const workflowResult = await processWorkflowJob({
  type: 'workflow',
  jobId: 'job-2',
  workflowConfig: myWorkflowConfig,
  input: { data: [] },
  runId: 'run-1',
});

const swarmResult = await processSwarmJob({
  type: 'swarm',
  jobId: 'job-3',
  swarmConfig: mySwarmConfig,
  input: 'Solve this problem',
});
```

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
import {
  JobQueue,
  WorkerPool,
  MetricsCollector,
  formatPrometheusMetrics,
} from '@cogitator-ai/worker';
import express from 'express';

const queue = new JobQueue({ redis: { host: 'localhost', port: 6379 } });
const pool = new WorkerPool({ redis: { host: 'localhost', port: 6379 } });
const metrics = new MetricsCollector();

const app = express();

app.get('/metrics', async (req, res) => {
  const queueMetrics = await queue.getMetrics();
  const fullMetrics = await pool.getMetrics(queueMetrics);
  res.type('text/plain').send(metrics.format(fullMetrics));
});

app.listen(9090);
```

### Available Metrics

| Metric                            | Type      | Description                    |
| --------------------------------- | --------- | ------------------------------ |
| `cogitator_queue_depth`           | gauge     | Total waiting + delayed jobs   |
| `cogitator_queue_waiting`         | gauge     | Jobs waiting to be processed   |
| `cogitator_queue_active`          | gauge     | Jobs currently being processed |
| `cogitator_queue_completed_total` | counter   | Total completed jobs           |
| `cogitator_queue_failed_total`    | counter   | Total failed jobs              |
| `cogitator_queue_delayed`         | gauge     | Scheduled/delayed jobs         |
| `cogitator_workers_total`         | gauge     | Active workers                 |
| `cogitator_job_duration_seconds`  | histogram | Job processing time            |
| `cogitator_jobs_by_type_total`    | counter   | Jobs by type                   |

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

```typescript
import { MetricsCollector } from '@cogitator-ai/worker';

const collector = new MetricsCollector();

collector.recordJob('agent', 1500);
collector.recordJob('workflow', 3200);

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
  model: string;
  provider: 'ollama' | 'openai' | 'anthropic';
  temperature?: number;
  maxTokens?: number;
  tools: ToolSchema[];
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
  condition?: string;
}
```

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
    model: 'openai/gpt-4',
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
  SerializedSwarm,

  // Job payloads
  JobPayload,
  AgentJobPayload,
  WorkflowJobPayload,
  SwarmJobPayload,

  // Job results
  JobResult,
  AgentJobResult,
  WorkflowJobResult,
  SwarmJobResult,

  // Configuration
  QueueConfig,
  WorkerConfig,
  QueueMetrics,
} from '@cogitator-ai/worker';
```

---

## License

MIT
