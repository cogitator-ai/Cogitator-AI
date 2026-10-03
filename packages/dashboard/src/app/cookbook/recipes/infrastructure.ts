import type { Section } from './types';

export const infrastructure: Section = {
  id: 'infrastructure',
  title: 'Infrastructure',
  icon: '🏗️',
  description:
    'Persistent memory in Redis and PostgreSQL, distributed job queues, sandboxed execution and deployment.',
  recipes: [
    {
      id: 'redis-memory',
      title: 'Redis Memory',
      difficulty: 'easy',
      time: '10 min',
      problem: 'Conversations must survive restarts and be shared by several server instances.',
      points: ['Configure the `redis` memory adapter with a key prefix and TTL'],
      file: 'redis-memory.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { unwrap } from '@cogitator-ai/memory';

const apiKey = process.env.GOOGLE_API_KEY;
const redisUrl = process.env.REDIS_URL;
if (!apiKey || !redisUrl) throw new Error('Set GOOGLE_API_KEY and REDIS_URL');

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: {
    adapter: 'redis',
    redis: { url: redisUrl, keyPrefix: 'cogbot:', ttl: 7200 },
    contextBuilder: { maxTokens: 4000, strategy: 'recent' },
  },
});

const agent = new Agent({
  name: 'redis-chatbot',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant with persistent memory. Be concise.',
  temperature: 0.3,
});

const threadId = 'redis-demo';

for (const input of [
  'My name is Jordan and I work at a startup called NovaTech.',
  "What's my name and where do I work?",
]) {
  const result = await cog.run(agent, { input, threadId });
  console.log(\`User: \${input}\\nAssistant: \${result.output}\\n\`);
}

if (cog.memory) {
  const stored = unwrap(await cog.memory.getEntries({ threadId }));
  console.log(\`\${stored.length} messages in Redis — run again and the agent still remembers.\`);
}

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/memory ioredis',
      setup: 'docker run -d --name redis -p 6379:6379 redis:7-alpine',
      env: ['GOOGLE_API_KEY', 'REDIS_URL=redis://localhost:6379'],
      run: 'GOOGLE_API_KEY=your-key REDIS_URL=redis://localhost:6379 npx tsx redis-memory.ts',
      repoRun: 'npx tsx examples/infrastructure/01-redis-memory.ts',
      example: 'infrastructure/01-redis-memory.ts',
      docs: [
        {
          href: '/docs/memory/adapters',
          label: 'Memory Adapters',
        },
        {
          href: '/docs/deployment/redis',
          label: 'Redis',
        },
      ],
    },
    {
      id: 'postgres-memory',
      title: 'PostgreSQL Memory & Facts',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'You need long-term memory in your database: threads plus facts about the user that you can search.',
      points: [
        'Store and search facts with `PostgresAdapter`',
        'Use the `postgres` memory adapter for agent threads',
      ],
      file: 'postgres-memory.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { PostgresAdapter, unwrap } from '@cogitator-ai/memory';

const apiKey = process.env.GOOGLE_API_KEY;
const connectionString = process.env.DATABASE_URL;
if (!apiKey || !connectionString) throw new Error('Set GOOGLE_API_KEY and DATABASE_URL');

const pg = new PostgresAdapter({
  provider: 'postgres',
  connectionString,
  schema: 'cogitator_example',
  poolSize: 5,
});
const connected = await pg.connect();
if (!connected.success) throw new Error(\`PostgreSQL: \${connected.error}\`);

await pg.addFact({
  agentId: 'pg-demo-agent',
  content: 'User prefers concise answers under 50 words',
  category: 'preference',
  confidence: 0.95,
  source: 'user',
});
await pg.addFact({
  agentId: 'pg-demo-agent',
  content: 'User works in the fintech industry',
  category: 'profile',
  confidence: 0.8,
  source: 'inferred',
});

for (const fact of unwrap(await pg.searchFacts('pg-demo-agent', 'fintech'))) {
  console.log(\`[\${fact.category}] \${fact.content}\`);
}
await pg.disconnect();

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: {
    adapter: 'postgres',
    postgres: { connectionString, schema: 'cogitator_example', poolSize: 5 },
    contextBuilder: { maxTokens: 4000, strategy: 'recent' },
  },
});

const agent = new Agent({
  name: 'pg-chatbot',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are an assistant with permanent memory stored in PostgreSQL. Be concise.',
  temperature: 0.3,
});

for (const input of [
  'Remember: my project deadline is March 15th and I need the Stripe and Plaid APIs.',
  'What is my deadline and which APIs do I need?',
]) {
  const result = await cog.run(agent, { input, threadId: 'pg-demo' });
  console.log(\`User: \${input}\\nAssistant: \${result.output}\\n\`);
}

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/memory pg',
      setup:
        'docker run -d --name postgres -p 5432:5432 -e POSTGRES_PASSWORD=cogitator postgres:16-alpine',
      env: [
        'GOOGLE_API_KEY',
        'DATABASE_URL=postgresql://postgres:cogitator@localhost:5432/postgres',
      ],
      run: 'GOOGLE_API_KEY=your-key DATABASE_URL=postgresql://postgres:cogitator@localhost:5432/postgres npx tsx postgres-memory.ts',
      repoRun: 'npx tsx examples/infrastructure/02-postgres-memory.ts',
      example: 'infrastructure/02-postgres-memory.ts',
      docs: [
        {
          href: '/docs/memory/adapters',
          label: 'Memory Adapters',
        },
      ],
    },
    {
      id: 'worker-queue',
      title: 'Distributed Job Queue',
      difficulty: 'advanced',
      time: '15 min',
      problem:
        'Agent runs should be queued, retried and processed by a pool of workers, with metrics for Prometheus.',
      points: [
        'Enqueue serialized agents with `JobQueue` (priority, delay, retries)',
        'Process them with `WorkerPool`',
        'Export queue metrics with `formatPrometheusMetrics()`',
      ],
      file: 'worker-queue.ts',
      code: `import { Cogitator } from '@cogitator-ai/core';
import { JobQueue, WorkerPool, formatPrometheusMetrics, type SerializedAgent } from '@cogitator-ai/worker';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const redis = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password || undefined,
};

const queue = new JobQueue({
  name: 'agent-jobs',
  redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  },
});

const finished = new Set<string>();
const pool = new WorkerPool(
  {
    name: 'agent-jobs',
    redis,
    workerCount: 2,
    concurrency: 3,
    cogitator: new Cogitator({ llm: { providers: { google: { apiKey } } } }),
  },
  {
    onJobCompleted: (jobId, result) => {
      console.log(\`done \${jobId}:\`, result.type === 'agent' ? result.output : result.type);
      finished.add(jobId);
    },
    onJobFailed: (jobId, error) => {
      console.log(\`failed \${jobId}: \${error.message}\`);
      finished.add(jobId);
    },
  }
);
await pool.start();

const summarizer: SerializedAgent = {
  name: 'summarizer',
  instructions: 'Summarize the given text in one sentence.',
  model: 'google/gemini-3.5-flash-lite',
  provider: 'google',
  temperature: 0.3,
  tools: [],
};

const jobs = await Promise.all([
  queue.addAgentJob(summarizer, 'AI is transforming industries from healthcare to finance.', { priority: 1 }),
  queue.addAgentJob(summarizer, 'Machine learning needs data, tuning and evaluation.', { delay: 1000 }),
]);

console.log(formatPrometheusMetrics(await queue.getMetrics(), { queue: 'agent-jobs' }));

const deadline = Date.now() + 60_000;
while (jobs.some((job) => job.id && !finished.has(job.id)) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

await pool.stop();
await queue.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/worker ioredis',
      setup: 'docker run -d --name redis -p 6379:6379 redis:7-alpine',
      env: ['GOOGLE_API_KEY', 'REDIS_URL=redis://localhost:6379'],
      run: 'GOOGLE_API_KEY=your-key REDIS_URL=redis://localhost:6379 npx tsx worker-queue.ts',
      repoRun: 'npx tsx examples/infrastructure/03-worker-queue.ts',
      example: 'infrastructure/03-worker-queue.ts',
      docs: [
        {
          href: '/docs/deployment/worker-queues',
          label: 'Worker Queues',
        },
      ],
    },
    {
      id: 'sandbox-execution',
      title: 'Sandboxed Execution',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'You need to run commands with limits — memory, CPU, no network, a timeout — in Docker when it is available.',
      points: [
        'Run a command with `NativeSandboxExecutor`',
        'Use `SandboxManager` with resource defaults and fall back from Docker to native',
        'Kill long runs with a timeout',
      ],
      file: 'sandbox-execution.ts',
      code: `import { NativeSandboxExecutor, SandboxManager } from '@cogitator-ai/sandbox';

const native = new NativeSandboxExecutor();
await native.connect();
const hello = await native.execute(
  { command: ['echo', 'Hello from the native sandbox'] },
  { type: 'native', timeout: 5000 }
);
if (hello.success) console.log(hello.data.stdout.trim());

const manager = new SandboxManager({
  defaults: {
    timeout: 10_000,
    resources: { memory: '256MB', cpus: 0.5 },
    network: { mode: 'none' },
  },
  pool: { maxSize: 3, idleTimeoutMs: 30_000 },
});
await manager.initialize();

const dockerAvailable = await manager.isDockerAvailable();
console.log('Docker available:', dockerAvailable);

const result = await manager.execute(
  { command: ['node', '-e', 'console.log(JSON.stringify({ sum: 2 + 2 }))'] },
  { type: dockerAvailable ? 'docker' : 'native', image: 'node:20-alpine' }
);
console.log(result.success ? result.data.stdout.trim() : result.error);

const slow = await manager.execute({ command: ['sleep', '30'], timeout: 500 }, { type: 'native' });
if (slow.success) console.log('timed out:', slow.data.timedOut);

await manager.shutdown();`,
      install: 'pnpm add @cogitator-ai/sandbox',
      env: [],
      run: 'npx tsx sandbox-execution.ts',
      repoRun: 'npx tsx examples/infrastructure/05-sandbox-execution.ts',
      notes: [
        {
          type: 'warning',
          text: 'The native executor runs on the host. Only the Docker sandbox isolates untrusted code.',
        },
      ],
      example: 'infrastructure/05-sandbox-execution.ts',
      docs: [
        {
          href: '/docs/deployment/sandbox',
          label: 'Sandbox',
        },
      ],
    },
    {
      id: 'deploy-docker',
      title: 'Plan a Docker Deploy',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'Before deploying you want to know what your project needs — server, services, secrets — and whether the machine is ready.',
      points: [
        'Analyze a project with `ProjectAnalyzer`',
        'Plan, run preflight checks and dry-run a deploy with `Deployer`',
      ],
      file: 'deploy-docker.ts',
      code: `import { Deployer, ProjectAnalyzer } from '@cogitator-ai/deploy';

const projectDir = process.cwd();

const analysis = new ProjectAnalyzer().analyze(projectDir);
console.log('Server:', analysis.server ?? '(not detected)');
console.log('Services:', analysis.services);
console.log('Secrets:', analysis.secrets.join(', ') || '(none)');

const deployer = new Deployer();
const plan = await deployer.plan({
  projectDir,
  target: 'docker',
  noPush: true,
  configOverrides: {
    port: 3000,
    image: 'my-agent',
    services: { redis: true, postgres: false },
    health: { path: '/health', interval: '30s', timeout: '5s' },
    resources: { memory: '512mb', cpu: 1 },
  },
});

for (const check of plan.preflight.checks) {
  console.log(\`[\${check.passed ? 'PASS' : 'FAIL'}] \${check.name}: \${check.message}\${check.fix ? \` (fix: \${check.fix})\` : ''}\`);
}

const result = await deployer.deploy({
  projectDir,
  target: 'docker',
  dryRun: true,
  noPush: true,
  configOverrides: { port: 3000, image: 'my-agent', services: { redis: true } },
});
console.log(result.success ? 'Dry run OK' : \`Dry run failed: \${result.error}\`);

console.log('Targets:', deployer.availableTargets().join(', '));`,
      install: 'pnpm add @cogitator-ai/deploy',
      env: [],
      run: 'npx tsx deploy-docker.ts',
      repoRun: 'npx tsx examples/infrastructure/04-deploy-docker.ts',
      example: 'infrastructure/04-deploy-docker.ts',
      docs: [
        {
          href: '/docs/deployment/deploy-package',
          label: 'Deploy Package',
        },
      ],
    },
  ],
};
