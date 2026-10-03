import type { StrategyId } from './scenes';

/** Config snippets per strategy; each one is type-checked against the real `@cogitator-ai/swarms` API. */
export const SWARM_SNIPPETS: Record<StrategyId, string> = {
  hierarchical: `
const team = new Swarm(cog, {
  name: 'feature-team',
  strategy: 'hierarchical',
  supervisor: lead,
  workers: [frontend, backend, devops],
  hierarchical: {
    maxDelegationDepth: 2,
    visibility: 'summary',
  },
});

const { output, agentResults } = await team.run({
  input: 'Add SSO to the admin panel',
});
`,
  'round-robin': `
const desk = new Swarm(cog, {
  name: 'support-desk',
  strategy: 'round-robin',
  agents: [ada, ben, cy],
  roundRobin: {
    sticky: true,
    stickyKey: (input) => String(input).split(':')[0],
  },
});

await desk.run({ input: 'acme: invoice is missing' });
await desk.run({ input: 'globex: reset my SSO' });
await desk.run({ input: 'acme: still no invoice' });
await desk.run({ input: 'initech: export to CSV' });
`,
  consensus: `
const review = new Swarm(cog, {
  name: 'release-review',
  strategy: 'consensus',
  agents: [security, perf, product],
  consensus: {
    threshold: 0.66,
    maxRounds: 3,
    resolution: 'weighted',
    weights: { security: 2 },
    onNoConsensus: 'escalate',
  },
});

const { output, votes } = await review.run({
  input: 'Ship v2.4 to production today?',
});
`,
  auction: `
const market = new Swarm(cog, {
  name: 'task-market',
  strategy: 'auction',
  agents: [sqlExpert, analyst, generalist],
  agentMetadata: {
    'sql-expert': { expertise: ['sql', 'postgres'] },
  },
  auction: {
    bidding: 'capability-match',
    selection: 'highest-bid',
    minBid: 0.3,
  },
});

const { auctionWinner, bids } = await market.run({
  input: 'Why did churn spike in May?',
});
`,
  pipeline: `
const content = new Swarm(cog, {
  name: 'content',
  strategy: 'pipeline',
  pipeline: {
    stages: [
      { name: 'research', agent: researcher },
      { name: 'draft', agent: writer },
      { name: 'review', agent: editor, gate: true },
    ],
    gates: {
      review: {
        condition: (output) => String(output).includes('APPROVED'),
        onFail: 'retry-previous',
        maxRetries: 2,
      },
    },
  },
});
`,
  debate: `
const debate = new Swarm(cog, {
  name: 'build-vs-buy',
  strategy: 'debate',
  agents: [advocate, critic],
  agentMetadata: {
    advocate: { role: 'advocate' },
    critic: { role: 'critic' },
  },
  moderator,
  debate: { rounds: 3, format: 'structured', maxTokensPerTurn: 400 },
});

const { output, debateTranscript } = await debate.run({
  input: 'Should we build our own vector store?',
});
`,
  negotiation: `
const deal = new Swarm(cog, {
  name: 'license-deal',
  strategy: 'negotiation',
  agents: [buyer, seller],
  negotiation: {
    maxRounds: 6,
    turnOrder: 'round-robin',
    onDeadlock: 'arbitrate',
    stagnationThreshold: 0.05,
  },
});

const { negotiationResult } = await deal.run({
  input: 'Annual license for 200 seats',
});
`,
};
