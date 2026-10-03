# Swarms

> Multi-agent coordination patterns

`@cogitator-ai/swarms` runs several agents together under one coordination strategy. The website covers the same ground in more depth:

- [Swarms overview](https://cogitator.app/docs/swarms)
- [Strategies](https://cogitator.app/docs/swarms/strategies)
- [Builder and Swarm API](https://cogitator.app/docs/swarms/builder)
- [Agent communication](https://cogitator.app/docs/swarms/communication)
- [Model assessment](https://cogitator.app/docs/swarms/assessment)
- [Distributed swarms](https://cogitator.app/docs/swarms/distributed)

## Overview

A `Swarm` wraps a coordinator (agent registry, budgets, error recovery, pause/abort) and one of 7 strategies. Every swarm also owns a message bus, a shared blackboard and an event emitter.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                     Swarm                                       │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                               Strategy                                  │   │
│   │                                                                         │   │
│   │  Hierarchical │ Round-Robin │ Consensus │ Auction │ Pipeline │ Debate   │   │
│   │                              Negotiation                                │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                      │                                          │
│                    ┌─────────────────┼─────────────────┐                        │
│                    ▼                 ▼                 ▼                        │
│              ┌──────────┐      ┌──────────┐      ┌──────────┐                   │
│              │  Agent A │      │  Agent B │      │  Agent C │                   │
│              │  Coder   │      │ Reviewer │      │  Tester  │                   │
│              └──────────┘      └──────────┘      └──────────┘                   │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │     MessageBus      │       Blackboard        │      Event emitter      │   │
│   │  agent-to-agent     │  shared sections with   │  swarm, agent and       │   │
│   │  messages           │  versions and history   │  strategy events        │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Agents run through the `Cogitator` you pass in, so every agent needs a `model` (or the Cogitator needs `llm.defaultModel`). Agent names must be unique within a swarm: two different agents with the same name throw at construction.

---

## Swarm Strategies

### 1. Hierarchical

A supervisor delegates subtasks to workers. The supervisor automatically gets the `delegate_task`, `check_progress`, `request_revision` and `list_workers` tools (tools it already defines with the same name are kept), and each `delegate_task` call runs the worker and returns its output.

```typescript
import { Swarm } from '@cogitator-ai/swarms';
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator();

const devTeam = new Swarm(cog, {
  name: 'dev-team',
  strategy: 'hierarchical',

  supervisor: new Agent({
    name: 'tech-lead',
    model: 'openai/gpt-5.5',
    instructions: `You are a tech lead managing a development team.
                   Break down tasks and delegate to appropriate team members.
                   Coordinate their work and ensure quality.`,
  }),

  workers: [
    new Agent({
      name: 'frontend-dev',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'You are a frontend developer. Build React/Vue components.',
      tools: [fileWrite, npmRun],
    }),
    new Agent({
      name: 'backend-dev',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'You are a backend developer. Build APIs and services.',
      tools: [fileWrite, databaseTool],
    }),
    new Agent({
      name: 'qa-engineer',
      model: 'openai/gpt-5.5',
      instructions: 'You are a QA engineer. Write and run tests.',
      tools: [fileWrite, testRunner],
    }),
  ],

  hierarchical: {
    maxDelegationDepth: 3, // default 3
    workerCommunication: false, // default false
    routeThrough: 'supervisor', // 'supervisor' (default) | 'direct'
    visibility: 'full', // 'full' (default) | 'summary' | 'none': how much worker output the supervisor sees
  },
});

const result = await devTeam.run({
  input: 'Build a user authentication system with login, register, and password reset',
});
```

The result `output` is the supervisor's final answer; `agentResults` holds the supervisor's run and the latest run of every worker it delegated to. Delegated tasks are tracked on the blackboard in the `tasks` and `workerResults` sections.

### 2. Round-Robin

Each `run()` call is handled by one agent; the next call goes to the next agent.

```typescript
const supportTeam = new Swarm(cog, {
  name: 'support-team',
  strategy: 'round-robin',

  agents: [
    new Agent({ name: 'support-1', model, instructions: 'Handle customer support tickets.' }),
    new Agent({ name: 'support-2', model, instructions: 'Handle customer support tickets.' }),
    new Agent({ name: 'support-3', model, instructions: 'Handle customer support tickets.' }),
  ],

  roundRobin: {
    rotation: 'sequential', // 'sequential' (default) | 'random'
    // Sticky sessions: the same key is always routed to the same agent.
    // stickyKey receives the run input string.
    sticky: true,
    stickyKey: (input) => String(input).match(/ticket #(\d+)/)?.[1] ?? 'default',
  },
});

await supportTeam.run({ input: 'ticket #1042: I cannot log in' });
```

Every agent in the swarm takes part in the rotation, whichever slot (`agents`, `workers`, ...) it was configured in. With `sticky: true` a known `stickyKey` stays with the agent that handled it first, while a new key takes the next agent of the rotation; without `stickyKey` every run rotates.

### 3. Consensus

Agents vote over up to `maxRounds` rounds until a decision reaches the threshold. Voters get the `cast_vote`, `get_votes`, `change_vote` and `get_consensus_status` tools automatically (local swarms) and can also answer with a `VOTE: <decision>` line; votes cast through the tools take precedence. A `supervisor`, if configured, does not vote; it only decides on `onNoConsensus: 'supervisor-decides'`.

```typescript
const reviewBoard = new Swarm(cog, {
  name: 'code-review-board',
  strategy: 'consensus',

  agents: [
    new Agent({ name: 'security-reviewer', model, instructions: 'Focus on security issues.' }),
    new Agent({ name: 'performance-reviewer', model, instructions: 'Focus on performance.' }),
    new Agent({ name: 'maintainability-reviewer', model, instructions: 'Focus on code quality.' }),
  ],

  consensus: {
    threshold: 0.66, // share of all eligible voters (abstentions count against); ties never win
    maxRounds: 3,
    resolution: 'majority', // 'majority' | 'unanimous' | 'weighted'
    onNoConsensus: 'escalate', // 'escalate' | 'supervisor-decides' | 'fail'
    weights: { 'security-reviewer': 2 }, // used by 'weighted'
  },
});

const result = await reviewBoard.run({
  input: 'Should we merge this pull request?',
  context: { prDiff: '...' },
});

console.log(result.output); // text summary of the decision and the votes
console.log(result.votes); // Map: 'security-reviewer_round1' -> { decision, reasoning, weight }
```

The swarm needs at least 2 voting agents. `onNoConsensus: 'fail'` throws, `'escalate'` returns an `ESCALATION REQUIRED` summary, and `'supervisor-decides'` runs the supervisor with the votes and discussion.

### 4. Auction

Agents bid for the task and the winner executes it. With `bidding: 'capability-match'` every agent is asked (in parallel) to rate itself with a `SCORE: 0.0-1.0` answer; with `bidding: 'custom'` your `bidFunction` scores each agent without an LLM call.

```typescript
const expertPool = new Swarm(cog, {
  name: 'expert-pool',
  strategy: 'auction',

  agents: [
    new Agent({
      name: 'python-expert',
      model,
      instructions: 'Python and data science specialist.',
    }),
    new Agent({
      name: 'typescript-expert',
      model,
      instructions: 'TypeScript and Node.js specialist.',
    }),
    new Agent({
      name: 'devops-expert',
      model,
      instructions: 'DevOps and infrastructure specialist.',
    }),
  ],

  agentMetadata: {
    'python-expert': { expertise: ['python', 'pandas'] },
    'typescript-expert': { expertise: ['typescript', 'node'] },
    'devops-expert': { expertise: ['kubernetes', 'docker', 'ci'] },
  },

  auction: {
    bidding: 'custom', // 'capability-match' | 'custom'
    bidFunction: (agent, task) => {
      const expertise = agent.metadata.expertise ?? [];
      const text = task.toLowerCase();
      return expertise.filter((skill) => text.includes(skill)).length / expertise.length;
    },
    selection: 'highest-bid', // 'highest-bid' | 'weighted-random'
    minBid: 0.1, // bids below this are dropped (default 0); no valid bid throws
  },
});

const result = await expertPool.run({
  input: 'Write a Kubernetes deployment for our Node.js service',
});
console.log(result.auctionWinner, result.bids);
```

### 5. Pipeline

Stages run sequentially; each stage receives the previous stage's output.

```typescript
const contentPipeline = new Swarm(cog, {
  name: 'content-pipeline',
  strategy: 'pipeline',

  pipeline: {
    stages: [
      {
        name: 'research',
        agent: new Agent({
          name: 'researcher',
          model,
          instructions: 'Research topics thoroughly.',
          tools: [webSearch, webFetch],
        }),
      },
      {
        name: 'outline',
        agent: new Agent({
          name: 'outliner',
          model,
          instructions: 'Create outlines from research.',
        }),
      },
      {
        name: 'draft',
        agent: new Agent({ name: 'writer', model, instructions: 'Write content from outlines.' }),
      },
      {
        name: 'edit',
        agent: new Agent({ name: 'editor', model, instructions: 'Polish and improve drafts.' }),
      },
    ],

    // Optional: build each stage's input. The return value is converted with String().
    stageInput: (prevOutput, stage, ctx) =>
      `Original request: ${String(ctx.input)}\n\n` +
      `You are the ${stage.name} stage (${ctx.stageIndex + 1}).\n\n` +
      `Previous output:\n${String(prevOutput)}`,
  },
});

const article = await contentPipeline.run({
  input: 'Write an article about the future of AI agents',
});
console.log(article.output); // output of the last stage
console.log(article.pipelineOutputs); // Map: stage name -> output
```

Stages come from `pipeline.stages` or the top-level `stages` field (`gates` and `stageInput` always come from `pipeline`). Configuring different stages in both places throws, and so does a pipeline without at least one stage.

### 6. Debate

Debaters argue over `rounds` rounds; a moderator (if configured) synthesizes the transcript into the final answer. Without a moderator the output is a plain summary of the arguments. Give agents the `advocate` / `critic` roles through `agentMetadata` to get role-specific instructions; when no agent has either role, every non-moderator agent debates.

```typescript
const debateSwarm = new Swarm(cog, {
  name: 'decision-debate',
  strategy: 'debate',

  agents: [
    new Agent({
      name: 'advocate',
      model,
      instructions: 'Argue IN FAVOR of the proposed solution. Find all benefits.',
    }),
    new Agent({
      name: 'critic',
      model,
      instructions: 'Argue AGAINST the proposed solution. Find all risks.',
    }),
  ],
  agentMetadata: {
    advocate: { role: 'advocate' },
    critic: { role: 'critic' },
  },

  moderator: new Agent({
    name: 'moderator',
    model: 'openai/gpt-5.5',
    instructions: 'Synthesize arguments from both sides and make a balanced recommendation.',
  }),

  debate: {
    rounds: 3,
    maxTokensPerTurn: 500, // caps each debater turn
    format: 'structured', // 'structured' (default) | 'freeform'
  },
});

const decision = await debateSwarm.run({
  input: 'Should we rewrite our backend in Rust?',
  context: { currentStack: 'Node.js', teamSize: 5 },
});
console.log(decision.debateTranscript?.length);
```

### 7. Negotiation

Agents negotiate structured agreements through multi-round proposals and counter-offers. Every negotiating agent automatically gets the negotiation tools (`make_offer`, `counter_offer`, `accept_offer`, `reject_offer`, `declare_interests`, `propose_coalition`, ...). A `supervisor` or `moderator` does not negotiate.

```typescript
const negotiationSwarm = new Swarm(cog, {
  name: 'contract-negotiation',
  strategy: 'negotiation',

  agents: [
    new Agent({
      name: 'buyer',
      model,
      instructions: 'You represent the buyer. Negotiate favorable pricing and delivery terms.',
    }),
    new Agent({
      name: 'seller',
      model,
      instructions: 'You represent the seller. Negotiate sustainable pricing and timeline.',
    }),
  ],

  negotiation: {
    maxRounds: 5,
    turnOrder: 'round-robin', // 'round-robin' | 'priority' (by weight) | 'dynamic'
    onDeadlock: 'arbitrate', // 'escalate' | 'supervisor-decides' | 'majority-rules' | 'arbitrate' | 'fail'
  },
});

const result = await negotiationSwarm.run({
  input: 'Negotiate a software development contract: 6-month project, estimated 500 hours',
});

// 'agreement' | 'deadlock' | 'escalated' | 'arbitrated' | 'terminated'
console.log(result.negotiationResult?.outcome);
console.log(result.negotiationResult?.agreement?.terms);
```

Other `negotiation` options: `maxOffersPerRound`, `offerTimeout`, `turnTimeout`, `allowCoalitions`, `minCoalitionSize`, `approvalGates`, `quorum`, `weights`, `stagnationThreshold`, `maxRoundsWithoutProgress`. Defaults come from `DEFAULT_NEGOTIATION_CONFIG` in `@cogitator-ai/types` (10 rounds, `onDeadlock: 'escalate'`, coalitions allowed).

Approval gates (`approvalGates`) announce each request with the `negotiation:approval-required` event. A gate with `timeout` resolves by its `timeoutAction` when nobody answers in time; a gate without `timeout` waits for `swarm.respondToApproval(requestId, response)`. A run `timeout` or `swarm.abort()` stops the wait.

```typescript
import type { NegotiationApprovalRequest } from '@cogitator-ai/types';

negotiationSwarm.on('negotiation:approval-required', (event) => {
  const { request } = event.data as { request: NegotiationApprovalRequest };
  negotiationSwarm.respondToApproval(request.id, {
    requestId: request.id,
    decision: 'approved',
    approved: true,
    continueNegotiation: false,
    respondedBy: 'legal-team',
    respondedAt: Date.now(),
  });
});
```

---

## Agent Communication

Every swarm exposes `swarm.messageBus`, `swarm.blackboard` and `swarm.events`. Details: [Agent communication](https://cogitator.app/docs/swarms/communication).

### Message Bus

```typescript
const collaborativeSwarm = new Swarm(cog, {
  name: 'collaborative-team',
  strategy: 'round-robin',
  agents: [agentA, agentB, agentC],

  // Optional; defaults to { enabled: true }
  messaging: {
    enabled: true, // false makes send() throw
    maxMessageLength: 2000,
    maxMessagesPerTurn: 5,
    maxTotalMessages: 100,
  },
});

const bus = collaborativeSwarm.messageBus;

await bus.send({
  swarmId: collaborativeSwarm.id,
  from: 'agent-a',
  to: 'agent-b', // or 'broadcast'
  type: 'request', // 'request' | 'response' | 'notification' | 'error'
  content: 'Can you review my analysis?',
});
await bus.broadcast('agent-a', 'I found something important', 'announcements');

bus.getMessages('agent-b');
bus.getUnreadMessages('agent-b');
bus.getConversation('agent-a', 'agent-b');
const unsubscribe = bus.subscribe('agent-b', (msg) => console.log(msg.from, msg.content));
```

Routing is decided by `to` (an agent name or `'broadcast'`). Before each agent turn the coordinator injects that agent's unread messages into the run context (once) and emits `message:received`.

### Shared Blackboard

The blackboard holds named sections with versions and optional history. Strategies use it too (`consensus`, `auction`, `pipeline`, `debate`, `round-robin`, `tasks`, `workerResults`, `negotiation` sections).

```typescript
const researchSwarm = new Swarm(cog, {
  name: 'research-team',
  strategy: 'pipeline',
  pipeline: {
    stages: [
      { name: 'search', agent: searcherAgent },
      { name: 'read', agent: readerAgent },
      { name: 'synthesize', agent: synthesizerAgent },
    ],
  },

  // Optional; defaults to { enabled: true, sections: {}, trackHistory: true }
  blackboard: {
    enabled: true,
    sections: { sources: [], facts: [], conclusions: [] },
    trackHistory: true,
  },
});

const board = researchSwarm.blackboard;
board.write('sources', ['https://example.com/paper.pdf'], 'searcher');
board.append('facts', { claim: 'X is true' }, 'reader');
const sources = board.read<string[]>('sources'); // throws if the section does not exist
board.getSection('facts'); // { name, data, lastModified, modifiedBy, version }
board.getHistory('facts'); // [{ value, writtenBy, timestamp, version }, ...]
board.subscribe('conclusions', (data, agentName) => console.log(agentName, data));
```

### Giving Agents Communication Tools

The swarm adds the tools its strategy needs: delegation tools for the hierarchical supervisor, voting tools for consensus voters and negotiation tools for negotiating agents. The messaging and blackboard tools are opt-in with `agentTools` (or `SwarmBuilder.agentTools()`); every agent then gets them, bound to the swarm's own message bus and blackboard:

```typescript
const team = new Swarm(cog, {
  name: 'research-team',
  strategy: 'round-robin',
  agents: [agentA, agentB],
  agentTools: {
    messaging: true, // send_message, read_messages, broadcast_message, reply_to_message
    blackboard: true, // read_blackboard, write_blackboard, append_blackboard, list_blackboard_sections, get_blackboard_history
  },
});
```

Tools an agent already defines with the same name are left untouched. `agentTools` is rejected in distributed swarms (register the tools on the workers instead) and when `messaging.enabled` / `blackboard.enabled` is `false`. In a hierarchical swarm the messaging tools respect `workerCommunication` / `routeThrough`.

For your own tools, resolve the swarm lazily at call time, since agents are created before the swarm:

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

let researchTeam: Swarm | undefined;

const recordFact = tool({
  name: 'record_fact',
  description: 'Add a fact to the shared blackboard',
  parameters: z.object({ claim: z.string(), source: z.string() }),
  execute: async ({ claim, source }) => {
    researchTeam?.blackboard.append('facts', { claim, source }, 'reader');
    return { recorded: true };
  },
});

const reader = new Agent({ name: 'reader', model, instructions: '...', tools: [recordFact] });
```

`createMessagingTools`, `createBlackboardTools`, `createDelegationTools`, `createVotingTools`, `createNegotiationTools`, `createSwarmTools` and `createStrategyTools` build the ready-made tool sets (`send_message`, `read_blackboard`, `cast_vote`, ...) when you hold the bus/blackboard instances, for example in a custom coordinator.

### Events

```typescript
const unsub = monitoringSwarm.on('agent:complete', (event) => {
  console.log(`Agent ${event.agentName} completed`);
});

monitoringSwarm.once('swarm:complete', (event) => console.log(event.data));
monitoringSwarm.on('*', (event) => console.log(`[${event.type}]`, event.data));

unsub();

const history = monitoringSwarm.events.getEvents(); // rolling buffer of recent events
```

Subscriptions made with `swarm.on()` / `swarm.once()` survive the coordinator re-creation that happens after model assessment; listeners attached directly to `swarm.events` do not. Common events: `swarm:start`, `swarm:complete`, `swarm:error`, `swarm:paused`, `swarm:resumed`, `swarm:aborted`, `swarm:reset`, `agent:start`, `agent:complete`, `agent:error`, `message:sent`, `message:received`, `blackboard:write`, `assessor:complete`, plus strategy events (`consensus:*`, `auction:*`, `pipeline:*`, `debate:*`, `round-robin:assigned`, `negotiation:*`). The full list is `SwarmEventType` in `@cogitator-ai/types`.

---

## Swarm Patterns

### 1. Supervisor-Worker

```typescript
const supervisorWorker = new Swarm(cog, {
  name: 'project-team',
  strategy: 'hierarchical',

  supervisor: new Agent({
    name: 'project-manager',
    model,
    instructions: `
      You manage a team of specialists: designer (UI/UX), developer (code), tester (QA).
      Use delegate_task, check_progress and request_revision to coordinate them.
    `,
  }),

  workers: [designerAgent, developerAgent, testerAgent],

  hierarchical: {
    visibility: 'summary', // supervisor sees a shortened version of worker outputs
    workerCommunication: false,
  },
});
```

### 2. Quality Gate

Stages marked `gate: true` check their own output with the matching `gates[stageName]` entry. Stage outputs are strings.

```typescript
const qualityGate = new Swarm(cog, {
  name: 'quality-pipeline',
  strategy: 'pipeline',

  pipeline: {
    stages: [
      { name: 'generate', agent: generatorAgent },
      { name: 'validate', agent: validatorAgent, gate: true },
      { name: 'refine', agent: refinerAgent },
      { name: 'final-review', agent: reviewerAgent, gate: true },
    ],

    gates: {
      validate: {
        condition: (output) => String(output).includes('VALID'),
        onFail: 'retry-previous', // 'retry-previous' | 'abort' | 'skip' | 'goto:<stage>'
        maxRetries: 3,
      },
      'final-review': {
        condition: (output) => String(output).includes('APPROVED'),
        onFail: 'goto:refine',
        maxRetries: 2,
      },
    },
  },
});
```

`retry-previous` re-runs the stage before the gate and aborts after `maxRetries`. `goto:<stage>` jumps to that stage; jumps are capped at three times the number of stages (`maxRetries` does not apply). `skip` continues as if the gate passed. A gate stage without a `gates` entry always passes.

### 3. Expert Routing

```typescript
const router = new Swarm(cog, {
  name: 'expert-router',
  strategy: 'auction',

  agents: [
    new Agent({ name: 'database-expert', model, instructions: 'Schema design, SQL optimization.' }),
    new Agent({ name: 'api-expert', model, instructions: 'REST APIs, GraphQL, authentication.' }),
    new Agent({
      name: 'frontend-expert',
      model,
      instructions: 'React, Vue, CSS, user interfaces.',
    }),
    new Agent({ name: 'devops-expert', model, instructions: 'Docker, Kubernetes, CI/CD.' }),
  ],

  auction: {
    bidding: 'capability-match',
    selection: 'highest-bid',
  },
});
```

### 4. Multi-Party Negotiation

```typescript
const negotiation = new Swarm(cog, {
  name: 'resource-allocation',
  strategy: 'negotiation',

  agents: [
    new Agent({ name: 'team-a', model, instructions: 'Advocate for Team A resource needs.' }),
    new Agent({ name: 'team-b', model, instructions: 'Advocate for Team B resource needs.' }),
    new Agent({ name: 'team-c', model, instructions: 'Advocate for Team C resource needs.' }),
  ],

  // Breaks deadlocks with onDeadlock: 'supervisor-decides'
  supervisor: new Agent({
    name: 'cto',
    model,
    instructions: 'Make final resource allocation decisions when teams cannot agree.',
  }),

  negotiation: {
    maxRounds: 5,
    turnOrder: 'round-robin',
    onDeadlock: 'supervisor-decides',
  },
});
```

---

## Configuration

### Resource Management

```typescript
const managed = new Swarm(cog, {
  name: 'managed-swarm',
  strategy: 'round-robin',
  agents,

  resources: {
    maxConcurrency: 5, // parallel agent runs (default 4)
    tokenBudget: 100_000,
    costLimit: 1.0, // dollars
    timeout: 300_000, // ms of elapsed run time
    perAgent: {
      maxIterations: 10,
      maxTokens: 10_000,
      timeout: 60_000,
    },
  },
});

await managed.run({ input: '...', timeout: 120_000 });
console.log(managed.getResourceUsage()); // { totalTokens, totalCost, elapsedTime, agentUsage }
```

Budgets are checked before every agent turn: once `tokenBudget`, `costLimit` or `resources.timeout` is exceeded, the next turn throws `Swarm resource budget exceeded` (a turn already running is not interrupted). `run({ timeout })` is a hard deadline: the run rejects with `SwarmTimeoutError` and in-flight agent runs are cancelled. `perAgent` limits are applied to each agent by running a clone with the lower `maxIterations` / `maxTokens`. Usage counters reset at the start of every run.

### Error Handling

Without `errorHandling` an agent failure rejects the run.

```typescript
const resilient = new Swarm(cog, {
  name: 'resilient-swarm',
  strategy: 'round-robin',
  agents,

  errorHandling: {
    onAgentFailure: 'retry', // 'retry' | 'skip' | 'failover' | 'abort'

    retry: {
      maxRetries: 3,
      backoff: 'exponential', // 'constant' | 'linear' | 'exponential'
      initialDelay: 1000, // default 1000
      maxDelay: 30_000, // default 30000
    },

    // Used by onAgentFailure: 'failover' (backup agents must be part of the swarm)
    failover: {
      'primary-coder': 'backup-coder',
    },

    circuitBreaker: {
      enabled: true,
      threshold: 5, // open after 5 failures
      resetTimeout: 60_000,
    },

    // Parallel phases (e.g. auction bidding) keep the successful results
    partialResults: true,
  },
});
```

`skip` turns a failed agent run into an empty result. While the circuit breaker is open every agent turn throws `Circuit breaker is open for swarm '<name>'`.

### Observability

```typescript
const observable = new Swarm(cog, {
  name: 'observable-swarm',
  strategy: 'pipeline',
  pipeline: { stages },

  observability: {
    messageLogging: true, // log every bus message through the core logger
    blackboardLogging: true, // log every blackboard write
  },
});

observable.on('*', (event) => {
  console.log(`[${event.type}]`, event.data);
});
```

`message:sent` and `blackboard:write` events are emitted regardless of these flags. `observability.tracing: true` logs the trace (spans) of every agent run as `'[Swarm] agent trace'`, tagged with the swarm and agent.

---

## SwarmBuilder API

Fluent builder for the same `SwarmConfig`. Details: [Builder and Swarm API](https://cogitator.app/docs/swarms/builder).

```typescript
import { swarm } from '@cogitator-ai/swarms';

const mySwarm = swarm('content-team')
  .strategy('pipeline')
  .pipeline({
    stages: [
      { name: 'research', agent: researchAgent },
      { name: 'write', agent: writerAgent },
      { name: 'edit', agent: editorAgent },
    ],
  })
  .resources({ maxConcurrency: 3, costLimit: 0.5 })
  .build(cog);

const result = await mySwarm.run({ input: 'Write about quantum computing' });
```

Builder methods: `strategy`, `supervisor`, `workers`, `agents`, `moderator`, `router`, `agentMetadata` (merged across calls), `hierarchical`, `roundRobin`, `consensus`, `auction`, `pipeline`, `debate`, `negotiation`, `messaging`, `blackboardConfig`, `agentTools`, `resources`, `errorHandling`, `observability`, `distributed`, `withAssessor`, `build(cogitator)`. `build()` throws when the strategy is missing; the `Swarm` constructor then validates the strategy-specific requirements (a supervisor for hierarchical, `consensus` / `auction` / `debate` / `negotiation` config for those strategies, at least 2 agents for consensus and negotiation, at least one pipeline stage, no conflicting `stages` / `pipeline.stages`, and no `agentTools` in distributed swarms or for a disabled message bus / blackboard).

---

## Assessor: Automatic Model Assignment

The assessor analyzes the task and assigns a model to each agent. Details: [Model assessment](https://cogitator.app/docs/swarms/assessment).

```typescript
import { swarm } from '@cogitator-ai/swarms';

const mySwarm = swarm('dev-team')
  .strategy('hierarchical')
  .supervisor(supervisorAgent)
  .workers([frontendAgent, backendAgent])
  .agentMetadata({ 'tech-lead': { locked: true } }) // keep this agent's model
  .withAssessor({
    mode: 'hybrid', // 'rules' | 'ai' | 'hybrid'
    preferLocal: true, // prefer Ollama models when capable
    maxCostPerRun: 0.1,
  })
  .build(cog);

// Dry run: see model assignments without executing
const assessment = await mySwarm.dryRun({ input: 'Build a REST API' });
for (const assignment of assessment.assignments) {
  console.log(`${assignment.agentName}: ${assignment.assignedModel} (score: ${assignment.score})`);
}

// The first run() assesses once, then runs with the assigned models
const result = await mySwarm.run({ input: 'Build a REST API' });
console.log(mySwarm.getLastAssessment()?.totalEstimatedCost);
```

`mode: 'rules'` (default) analyzes the task with keyword rules. With `'ai'` the assessor model analyzes the task; `'hybrid'` takes the model's analysis plus every hard requirement (vision, tool calling, long context) the rules detect. Both fall back to the rules with a warning in `warnings` when the model cannot run. `assessorModel` picks that model (default: the Cogitator's `llm.defaultModel`). Inside a Swarm only cloud models whose provider the Cogitator can route (its backend, e.g. API key, is configured) are offered.

Other `AssessorConfig` options: `minCapabilityMatch`, `ollamaUrl`, `enabledProviders`, `cacheAssessments`, `cacheTTL`. Assigned models are provider-qualified (e.g. `ollama/llama3.2:3b`). Unlocked agents are replaced by clones running the assigned model; locked agents keep theirs. `dryRun()` throws when no assessor is configured, and `getLastAssessment()` is only set by `run()`.

---

## Workflows and Distributed Mode

Run a swarm as a workflow step with `swarmNode`, `conditionalSwarmNode` or `parallelSwarmsNode`. The node takes a `Swarm` or a `SwarmConfig` (a config is turned into a swarm per execution and closed afterwards) and uses the `cogitator` the workflow executor passes in the node context:

```typescript
import { swarmNode } from '@cogitator-ai/swarms';
import type { WorkflowState } from '@cogitator-ai/types';

interface ReviewState extends WorkflowState {
  code: string;
  verdict?: string;
}

const reviewNode = swarmNode<ReviewState>(reviewBoard, {
  inputMapper: (state) => `Review this code:\n${state.code}`,
  stateMapper: (result) => ({ verdict: String(result.output) }),
});
```

With `distributed: { enabled: true, redis, queue, timeout }` agent turns are queued in Redis and executed by `DistributedSwarmWorker` processes from `@cogitator-ai/worker`; the message bus, blackboard and events move to Redis. Call `swarm.close()` when done. `retry` re-dispatches jobs that fail on a worker or time out (defaults: `maxRetries: 3`, `backoff: 'exponential'`, `initialDelay: 1000`, `maxDelay: 30000`; without `retry` a failed job is not retried). A timed-out job may still be running on its worker, so its turn can run twice. `cleanupAfter` expires the swarm's Redis state after `close()` (default 3600000 ms, `0` deletes it at once). See [Distributed swarms](https://cogitator.app/docs/swarms/distributed).

---

## API Reference

### Swarm Class

```typescript
class Swarm {
  constructor(cogitator: Cogitator, config: SwarmConfig, assessorConfig?: AssessorConfig);

  get name(): string;
  get id(): string;
  get strategyType(): string;
  get isDistributed(): boolean;

  // One run at a time per instance; a second concurrent run() throws
  run(options: SwarmRunOptions): Promise<StrategyResult>;

  // Requires an assessor
  dryRun(options: { input: string }): Promise<AssessmentResult>;
  getLastAssessment(): AssessmentResult | undefined;

  getAgent(name: string): SwarmAgent | undefined;
  getAgents(): SwarmAgent[];

  get messageBus(): ReadTrackingMessageBus; // MessageBus + markAsRead, onMessage
  get blackboard(): ObservableBlackboard; // Blackboard + onWrite
  get events(): QueryableSwarmEventEmitter; // + getEventsByType, getEventsByAgent, clearEvents

  // Return an unsubscribe function
  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;
  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;

  getResourceUsage(): SwarmResourceUsage;

  pause(): void; // the next agent turn waits until resume()
  resume(): void;
  abort(): void; // cancels in-flight agent runs; call reset() before running again
  isPaused(): boolean;
  isAborted(): boolean;
  // Negotiation only: answer a request from the negotiation:approval-required event
  respondToApproval(requestId: string, response: NegotiationApprovalResponse): void;
  reset(): Promise<void>; // clears agent state, messages, blackboard, usage and the abort flag

  close(): Promise<void>; // closes Redis connections in distributed mode
}
```

`SwarmTimeoutError` (exported) is thrown when `run({ timeout })` expires; it carries `swarmName` and `timeoutMs`.

### SwarmConfig

```typescript
interface SwarmConfig {
  name: string;
  strategy:
    | 'hierarchical'
    | 'round-robin'
    | 'consensus'
    | 'auction'
    | 'pipeline'
    | 'debate'
    | 'negotiation';

  supervisor?: Agent;
  workers?: Agent[];
  agents?: Agent[];
  stages?: PipelineStage[]; // pipeline stages (alternative to pipeline.stages)
  moderator?: Agent;
  router?: Agent;
  // Per-agent metadata keyed by agent name: role, expertise, priority, weight, locked, custom
  agentMetadata?: Record<string, SwarmAgentMetadata>;

  hierarchical?: HierarchicalConfig;
  roundRobin?: RoundRobinConfig;
  consensus?: ConsensusConfig;
  auction?: AuctionConfig;
  pipeline?: PipelineConfig;
  debate?: DebateConfig;
  negotiation?: NegotiationConfig;

  messaging?: MessageBusConfig;
  blackboard?: BlackboardConfig;

  resources?: SwarmResourceConfig;
  errorHandling?: SwarmErrorConfig;

  distributed?: DistributedSwarmConfig;

  // Built-in tools for every agent (local swarms only)
  agentTools?: SwarmAgentToolsConfig; // { messaging?: boolean; blackboard?: boolean }

  observability?: {
    tracing?: boolean; // log each agent run's spans
    messageLogging?: boolean;
    blackboardLogging?: boolean;
  };
}
```

Agents configured as `supervisor`, `workers`, `moderator` and `router` get the matching `role` automatically; `agentMetadata` overrides it.

### SwarmRunOptions

```typescript
interface SwarmRunOptions {
  input: string;
  context?: Record<string, unknown>; // passed to every agent
  threadId?: string; // each agent uses `${threadId}:${agentName}`
  userId?: string; // every agent run is made on behalf of this user
  timeout?: number; // hard deadline for the whole run (SwarmTimeoutError)
  saveHistory?: boolean; // default true

  onAgentStart?: (agentName: string) => void;
  onAgentComplete?: (agentName: string, result: RunResult) => void;
  onAgentError?: (agentName: string, error: Error) => void;
  onMessage?: (message: SwarmMessage) => void;
  onEvent?: (event: SwarmEvent) => void;
}
```

### StrategyResult

```typescript
interface StrategyResult {
  output: unknown;
  structured?: unknown;
  agentResults: Map<string, RunResult>; // keys: agent name, `${agent}_round${n}` or stage name

  votes?: Map<string, unknown>; // consensus
  bids?: Map<string, number>; // auction
  auctionWinner?: string; // auction
  debateTranscript?: SwarmMessage[]; // debate
  pipelineOutputs?: Map<string, unknown>; // pipeline
  negotiationResult?: NegotiationResult; // negotiation
}
```

---

## Best Practices

### 1. Clear Agent Roles

```typescript
// Good: specific, non-overlapping roles
const team = new Swarm(cog, {
  name: 'content-team',
  strategy: 'pipeline',
  pipeline: {
    stages: [
      {
        name: 'research',
        agent: new Agent({
          name: 'researcher',
          model,
          instructions: 'Find and verify information.',
        }),
      },
      {
        name: 'write',
        agent: new Agent({ name: 'writer', model, instructions: 'Write clear, engaging content.' }),
      },
      {
        name: 'edit',
        agent: new Agent({ name: 'editor', model, instructions: 'Polish grammar and style.' }),
      },
    ],
  },
});

// Bad: vague, overlapping roles
const badTeam = new Swarm(cog, {
  name: 'bad-team',
  strategy: 'round-robin',
  agents: [
    new Agent({ name: 'helper1', model, instructions: 'Help with tasks.' }),
    new Agent({ name: 'helper2', model, instructions: 'Assist with work.' }),
  ],
});
```

### 2. Right Strategy for the Job

| Task Type          | Recommended Strategy |
| ------------------ | -------------------- |
| Complex project    | Hierarchical         |
| Load balancing     | Round-Robin          |
| Critical decisions | Consensus            |
| Expert matching    | Auction              |
| Content creation   | Pipeline             |
| Risk assessment    | Debate               |
| Contract/resource  | Negotiation          |

### 3. Communication Limits

```typescript
const bounded = new Swarm(cog, {
  name: 'bounded-swarm',
  strategy: 'round-robin',
  agents,
  messaging: {
    enabled: true,
    maxMessageLength: 2000, // longer messages are rejected
    maxMessagesPerTurn: 5, // per agent, reset at the start of each of its turns
    maxTotalMessages: 100, // prevents message loops
  },
});
```

### 4. Graceful Degradation

```typescript
const degrading = new Swarm(cog, {
  name: 'resilient-swarm',
  strategy: 'auction',
  agents: [pythonExpert, devopsExpert, generalCoder],
  auction: { bidding: 'capability-match', selection: 'highest-bid' },
  errorHandling: {
    onAgentFailure: 'failover',
    // If a specialist fails, the generalist takes over the same input
    failover: {
      'python-expert': 'general-coder',
      'devops-expert': 'general-coder',
    },
    // Keep successful bids when some agents fail during bidding
    partialResults: true,
  },
});
```

---

## Known Limitations

- `messaging.protocol`, `blackboard.locking` and `distributed.workerConcurrency` are deprecated and have no effect (set worker concurrency with the `concurrency` option of `DistributedSwarmWorker`).
- `agentTools` is not available in distributed swarms; register the tools on the workers instead.
