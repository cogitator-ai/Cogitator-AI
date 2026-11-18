import type { Section } from './types';

export const swarms: Section = {
  id: 'swarms',
  title: 'Swarms',
  icon: '🐝',
  description: 'Several agents on one task: debate, pipeline, delegation, voting and negotiation.',
  recipes: [
    {
      id: 'debate-swarm',
      title: 'Debate',
      difficulty: 'medium',
      time: '10 min',
      problem: 'You want a decision weighed from two sides before a moderator concludes.',
      points: [
        'Run the `debate` strategy with roles, rounds and a moderator',
        'Read the transcript',
      ],
      file: 'debate-swarm.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const model = 'google/gemini-3.5-flash-lite';

const advocate = new Agent({
  name: 'pro-open-source',
  model,
  instructions: 'You argue that AI code should be open-source. Give 2-3 focused points per round.',
  temperature: 0.7,
  maxIterations: 1,
});

const critic = new Agent({
  name: 'pro-closed-source',
  model,
  instructions: 'You argue that AI code should stay proprietary. Give 2-3 focused points per round.',
  temperature: 0.7,
  maxIterations: 1,
});

const moderator = new Agent({
  name: 'moderator',
  model,
  instructions: 'You are a neutral moderator. Synthesize both sides and give a balanced conclusion.',
  temperature: 0.4,
  maxIterations: 1,
});

const debate = new Swarm(cog, {
  name: 'ai-open-source-debate',
  strategy: 'debate',
  agents: [advocate, critic],
  agentMetadata: {
    'pro-open-source': { role: 'advocate' },
    'pro-closed-source': { role: 'critic' },
  },
  moderator,
  debate: { rounds: 2, format: 'structured' },
});

debate.on('debate:turn', (event) => {
  const { agent } = event.data as { agent: string };
  console.log(\`\${agent} is speaking...\`);
});

const result = await debate.run({
  input: 'Should AI code be open-source? Consider safety, innovation, access and business viability.',
});

for (const message of result.debateTranscript ?? []) {
  console.log(\`[round \${String(message.metadata?.round)}] \${message.from}: \${message.content.slice(0, 120)}...\`);
}
console.log('\\nModerator:', result.output);
console.log('Tokens:', debate.getResourceUsage().totalTokens);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/swarms',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx debate-swarm.ts',
      repoRun: 'npx tsx examples/swarms/01-debate-swarm.ts',
      example: 'swarms/01-debate-swarm.ts',
      docs: [
        {
          href: '/docs/swarms/strategies',
          label: 'Swarm Strategies',
        },
      ],
    },
    {
      id: 'pipeline-swarm',
      title: 'Content Pipeline',
      difficulty: 'easy',
      time: '10 min',
      problem:
        'Research, writing and editing are different jobs. Each agent should do one and pass its output on.',
      points: [
        'Chain agents as `pipeline` stages',
        'Read every stage’s output from `pipelineOutputs`',
      ],
      file: 'pipeline-swarm.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const model = 'google/gemini-3.5-flash-lite';

const researcher = new Agent({
  name: 'researcher',
  model,
  instructions: 'Produce a research brief: 3-5 key facts, statistics and expert opinions. Plain text.',
  temperature: 0.5,
  maxIterations: 1,
});

const writer = new Agent({
  name: 'writer',
  model,
  instructions: 'Turn the research into a 300-word article with a hook, body and conclusion. Plain text.',
  temperature: 0.7,
  maxIterations: 1,
});

const editor = new Agent({
  name: 'editor',
  model,
  instructions: 'Fix grammar and flow, tighten sentences and add a title. Return the final article.',
  temperature: 0.3,
  maxIterations: 1,
});

const pipeline = new Swarm(cog, {
  name: 'content-pipeline',
  strategy: 'pipeline',
  pipeline: {
    stages: [
      { name: 'research', agent: researcher },
      { name: 'writing', agent: writer },
      { name: 'editing', agent: editor },
    ],
  },
});

pipeline.on('pipeline:stage', (event) => {
  const { index, name, total } = event.data as { index: number; name: string; total: number };
  console.log(\`stage \${index + 1}/\${total}: \${name}\`);
});

const result = await pipeline.run({
  input: 'Write an article about edge computing and why it matters for AI inference.',
});

for (const [stage, output] of result.pipelineOutputs ?? []) {
  console.log(\`--- \${stage}: \${String(output).slice(0, 100)}...\`);
}
console.log('\\nFinal article:\\n', result.output);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/swarms',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx pipeline-swarm.ts',
      repoRun: 'npx tsx examples/swarms/02-pipeline-swarm.ts',
      example: 'swarms/02-pipeline-swarm.ts',
      docs: [
        {
          href: '/docs/swarms/strategies',
          label: 'Swarm Strategies',
        },
      ],
    },
    {
      id: 'hierarchical-swarm',
      title: 'Supervisor & Workers',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'A manager agent should split a project, delegate the parts to specialists and merge their answers.',
      points: ['Run the `hierarchical` strategy — the supervisor gets a `delegate_task` tool'],
      file: 'hierarchical-swarm.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const model = 'google/gemini-3.5-flash-lite';

const specialist = (name: string, focus: string) =>
  new Agent({
    name,
    model,
    instructions: \`You are a \${focus} specialist. Give a concrete, practical implementation plan.\`,
    temperature: 0.5,
    maxIterations: 3,
  });

const supervisor = new Agent({
  name: 'project-manager',
  model,
  instructions: \`You coordinate a team of specialists. Delegate subtasks with the delegate_task tool.
Delegate to at least 2 workers, then synthesize their outputs into one project plan.\`,
  temperature: 0.3,
  maxIterations: 10,
});

const team = new Swarm(cog, {
  name: 'project-planning',
  strategy: 'hierarchical',
  supervisor,
  workers: [
    specialist('frontend-specialist', 'frontend'),
    specialist('backend-specialist', 'backend'),
    specialist('devops-specialist', 'DevOps'),
  ],
  hierarchical: { maxDelegationDepth: 2, workerCommunication: false, visibility: 'full' },
});

team.on('agent:start', (event) => console.log(\`started: \${event.agentName}\`));

const result = await team.run({
  input:
    'Plan a real-time analytics dashboard with WebSocket updates and role-based access. ' +
    'Delegate the frontend and backend parts, then give a short unified plan.',
  timeout: 180_000,
});

console.log(result.output);
for (const [name, agentResult] of result.agentResults) {
  console.log(\`\${name}: \${agentResult.usage.totalTokens} tokens\`);
}

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/swarms',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx hierarchical-swarm.ts',
      repoRun: 'npx tsx examples/swarms/03-hierarchical-swarm.ts',
      example: 'swarms/03-hierarchical-swarm.ts',
      docs: [
        {
          href: '/docs/swarms/strategies',
          label: 'Swarm Strategies',
        },
      ],
    },
    {
      id: 'consensus-swarm',
      title: 'Consensus Voting',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'A merge decision should come from several reviewers voting, with a lead breaking ties.',
      points: [
        'Build a `consensus` swarm with the `swarm()` builder',
        'Set threshold, rounds and what happens without consensus',
        'Read every vote from `result.votes`',
      ],
      file: 'consensus-swarm.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { swarm } from '@cogitator-ai/swarms';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const model = 'google/gemini-3.5-flash-lite';

const reviewer = (name: string, focus: string) =>
  new Agent({
    name,
    model,
    instructions: \`You review pull requests with a focus on \${focus}.
Give one short paragraph of reasoning, then end with a line "VOTE: MERGE" or "VOTE: REJECT".\`,
    temperature: 0.2,
  });

const reviewBoard = swarm('review-board')
  .strategy('consensus')
  .agents([
    reviewer('security-reviewer', 'security'),
    reviewer('perf-reviewer', 'performance'),
    reviewer('quality-reviewer', 'code quality'),
  ])
  .supervisor(new Agent({ name: 'lead', model, instructions: 'Break ties with a final MERGE or REJECT decision.' }))
  .consensus({
    threshold: 0.66,
    maxRounds: 2,
    resolution: 'majority',
    onNoConsensus: 'supervisor-decides',
  })
  .build(cog);

reviewBoard.on('consensus:vote', (event) => console.log('vote', JSON.stringify(event.data)));

const result = await reviewBoard.run({
  input: \`Should we merge this PR? It replaces a hand-written SQL string with a parameterized query
and adds an index on users.email. Tests pass.\`,
});

console.log(result.output);
for (const [key, vote] of result.votes ?? []) {
  const { decision } = vote as { decision: string };
  console.log(\`\${key}: \${decision}\`);
}

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/swarms',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx consensus-swarm.ts',
      docs: [
        {
          href: '/docs/swarms/strategies',
          label: 'Swarm Strategies',
        },
      ],
    },
    {
      id: 'negotiation-swarm',
      title: 'Negotiation',
      difficulty: 'advanced',
      time: '15 min',
      problem:
        'Two agents with opposing goals should converge on a deal — or hand over to arbitration.',
      points: [
        'Run the `negotiation` strategy with turn order and deadlock handling',
        'Read the agreed terms',
      ],
      file: 'negotiation-swarm.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { Swarm, type NegotiationResult } from '@cogitator-ai/swarms';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const model = 'google/gemini-3.5-flash-lite';

const buyer = new Agent({
  name: 'buyer',
  model,
  instructions: \`You are buying a software license. Your budget is $50,000/year.
Open at $30,000/year. Use terms: price, license_seats, support_tier, contract_length.\`,
  temperature: 0.7,
  maxIterations: 5,
});

const seller = new Agent({
  name: 'seller',
  model,
  instructions: \`You are selling a software license. Your floor is $40,000/year.
Open at $65,000/year; discount longer contracts. Use terms: price, license_seats, support_tier, contract_length.\`,
  temperature: 0.7,
  maxIterations: 5,
});

const negotiation = new Swarm(cog, {
  name: 'license-negotiation',
  strategy: 'negotiation',
  agents: [buyer, seller],
  negotiation: {
    maxRounds: 6,
    turnOrder: 'round-robin',
    onDeadlock: 'arbitrate',
    stagnationThreshold: 0.05,
  },
});

negotiation.on('negotiation:round', (event) => {
  const { round, maxRounds } = event.data as { round: number; maxRounds: number };
  console.log(\`round \${round}/\${maxRounds}\`);
});

const result = await negotiation.run({
  input: 'Negotiate a software licensing deal: yearly price, seats, support tier and contract length.',
});

const outcome = result.negotiationResult as NegotiationResult | undefined;
if (outcome) {
  console.log(\`\${outcome.outcome} after \${outcome.rounds} rounds and \${outcome.offers.length} offers\`);
  for (const term of outcome.agreement?.terms ?? []) {
    console.log(\`  \${term.label}: \${JSON.stringify(term.value)}\`);
  }
}
console.log(result.output);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/swarms',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx negotiation-swarm.ts',
      repoRun: 'npx tsx examples/swarms/04-negotiation-swarm.ts',
      example: 'swarms/04-negotiation-swarm.ts',
      docs: [
        {
          href: '/docs/swarms/strategies',
          label: 'Swarm Strategies',
        },
      ],
    },
    {
      id: 'agent-bridge',
      title: 'Claude Code, Codex & Your Agents on One Bridge',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'Your coding agents live in different apps and on different models. One should hand a job to another, get its report back, and have the work checked by an agent of another vendor.',
      points: [
        'Run one dispatcher per machine with `hostBridge()` or `cogitator bridge serve`',
        'Host an agent on any model with `hostedAdapter()`: the first letter of a job is its turn, its answer the report',
        'Hand a job over with `createJob()`, the `delegate` tool or `cogitator bridge delegate`, and read the report as a letter',
      ],
      file: 'agent-bridge.ts',
      code: `import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  BridgeClient,
  callerFromEnv,
  cogitatorSessions,
  hostBridge,
  hostedAdapter,
} from '@cogitator-ai/bridge';
import { Agent, Cogitator } from '@cogitator-ai/core';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: { adapter: 'memory' },
});
const reviewer = new Agent({
  name: 'reviewer',
  model: 'google/gemini-3.5-flash-lite',
  instructions:
    'You review short pieces of code. Answer in two sentences: what is wrong, and how to fix it.',
});

// A dispatcher on a throwaway folder. The one of your machine is \`cogitator bridge serve\`.
const home = mkdtempSync(join('/tmp', 'bridge-'));
const host = await hostBridge({
  home,
  adapters: [
    hostedAdapter({
      harness: 'reviewer',
      open: cogitatorSessions({ runtime: cog, agent: reviewer }),
    }),
  ],
});

// Plain code that says it is a Claude Code session. In real use it is a window of Claude Code
// or Codex that calls the \`delegate\` tool, or \`cogitator bridge delegate reviewer "..."\`.
const caller = callerFromEnv({ CLAUDE_CODE_SESSION_ID: 'cookbook-session' }, process.cwd());
if (!caller) throw new Error('The environment named no session');
const session = await BridgeClient.connect({ socketPath: host.paths.socket, caller });

const { job } = await session.createJob({
  to: 'reviewer',
  title: 'Review the retry loop',
  body: [
    'Review this function:',
    '',
    'async function retry(fn) {',
    '  for (let i = 0; i < 3; i++) {',
    '    try { return await fn(); } catch {}',
    '  }',
    '}',
  ].join('\\n'),
});
console.log(\`job #\${job.number} went to \${job.to}\`);

// Nobody waits for the job: its report arrives as a letter.
const mail = await session.wait({ timeoutMs: 120_000 });
for (const letter of mail.letters) {
  console.log(\`\${letter.kind} from \${letter.from}:\\n\${letter.body}\`);
}
console.log(\`job #\${job.number} is \${(await session.job(job.number)).state}\`);

await session.close();
await host.close();
await cog.close();
rmSync(home, { recursive: true, force: true });`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/bridge',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx agent-bridge.ts',
      repoRun: 'npx tsx examples/bridge/02-hosted-agent.ts',
      example: 'bridge/02-hosted-agent.ts',
      extra: [
        {
          title: 'The dispatcher of your machine, with Claude Code and Codex',
          language: 'bash',
          code: `# once per project: the tools, the hooks and the notes for both harnesses
cogitator bridge install

# the dispatcher, with an agent on a model of your choice next to them
cogitator bridge serve --agent reviewer=google/gemini-3.5-flash-lite

# from a Claude Code or Codex session, or from its delegate tool
cogitator bridge delegate codex "Add wordCount() to src/text.ts with tests"

# done in a worktree, checked, reviewed by another agent and fixed, in one go
cogitator bridge build codex "Add wordCount() to src/text.ts with tests" --check "npm test"

# how the jobs of each agent went, and who the next one would go to
cogitator bridge suggest`,
        },
      ],
      notes: [
        {
          type: 'info',
          text: 'The bridge is experimental. It drives the `claude` and `codex` commands of your machine the way you signed them in, and is a tool of one person on their own machine.',
        },
        {
          type: 'tip',
          text: 'Hand a job to `auto` and the bridge picks the agent whose jobs of that type held best, with the interval it is sure of.',
        },
      ],
      docs: [
        {
          href: '/docs/bridge',
          label: 'Agent Bridge',
        },
      ],
    },
  ],
};
