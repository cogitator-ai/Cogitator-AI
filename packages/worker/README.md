# @cogitator-ai/worker

Distributed job queue for Cogitator agent execution. Built on BullMQ for reliable, scalable background processing.

## Installation

```bash
pnpm add @cogitator-ai/worker ioredis
```

## Usage

### Job Queue

Add jobs for background execution:

```typescript
import { JobQueue } from '@cogitator-ai/worker';

const queue = new JobQueue({
  redis: { url: 'redis://localhost:6379' },
});

// Add agent job
await queue.addAgentJob({
  agentId: 'my-agent',
  input: 'Process this task',
  threadId: 'thread-123',
});

// Add workflow job
await queue.addWorkflowJob({
  workflowId: 'data-pipeline',
  input: { data: [...] },
});

// Add swarm job
await queue.addSwarmJob({
  swarmId: 'research-team',
  input: 'Research AI trends',
});
```

### Worker Pool

Process jobs with configurable concurrency:

```typescript
import { WorkerPool } from '@cogitator-ai/worker';
import { Cogitator } from '@cogitator-ai/core';

const cogitator = new Cogitator();
const pool = new WorkerPool(cogitator, {
  redis: { url: 'redis://localhost:6379' },
  concurrency: 5,
});

await pool.start();
```

### Metrics

Prometheus-compatible metrics for HPA:

```typescript
import { MetricsCollector, formatPrometheusMetrics } from '@cogitator-ai/worker';

const metrics = new MetricsCollector(queue);

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  const data = await metrics.collect();
  res.send(formatPrometheusMetrics(data));
});
```

### Available Metrics

- `cogitator_queue_depth` - Total waiting + delayed jobs
- `cogitator_queue_waiting` - Jobs waiting
- `cogitator_queue_active` - Jobs processing
- `cogitator_queue_completed_total` - Completed jobs
- `cogitator_queue_failed_total` - Failed jobs
- `cogitator_workers_total` - Active workers

## Environment Variables

- `REDIS_URL` - Redis connection URL
- `WORKER_CONCURRENCY` - Jobs per worker (default: 5)

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
