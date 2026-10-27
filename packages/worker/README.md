# @cogitator-ai/worker

Distributed job queue for Cogitator agent execution. Built on BullMQ for reliable, scalable background processing.

## Installation

```bash
pnpm add @cogitator-ai/worker @cogitator-ai/core ioredis
```

BullMQ, `@cogitator-ai/swarms` and `@cogitator-ai/workflows` come as dependencies, `ioredis` is a peer dependency. Website docs: [Worker Queues](https://cogitator.app/docs/deployment/worker-queues), [Distributed Swarms](https://cogitator.app/docs/swarms/distributed).

## Features

- **BullMQ-Based** - Reliable job processing with Redis
- **Job Types** - Agents, workflow graphs, swarms and distributed swarm turns
- **Worker Runtime** - Run jobs with your own `Cogitator` (provider keys, memory) and tool implementations
- **Distributed Swarms** - `DistributedSwarmWorker` executes agent turns for `@cogitator-ai/swarms`
- **Auto-Retry** - Exponential backoff for failed jobs, a retried workflow job goes on from its last checkpoint, a durable agent job (`durable: true`) from its last step
- **Job Ids** - Adding a job under an id the queue holds gives that job back, so producers can retry an add
- **Usage** - Workflow and swarm results carry tokens and cost, the metrics count them by job type
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
    url?: string; // 'redis://user:password@host:port/db', 'rediss://' for TLS
    host?: string; // Default: 'localhost'
    port?: number; // Default: 6379
    username?: string;
    password?: string;
    db?: number;
    tls?: boolean; // implied by a rediss:// url
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

`redis` is the `RedisConnectionConfig` of `@cogitator-ai/types`, the same config `DistributedSwarmWorker` and distributed swarms take. `resolveRedisOptions(redis)` gives the settings it resolves to for one server.

### Adding Jobs

**Agent Jobs:**

The simplest way is to serialize an agent you already have. `serializeAgent` writes it in the agent wire format of `@cogitator-ai/core` (`toAgentWire`), shared by agent, workflow and swarm jobs and by distributed swarm turns. It keeps the whole configuration (model and provider, fallback models, instructions, sampling, stop sequences, reasoning effort, response format, iteration limit, timeout), the tool schemas and every agent it can hand over to, and turns a Zod response schema into JSON Schema, so the worker validates the structured answer the same way an in-process run does. A config with a key the worker does not know is refused rather than run without that setting:

```typescript
import { Agent } from '@cogitator-ai/core';
import { serializeAgent } from '@cogitator-ai/worker';
import { z } from 'zod';

const Verdict = z.object({ verdict: z.enum(['run', 'hold']), reason: z.string() });
const chief = new Agent({
  name: 'chief',
  model: 'openrouter/openai/gpt-6-luna',
  instructions: 'Decide whether the pitch runs.',
  reasoning: { effort: 'medium' },
  responseFormat: { type: 'json_schema', schema: Verdict },
});

const job = await queue.addAgentJob(serializeAgent(chief), 'A pitch about ...');
// later: (await queue.getJob(job.id))?.returnvalue.structured -> { verdict, reason }
```

Or write the serialized form by hand:

```typescript
const agentConfig: SerializedAgent = {
  name: 'Researcher',
  instructions: 'Research and summarize topics.',
  model: 'openai/gpt-6.1-sol', // or 'gpt-6.1-sol' - the provider is prepended when missing
  provider: 'openai',
  temperature: 0.7,
  maxTokens: 2048,
  maxIterations: 5,
  reasoning: { effort: 'low' }, // optional
  responseFormat: { type: 'json_schema', schema: { type: 'object', properties: {} } }, // optional, JSON Schema
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

The worker routes `model` exactly like the same agent in-process: a prefix that names a built-in provider, a backend in the worker Cogitator's `llm.backends` or a registered plugin picks that provider, so `'openrouter/deepseek/deepseek-v4-pro'` runs on an `openrouter` backend whatever `provider` says. `provider` (optional, any provider the worker routes to, custom backends and plugins included) is prepended only to a model whose prefix names none, such as `'meta-llama/llama-4-scout'` with `provider: 'openrouter'`. Without `provider` such a model runs on the worker's `llm.defaultProvider`, and a `provider` the worker cannot route to fails the job. `serializeAgent` sends an agent with an explicit `provider` as `<provider>/<model>`, so it takes the same route on the worker as in-process.

**Workflow Jobs:**

Workflow jobs run on the `WorkflowExecutor` of `@cogitator-ai/workflows`, over a shared state object initialised from the job input. Nodes run in rounds, each running at once every node whose nodes before it all settled, and a graph with many roots starts at all of them.

```typescript
const workflowConfig: SerializedWorkflow = {
  id: 'triage',
  name: 'Ticket triage',
  nodes: [
    {
      id: 'classify',
      type: 'agent',
      config: {
        agentConfig: classifierAgent, // SerializedAgent; a json_schema agent writes its structured answer
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

Node outputs are stored in the state under `outputKey` (default: node id). Nodes reachable only through untaken condition branches are skipped (`{ skipped: true }` in `nodeResults`). Graphs are validated before execution (unknown nodes, invalid configs, cycles). The run keeps its own bookkeeping (which nodes ran, the branch a condition took, the usage of each agent node) in state keys starting with `__cogitator:`, which are left out of the job's `output`. Input keys, node ids and output keys starting with `__cogitator:` are refused.

A workflow job keeps one checkpoint, saved over after every node under the job's id and `runId`, so jobs sharing a `runId` never resume from each other. A job BullMQ retries (`attempts`) goes on from it instead of running its finished agent nodes again. The checkpoint is deleted once the run finished, and once no attempt follows a failure: after the last attempt, a cancelled job or a paused agent run. A job a shutdown stopped keeps it for the worker that takes the job up. `WorkerPool` keeps the checkpoints in its Redis under `<queue prefix>:<queue name>:workflow-checkpoints` (`cogitator`, or `{cogitator}` in cluster mode) for `checkpointTtl` seconds after the last save (7 days by default), so the checkpoint of a run whose worker crashed goes on its own. `checkpoints` in the worker config takes a `CheckpointStore` of your own.

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

| Topology        | Swarm strategy | Notes                                                                                                                                                                          |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sequential`    | `pipeline`     | One stage per agent, in order                                                                                                                                                  |
| `hierarchical`  | `hierarchical` | `coordinator` is required and becomes the supervisor                                                                                                                           |
| `collaborative` | `pipeline`     | Every agent contributes in each of `maxRounds` rounds (default 3), seeing all contributions so far, `coordinator` combines them, otherwise the last contribution is the answer |
| `debate`        | `debate`       | `maxRounds` rounds, `coordinator` moderates                                                                                                                                    |
| `voting`        | `consensus`    | `consensusThreshold`, `maxRounds`, `coordinator` breaks ties                                                                                                                   |

**Job Ids:**

`addAgentJob`, `resumeAgentJob`, `addWorkflowJob`, `addSwarmJob` and `addSwarmAgentJob` take a `jobId`, and the job is added under it. Adding a job whose id the queue holds already gives that job back instead of adding a second one, so a producer can retry an add, such as after a timeout, without running the work twice:

```typescript
const job = await queue.addWorkflowJob(workflowConfig, input, { jobId: `triage-${ticketId}` });
const again = await queue.addWorkflowJob(workflowConfig, input, { jobId: `triage-${ticketId}` });
// again.id === job.id, one job runs
```

Two adds racing with the same id both get the job the queue holds. A job the queue removed (past `removeOnComplete` or `removeOnFail`) is gone, and its id adds a new job. BullMQ builds Redis keys from the id, so an empty id, one with `:`, an integer and a name of the queue's own keys (`meta`, `id`, `events`, `stalled-check` and the like) are refused, and an id the queue holds as another kind of job (an agent job for `addWorkflowJob`, say) throws. Without `jobId` every add gets a new id.

### Queue Methods

```typescript
const job = await queue.getJob('job-id');

const state: JobState = await queue.getJobState('job-id');
// 'waiting' | 'prioritized' | 'delayed' | 'active' | 'completed' | 'failed'
// | 'waiting-children' | 'unknown'

await queue.resumeAgentJob(agentConfig, pausedResult, { decisions }); // see Job Results
await queue.resumeAgentJob(agentConfig, askedResult, {
  responses: { [askedResult.interrupts![0].id]: 'eu' },
}); // a tool's question

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
  checkpoints?: CheckpointStore; // Where workflow jobs keep their checkpoints. Default: the pool's Redis
  checkpointTtl?: number; // Seconds the default store keeps a checkpoint after its last save. Default: 7 days
  durable?: boolean; // Agent jobs go on from their last step on the next attempt. Default: false
}
```

| Option            | Default | Description                                |
| ----------------- | ------- | ------------------------------------------ |
| `workerCount`     | 1       | Number of worker instances                 |
| `concurrency`     | 5       | Concurrent jobs per worker                 |
| `lockDuration`    | 30000   | Lock timeout before job considered stalled |
| `stalledInterval` | 30000   | Interval to check for stalled jobs         |

### Durable Agent Jobs

With `durable: true` every agent job runs as a durable run named after the job (`job:<jobId>`): it keeps a checkpoint after every model turn and tool batch. When a worker crashes or the pool shuts down mid-job, the next attempt (on this worker or another) recovers the run and goes on from its last step instead of running the whole job again. A tool call that returned keeps its result and never runs twice, one that was running reaches the model as "outcome unknown, verify before retrying". On `stop()` and `forceStop()` the pool aborts its durable runs with `RUN_SUSPENDED`, so they hand over at once instead of waiting for their lease. When BullMQ hands a stalled job on while its run is still held, the job is delayed until the run's lease runs out instead of using up an attempt.

```typescript
const pool = new WorkerPool({ redis, tools, durable: true });
```

All workers must share the store. The pool's own Cogitator (no `cogitator` given) keeps the runs in its Redis under the queue's prefix. A Cogitator you pass needs a shared store, and `enabled: false` keeps its other runs as they were:

```typescript
import { Cogitator, RedisDurableRunStore } from '@cogitator-ai/core';

const cogitator = new Cogitator({
  durable: { store: new RedisDurableRunStore({ client: redisClient }), enabled: false },
});
const pool = new WorkerPool({ redis, cogitator, tools, durable: true });
```

`processAgentJob(payload, runtime, { durable: true })` does the same when you call the processor yourself. See [Durable runs](https://cogitator.app/docs/core/durable-runs).

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

// Cancel a job this pool is running: its agent runs stop and the job fails without retries
pool.cancelJob(jobId, 'No longer needed');

// Graceful shutdown (waits up to 30s for active jobs, then aborts them and force-closes;
// BullMQ hands the aborted jobs to another worker once their locks expire)
await pool.stop(30000);

// Force shutdown (aborts the jobs still running)
await pool.forceStop();
```

Every job gets the abort signal BullMQ gives it, down to each agent run, workflow node and swarm turn of the job. The processors take it too: `processAgentJob(payload, runtime, { signal })`, and the same third argument for `processWorkflowJob`, `processSwarmJob` and `executeSwarmAgentJob` (`processSwarmAgentJob` reads `signal` from its options).

---

## Job Processors

Built-in processors handle each job type.

### Using Processors Directly

Processors take the job payload and an optional runtime (`{ cogitator, tools, checkpoints }`):

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

`processWorkflowJob` called on its own runs without checkpoints unless the runtime has `checkpoints` (a `CheckpointStore`). With them, pass `{ willRetry }` as the third argument: a run whose failure another attempt follows (`willRetry(error)` returns `true`) keeps its checkpoint for it, any other failure deletes it.

`processSwarmAgentJob(payload, { publisher, isFinalAttempt, ...runtime })` executes one distributed swarm turn and hands the result (tagged with the job id) to the coordinator with `deliverSwarmJobResult` of `@cogitator-ai/swarms`: when the job names `stateKeys.result` and the publisher has `set`, the result is kept there for `payload.resultTtl` ms (one hour by default), then it is published to `payload.stateKeys.results`. `publisher` is a `SwarmResultPublisher`, now an alias of `SwarmResultClient` (`publish`, optional `set`). `executeSwarmAgentJob` returns the result without publishing.

---

## Distributed Swarm Workers

Swarms created with `distributed.enabled` (see `@cogitator-ai/swarms`) dispatch every agent turn to a Redis queue. `DistributedSwarmWorker` consumes those turns:

```typescript
import { Cogitator } from '@cogitator-ai/core';
import { DistributedSwarmWorker } from '@cogitator-ai/worker';

const worker = new DistributedSwarmWorker(
  {
    redis: { url: 'redis://localhost:6379' }, // the same Redis as the swarm's distributed.redis
    keyPrefix: 'swarm', // must match the swarm's distributed.redis.keyPrefix
    queue: 'swarm-agent-jobs', // must match distributed.queue
    concurrency: 4,
    cogitator: new Cogitator({ llm: { defaultModel: 'ollama/llama3.2' } }),
    tools: [searchTool],
  },
  {
    onJobCompleted: (job) => console.log('done', job.agentName),
    onJobFailed: (job, error) => console.error(job.agentName, error.message),
    onJobCancelled: (job) => console.log('the swarm gave up on', job.jobId),
    onJobsRecovered: (workerId, count) => console.warn(`${count} turns of ${workerId} requeued`),
    onError: (error) => console.error(error),
  }
);

await worker.start();
process.on('SIGTERM', () => void worker.stop()); // waits for in-flight turns
```

Failed turns are reported back to the swarm as errors, so the swarm's own `errorHandling` (retry, failover, skip) applies. A turn the swarm gave up on (its run aborted or timed out, the swarm closed, another attempt answered) is skipped, or aborted while it runs (checked every `cancelCheckInterval` ms, default 1000), and reported to `onJobCancelled` instead of being published. Each turn runs on the model its agent would use in-process, routed by the worker's `cogitator`, so give the worker the same `llm.backends`, plugins and provider keys as the process that runs the swarm.

`redis` takes a `url` (`rediss://` for TLS), `host`, `port`, `username`, `password`, `db`, `tls` or `cluster.nodes`, like the queue. The turns sit in the list `<keyPrefix>:jobs:{<queue>}`, whose braces are a Redis Cluster hash tag that keeps the queue and its worker keys in one slot. Earlier versions used `<keyPrefix>:jobs:<queue>`, so upgrade the processes that run swarms and the workers together.

The queue is reliable:

- A worker moves each turn with `BLMOVE` (Redis 6.2 or newer) from the queue to its own list `<queue key>:processing:<workerId>`, and takes it off once the turn is done.
- Every `heartbeatInterval` ms (default 5000) it sets its heartbeat key `<queue key>:heartbeat:<workerId>`, which expires after three intervals, and stays in the set `<queue key>:workers`.
- On `start()` and on every beat, a worker moves the turns of workers whose heartbeat is gone back to the head of the queue, drops those workers from the set and reports `onJobsRecovered(workerId, count)`.
- A worker also checks its own list on every beat: a turn on it that the worker does not run at two beats in a row, such as one a `BLMOVE` moved while a dropped connection lost its reply, goes back to the head of the queue and is reported with the worker's own id.
- A worker silent for three intervals counts as gone, so a turn on a stalled worker can run twice.
- The result is kept under the job's `stateKeys.result` for `resultTtl` ms before it is published, so the coordinator finds it after a missed message, and a worker skips a job whose result is there (such as one a dead worker answered before it took the turn off its list). A result the worker cannot keep under its key is still published.
- `stop()` waits for in-flight turns, hands back what is left on its list, leaves the set and deletes its heartbeat. `getWorkerId()` gives the worker's id, new on every `start()`.

---

## Job Results

Each job type returns a specific result structure.

### Agent Job Result

```typescript
interface AgentJobResult {
  type: 'agent';
  output: string;
  structured?: unknown; // the validated answer of a json_schema agent, when it fits
  reasoning?: string; // the reasoning summary, when the agent asked for one
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number; // USD, as the run reported it
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  toolCalls: {
    name: string;
    input: unknown;
    output: unknown;
  }[];
  /** 'paused' when tool calls wait for approval: output is then not the answer */
  status?: 'completed' | 'paused';
  pendingApprovals?: ToolApprovalRequest[]; // the calls a paused run waits on
  checkpoint?: RunCheckpoint; // what a paused run continues from, see resumeAgentJob
  /** @deprecated use usage */
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
}
```

A run that paused for tool approvals completes its job with `status: 'paused'`. Continue it with the decisions as a new job, on any worker:

```typescript
if (result.status === 'paused') {
  await queue.resumeAgentJob(agentConfig, result, {
    decisions: { [result.pendingApprovals![0].toolCallId]: { approved: true } },
  });
}
```

Workflow and swarm jobs cannot wait for a decision: when one of their agents pauses, the job fails without retries with an `AgentRunPausedError`.

### Workflow Job Result

```typescript
interface WorkflowJobResult {
  type: 'workflow';
  output: Record<string, unknown>;
  nodeResults: Record<string, unknown>;
  usage: JobUsage; // what the agent nodes used and cost
  duration: number;
}

interface JobUsage {
  inputTokens?: number; // absent where the runs reported only their totals
  outputTokens?: number;
  totalTokens: number;
  cost: number; // USD
  runs: number; // agent runs counted
}
```

### Swarm Job Result

```typescript
interface SwarmJobResult {
  type: 'swarm';
  output: string;
  rounds: number;
  // what the swarm's agent runs used and cost, in all and by agent
  usage: JobUsage & { byAgent: Record<string, { tokens: number; cost: number; runs: number }> };
  agentOutputs: {
    agent: string;
    output: string;
  }[];
}
```

A swarm reports only total tokens, so its `usage` has no `inputTokens` or `outputTokens`.

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

| Metric                              | Type      | Description                                                 |
| ----------------------------------- | --------- | ----------------------------------------------------------- |
| `cogitator_queue_depth`             | gauge     | Total waiting + delayed jobs                                |
| `cogitator_queue_waiting`           | gauge     | Jobs ready to run, prioritized jobs included                |
| `cogitator_queue_active`            | gauge     | Jobs currently being processed                              |
| `cogitator_queue_completed`         | gauge     | Completed jobs kept in Redis (capped by `removeOnComplete`) |
| `cogitator_queue_failed`            | gauge     | Failed jobs kept in Redis (capped by `removeOnFail`)        |
| `cogitator_queue_delayed`           | gauge     | Scheduled/delayed jobs                                      |
| `cogitator_workers_total`           | gauge     | Workers connected to the queue                              |
| `cogitator_job_duration_seconds`    | histogram | Job processing time                                         |
| `cogitator_jobs_by_type_total`      | counter   | Jobs by type                                                |
| `cogitator_jobs_failed_total`       | counter   | Jobs that failed their last attempt, by `type`              |
| `cogitator_job_tokens_total`        | counter   | Tokens the agent runs of completed jobs used, by `type`     |
| `cogitator_job_input_tokens_total`  | counter   | Input tokens of completed jobs, by `type`                   |
| `cogitator_job_output_tokens_total` | counter   | Output tokens of completed jobs, by `type`                  |
| `cogitator_job_cost_usd_total`      | counter   | USD the agent runs of completed jobs cost, by `type`        |

`cogitator_queue_completed` and `cogitator_queue_failed` can go down as BullMQ trims old jobs, so alert on `cogitator_jobs_failed_total` instead (for example `increase(cogitator_jobs_failed_total[5m]) > 5`). The per-type counters appear after the first job of that kind. The usage counters take the `usage` of completed agent, workflow, swarm and swarm-agent jobs, input and output tokens only where the job reported them apart (swarm jobs do not).

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

`WorkerPool` keeps one in `pool.metrics`: it calls `recordJob(type, durationMs)` and `recordUsage(type, result.usage)` for each completed job and `recordFailure(type)` for each job that failed its last attempt (retried attempts are not counted). Use your own collector when you process jobs outside the pool.

```typescript
import { MetricsCollector } from '@cogitator-ai/worker';

const collector = new MetricsCollector();

collector.recordJob('agent', 1500);
collector.recordJob('workflow', 3200);
collector.recordUsage('workflow', workflowResult.usage); // { inputTokens?, outputTokens?, totalTokens, cost }
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

`SerializedAgent` is `AgentWireConfig` from `@cogitator-ai/types`:

```typescript
interface SerializedAgent {
  id?: string;
  name: string;
  description?: string;
  instructions: string;
  model: string; // routed like in-process: a known provider prefix picks the provider
  provider?: LLMBackendProvider; // used when model names no provider the worker routes to
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?:
    { type: 'text' } | { type: 'json' } | { type: 'json_schema'; schema: JSONSchema };
  reasoning?: ReasoningConfig;
  maxIterations?: number;
  onIterationLimit?: 'answer' | 'stop';
  timeout?: number;
  tools: ToolSchema[]; // resolved by name against the worker's tools
  handoffs?: { agent: string; toolName?: string; description?: string }[];
  handoffAgents?: Record<string, Omit<SerializedAgent, 'handoffAgents'>>; // handoff targets by name
}
```

Unknown keys are refused. Agent job results (`AgentJobResult`) carry `output`, `structured`, `structuredError`, `reasoning`, `usage` (tokens, `cost`, `duration`, reasoning and cache tokens), `toolCalls` with their outputs, and `truncated`, `blocked` and `iterationLimitReached`.

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
  JobUsage,
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
