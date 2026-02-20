import { header, section, requireEnv } from '../_shared/setup.js';
import {
  JobQueue,
  WorkerPool,
  formatPrometheusMetrics,
  MetricsCollector,
  type SerializedAgent,
} from '@cogitator-ai/worker';

const REDIS_URL = requireEnv('REDIS_URL');

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

async function main() {
  header('03 — Worker Queue: Distributed Agent Execution');

  const redis = parseRedisUrl(REDIS_URL);

  section('1. Create job queue');

  const queue = new JobQueue({
    name: 'example-jobs',
    redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });

  console.log('Job queue created');

  section('2. Create worker pool');

  const metrics = new MetricsCollector();

  const pool = new WorkerPool(
    {
      name: 'example-jobs',
      redis,
      workerCount: 2,
      concurrency: 3,
    },
    {
      onJobStarted: (jobId, type) => {
        console.log(`  [worker] Job started: ${jobId} (${type})`);
      },
      onJobCompleted: (jobId, result) => {
        console.log(`  [worker] Job completed: ${jobId} -> ${result.type}`);
        metrics.recordJob(result.type, 500);
      },
      onJobFailed: (jobId, error) => {
        console.log(`  [worker] Job failed: ${jobId} -> ${error.message}`);
      },
      onWorkerError: (error) => {
        console.error('  [worker] Error:', error.message);
      },
    }
  );

  await pool.start();
  console.log(`Worker pool started (${pool.getWorkerCount()} workers)`);

  section('3. Enqueue agent jobs');

  const summarizer: SerializedAgent = {
    name: 'summarizer',
    instructions: 'Summarize the given text in one sentence.',
    model: 'google/gemini-2.5-flash',
    provider: 'openai',
    temperature: 0.3,
    tools: [],
  };

  const translator: SerializedAgent = {
    name: 'translator',
    instructions: 'Translate the given text to French.',
    model: 'google/gemini-2.5-flash',
    provider: 'openai',
    temperature: 0.2,
    tools: [],
  };

  const job1 = await queue.addAgentJob(
    summarizer,
    'Artificial intelligence is transforming industries from healthcare to finance, enabling new capabilities in pattern recognition, natural language processing, and autonomous decision-making.',
    { priority: 1, metadata: { source: 'example' } }
  );
  console.log(`Enqueued summarizer job: ${job1.id}`);

  const job2 = await queue.addAgentJob(translator, 'The quick brown fox jumps over the lazy dog.', {
    priority: 2,
  });
  console.log(`Enqueued translator job: ${job2.id}`);

  const job3 = await queue.addAgentJob(
    summarizer,
    'Machine learning models require large datasets for training, careful hyperparameter tuning, and robust evaluation metrics to ensure reliable performance in production environments.',
    { delay: 1000, metadata: { delayed: true } }
  );
  console.log(`Enqueued delayed job: ${job3.id} (1s delay)`);

  section('4. Monitor queue metrics');

  const queueMetrics = await queue.getMetrics();
  console.log('Queue metrics:');
  console.log(`  Waiting:   ${queueMetrics.waiting}`);
  console.log(`  Active:    ${queueMetrics.active}`);
  console.log(`  Completed: ${queueMetrics.completed}`);
  console.log(`  Failed:    ${queueMetrics.failed}`);
  console.log(`  Delayed:   ${queueMetrics.delayed}`);
  console.log(`  Depth:     ${queueMetrics.depth}`);

  section('5. Prometheus metrics');

  const prometheus = formatPrometheusMetrics(queueMetrics, { queue: 'example-jobs' });
  console.log(prometheus);

  section('6. Full metrics with histogram');

  metrics.recordJob('agent', 1200);
  metrics.recordJob('agent', 800);
  metrics.recordJob('agent', 3500);

  const fullMetrics = metrics.format(queueMetrics, { queue: 'example-jobs' });
  console.log(fullMetrics);

  section('7. Job state tracking');

  const state1 = await queue.getJobState(job1.id!);
  const state2 = await queue.getJobState(job2.id!);
  const state3 = await queue.getJobState(job3.id!);
  console.log(`Job ${job1.id}: ${state1}`);
  console.log(`Job ${job2.id}: ${state2}`);
  console.log(`Job ${job3.id}: ${state3}`);

  section('8. Worker pool info');

  const poolMetrics = await pool.getMetrics({
    waiting: queueMetrics.waiting,
    active: queueMetrics.active,
    completed: queueMetrics.completed,
    failed: queueMetrics.failed,
    delayed: queueMetrics.delayed,
    depth: queueMetrics.depth,
  });
  console.log(`Workers: ${poolMetrics.workerCount}`);
  console.log(`Running: ${pool.isPoolRunning()}`);

  section('9. Graceful shutdown');

  await pool.stop();
  console.log('Worker pool stopped');

  await queue.close();
  console.log('Queue closed');

  console.log('\nDone.');
}

main();
