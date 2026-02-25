# Swarms

> Multi-agent coordination patterns

## Overview

Swarms enable multiple agents to work together on complex tasks. Cogitator supports 7 coordination strategies:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Swarm Coordinator                                   │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Strategy Engine                                 │   │
│   │                                                                         │   │
│   │  Hierarchical │ Round-Robin │ Consensus │ Auction │ Pipeline │ Debate   │   │
│   │                         Negotiation                                     │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                      │                                          │
│                    ┌─────────────────┼─────────────────┐                        │
│                    ▼                 ▼                 ▼                        │
│              ┌──────────┐      ┌──────────┐      ┌──────────┐                   │
│              │  Agent A │      │  Agent B │      │  Agent C │                   │
│              │          │      │          │      │          │                   │
│              │ Coder    │      │ Reviewer │      │ Tester   │                   │
│              └──────────┘      └──────────┘      └──────────┘                   │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Message Bus                                     │   │
│   │                                                                         │   │
│   │   Agent-to-Agent messaging  │  Shared state  │  Event coordination     │   │
│   │                                                                         │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Swarm Strategies

### 1. Hierarchical

A supervisor agent delegates tasks to worker agents:

```typescript
import { Swarm } from '@cogitator-ai/swarms';
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({ llm: { defaultModel: 'gpt-4o' } });

const devTeam = new Swarm(cog, {
  name: 'dev-team',
  strategy: 'hierarchical',

  supervisor: new Agent({
    name: 'tech-lead',
    model: 'gpt-4o',
    instructions: `You are a tech lead managing a development team.
                   Break down tasks and delegate to appropriate team members.
                   Coordinate their work and ensure quality.`,
  }),

  workers: [
    new Agent({
      name: 'frontend-dev',
      model: 'claude-sonnet-4-5',
      instructions: 'You are a frontend developer. Build React/Vue components.',
      tools: [fileWrite, npmRun],
    }),

    new Agent({
      name: 'backend-dev',
      model: 'claude-sonnet-4-5',
      instructions: 'You are a backend developer. Build APIs and services.',
      tools: [fileWrite, databaseTool],
    }),

    new Agent({
      name: 'qa-engineer',
      model: 'gpt-4o',
      instructions: 'You are a QA engineer. Write and run tests.',
      tools: [fileWrite, testRunner],
    }),
  ],

  hierarchical: {
    maxDelegationDepth: 3,
    workerCommunication: false,
    routeThrough: 'supervisor',
    visibility: 'full',
  },
});

const result = await devTeam.run({
  input: 'Build a user authentication system with login, register, and password reset',
});
```

### 2. Round-Robin

Tasks rotate between agents for balanced workload:

```typescript
const supportTeam = new Swarm(cog, {
  name: 'support-team',
  strategy: 'round-robin',

  agents: [
    new Agent({ name: 'support-1', instructions: 'Handle customer support tickets.' }),
    new Agent({ name: 'support-2', instructions: 'Handle customer support tickets.' }),
    new Agent({ name: 'support-3', instructions: 'Handle customer support tickets.' }),
  ],

  // Optional: sticky sessions (same agent handles follow-ups)
  roundRobin: {
    sticky: true,
    stickyKey: (input) => (input as { ticketId: string }).ticketId,
  },
});
```

### 3. Consensus

All agents must agree on a decision:

```typescript
const reviewBoard = new Swarm(cog, {
  name: 'code-review-board',
  strategy: 'consensus',

  agents: [
    new Agent({ name: 'security-reviewer', instructions: 'Focus on security issues.' }),
    new Agent({ name: 'performance-reviewer', instructions: 'Focus on performance.' }),
    new Agent({ name: 'maintainability-reviewer', instructions: 'Focus on code quality.' }),
  ],

  consensus: {
    // Voting rules
    threshold: 0.66, // 2/3 must agree
    maxRounds: 3, // Max discussion rounds

    // How to determine final answer
    resolution: 'majority', // 'majority' | 'unanimous' | 'weighted'

    // What to do if no consensus
    onNoConsensus: 'escalate', // 'escalate' | 'supervisor-decides' | 'fail'
  },
});

const result = await reviewBoard.run({
  input: 'Should we merge this pull request?',
  context: { prDiff: '...' },
});

console.log(result.output);
// { approved: true, votes: { security: 'approve', performance: 'approve', maintainability: 'reject' } }
```

### 4. Auction

Agents bid on tasks based on capability:

```typescript
const expertPool = new Swarm(cog, {
  name: 'expert-pool',
  strategy: 'auction',

  agents: [
    new Agent({
      name: 'python-expert',
      instructions: 'Python and data science specialist.',
    }),
    new Agent({
      name: 'typescript-expert',
      instructions: 'TypeScript and Node.js specialist.',
    }),
    new Agent({
      name: 'devops-expert',
      instructions: 'DevOps and infrastructure specialist.',
    }),
  ],

  auction: {
    // How agents bid
    bidding: 'capability-match', // Match task keywords to expertise

    // Custom bidding function
    bidFunction: async (agent, task) => {
      const taskKeywords = extractKeywords(task);
      const expertise = agent.metadata.expertise ?? [];
      return calculateMatch(expertise, taskKeywords);
    },

    // Winner selection
    selection: 'highest-bid', // 'highest-bid' | 'weighted-random'
  },
});

// Task automatically routed to most capable agent
const result = await expertPool.run({
  input: 'Write a Kubernetes deployment for our Node.js service',
});
// Routed to devops-expert
```

### 5. Pipeline

Sequential processing through specialized agents:

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
          instructions: 'Research topics thoroughly.',
          tools: [webSearch, webFetch],
        }),
      },
      {
        name: 'outline',
        agent: new Agent({
          name: 'outliner',
          instructions: 'Create detailed outlines from research.',
        }),
      },
      {
        name: 'draft',
        agent: new Agent({
          name: 'writer',
          instructions: 'Write engaging content from outlines.',
        }),
      },
      {
        name: 'edit',
        agent: new Agent({
          name: 'editor',
          instructions: 'Polish and improve drafts.',
        }),
      },
      {
        name: 'fact-check',
        agent: new Agent({
          name: 'fact-checker',
          instructions: 'Verify all claims and citations.',
          tools: [webSearch],
        }),
      },
    ],

    // Data flows from one stage to the next
    stageInput: (prevOutput, stage, ctx) => {
      return {
        previous: prevOutput,
        originalRequest: ctx.input,
        stageInstructions: `You are in the ${stage.name} stage.`,
      };
    },
  },
});

const article = await contentPipeline.run({
  input: 'Write an article about the future of AI agents',
});
```

### 6. Debate

Agents argue opposing positions:

```typescript
const debateSwarm = new Swarm(cog, {
  name: 'decision-debate',
  strategy: 'debate',

  agents: [
    new Agent({
      name: 'advocate',
      instructions: 'Argue IN FAVOR of the proposed solution. Find all benefits.',
    }),
    new Agent({
      name: 'critic',
      instructions: 'Argue AGAINST the proposed solution. Find all risks.',
    }),
  ],

  moderator: new Agent({
    name: 'moderator',
    instructions: 'Synthesize arguments from both sides and make a balanced recommendation.',
    model: 'gpt-4o', // Use strong model for synthesis
  }),

  debate: {
    rounds: 3, // Number of back-and-forth rounds
    turnDuration: 500, // Max tokens per turn
  },
});

const decision = await debateSwarm.run({
  input: 'Should we rewrite our backend in Rust?',
  context: { currentStack: 'Node.js', teamSize: 5 },
});
```

### 7. Negotiation

Agents negotiate structured agreements through multi-round proposals and counter-offers:

```typescript
const negotiationSwarm = new Swarm(cog, {
  name: 'contract-negotiation',
  strategy: 'negotiation',

  agents: [
    new Agent({
      name: 'buyer',
      instructions: 'You represent the buyer. Negotiate favorable pricing and delivery terms.',
    }),
    new Agent({
      name: 'seller',
      instructions: 'You represent the seller. Negotiate sustainable pricing and timeline.',
    }),
  ],

  negotiation: {
    maxRounds: 5,
    turnOrder: 'round-robin', // 'round-robin' | 'dynamic'
    onDeadlock: 'supervisor-decides', // 'escalate' | 'supervisor-decides' | 'majority-rules' | 'arbitrate' | 'fail'
  },
});

const result = await negotiationSwarm.run({
  input: 'Negotiate a software development contract: 6-month project, estimated 500 hours',
});

// Access negotiation-specific result
console.log(result.negotiationResult?.outcome); // 'agreement' | 'deadlock' | 'escalated' | 'arbitrated'
console.log(result.negotiationResult?.agreement?.terms);
```

---

## Agent Communication

### Message Passing

Agents can communicate via the message bus:

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const collaborativeSwarm = new Swarm(cog, {
  name: 'collaborative-team',
  strategy: 'round-robin',

  agents: [agentA, agentB, agentC],

  // Enable direct messaging
  messaging: {
    enabled: true,
    protocol: 'direct', // or 'broadcast', 'pub-sub'
  },
});

// Inside agent instructions:
// "You can message other agents using the send_message tool.
//  Available agents: agentB, agentC"

const sendMessage = tool({
  name: 'send_message',
  description: 'Send a message to another agent',
  parameters: z.object({
    to: z.string().describe('Target agent name'),
    message: z.string().describe('Message content'),
  }),
  execute: async ({ to, message }) => {
    const response = await collaborativeSwarm.messageBus.send({
      swarmId: collaborativeSwarm.id,
      from: 'current-agent',
      to,
      type: 'request',
      content: message,
    });
    return response;
  },
});
```

### Shared Blackboard

Agents share a common knowledge space:

```typescript
const researchSwarm = new Swarm(cog, {
  name: 'research-team',
  strategy: 'pipeline',

  pipeline: {
    stages: [
      {
        name: 'search',
        agent: new Agent({ name: 'searcher', instructions: 'Find relevant sources.' }),
      },
      {
        name: 'read',
        agent: new Agent({ name: 'reader', instructions: 'Extract key information.' }),
      },
      {
        name: 'synthesize',
        agent: new Agent({ name: 'synthesizer', instructions: 'Combine findings.' }),
      },
    ],
  },

  // Shared blackboard
  blackboard: {
    enabled: true,
    sections: {
      sources: [], // List of found sources
      facts: [], // Extracted facts
      questions: [], // Unanswered questions
      conclusions: [], // Final conclusions
    },
  },
});

// Agents can read/write to blackboard
const readBlackboard = tool({
  name: 'read_blackboard',
  parameters: z.object({ section: z.string() }),
  execute: async ({ section }) => {
    return researchSwarm.blackboard.read(section);
  },
});

const writeBlackboard = tool({
  name: 'write_blackboard',
  parameters: z.object({
    section: z.string(),
    content: z.any(),
  }),
  execute: async ({ section, content }) => {
    researchSwarm.blackboard.write(section, content, 'agent');
    return { success: true };
  },
});
```

### Event-Driven Coordination

Subscribe to swarm events:

```typescript
const monitoringSwarm = new Swarm(cog, {
  name: 'monitoring-team',
  strategy: 'round-robin',
  agents: [monitorAgent, responderAgent, escalatorAgent],
});

// Subscribe to events (returns unsubscribe function)
const unsub = monitoringSwarm.on('agent:complete', (event) => {
  console.log(`Agent ${event.agentName} completed`);
});

// Emit custom events via the event emitter
monitoringSwarm.events.emit('swarm:start', { swarmId: monitoringSwarm.id });

// Clean up listener
unsub();
```

---

## Swarm Patterns

### 1. Supervisor-Worker

Classic delegation pattern:

```typescript
const supervisorWorker = new Swarm(cog, {
  name: 'project-team',
  strategy: 'hierarchical',

  supervisor: new Agent({
    name: 'project-manager',
    instructions: `
      You manage a team of specialists.

      Available workers:
      - designer: UI/UX design
      - developer: Code implementation
      - tester: Quality assurance

      Delegate tasks by calling: delegate_task(worker, task)
      Check status by calling: check_progress(worker)
      Request changes by calling: request_revision(worker, feedback)
    `,
    tools: [delegateTask, checkProgress, requestRevision],
  }),

  workers: [designerAgent, developerAgent, testerAgent],

  hierarchical: {
    // Supervisor can see worker outputs
    visibility: 'full',

    // Workers cannot message each other directly
    workerCommunication: false,

    // All messages go through supervisor
    routeThrough: 'supervisor',
  },
});
```

### 2. Quality Gate

Multi-stage validation pipeline:

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
        // Must pass to continue
        condition: (output) => (output as { valid: boolean }).valid === true,
        onFail: 'retry-previous', // or 'abort', 'skip', 'goto:<stage>'
        maxRetries: 3,
      },
      'final-review': {
        condition: (output) => (output as { approved: boolean }).approved === true,
        onFail: 'goto:refine', // Go back to refine stage
        maxRetries: 2,
      },
    },
  },
});
```

### 3. Expert Routing

Route tasks to the most capable specialist:

```typescript
const expertPool = new Swarm(cog, {
  name: 'expert-pool',
  strategy: 'auction',

  agents: [
    new Agent({
      name: 'database-expert',
      instructions: 'Database queries, schema design, SQL optimization.',
    }),
    new Agent({ name: 'api-expert', instructions: 'REST APIs, GraphQL, authentication.' }),
    new Agent({ name: 'frontend-expert', instructions: 'React, Vue, CSS, user interfaces.' }),
    new Agent({ name: 'devops-expert', instructions: 'Docker, Kubernetes, CI/CD, monitoring.' }),
  ],

  auction: {
    bidding: 'capability-match',
    selection: 'highest-bid',
  },
});
```

### 4. Multi-Party Negotiation

Structured agreement-reaching:

```typescript
const negotiation = new Swarm(cog, {
  name: 'resource-allocation',
  strategy: 'negotiation',

  agents: [
    new Agent({ name: 'team-a', instructions: 'Advocate for Team A resource needs.' }),
    new Agent({ name: 'team-b', instructions: 'Advocate for Team B resource needs.' }),
    new Agent({ name: 'team-c', instructions: 'Advocate for Team C resource needs.' }),
  ],

  // Optional: supervisor to break deadlocks
  supervisor: new Agent({
    name: 'cto',
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
const swarm = new Swarm(cog, {
  name: 'managed-swarm',
  strategy: 'round-robin',
  agents: [...],

  resources: {
    // Max concurrent agent runs
    maxConcurrency: 5,

    // Total token budget
    tokenBudget: 100_000,

    // Cost limit
    costLimit: 1.00, // $1.00

    // Time limit
    timeout: 300_000, // 5 minutes

    // Per-agent limits
    perAgent: {
      maxIterations: 10,
      maxTokens: 10_000,
    },
  },
});
```

### Error Handling

```typescript
const swarm = new Swarm(cog, {
  name: 'resilient-swarm',
  strategy: 'round-robin',
  agents: [...],

  errorHandling: {
    // What to do when an agent fails
    onAgentFailure: 'retry', // 'retry' | 'skip' | 'failover' | 'abort'

    // Retry configuration
    retry: {
      maxRetries: 3,
      backoff: 'exponential',
      initialDelay: 1000,
    },

    // Failover to backup agent
    failover: {
      'primary-coder': 'backup-coder',
    },

    // Circuit breaker
    circuitBreaker: {
      enabled: true,
      threshold: 5, // Open after 5 failures
      resetTimeout: 60_000,
    },
  },
});
```

### Observability

```typescript
const swarm = new Swarm(cog, {
  name: 'observable-swarm',
  strategy: 'pipeline',
  pipeline: { stages: [...] },

  observability: {
    // Trace all agent interactions
    tracing: true,

    // Log message passing
    messageLogging: true,

    // Log blackboard changes
    blackboardLogging: true,
  },
});

// Subscribe to all events for custom observability
swarm.on('*', (event) => {
  console.log(`[${event.type}]`, event.data);
});
```

---

## SwarmBuilder API

Fluent builder for constructing swarms:

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

---

## Assessor — Automatic Model Assignment

The assessor analyzes your task and automatically assigns the best LLM to each agent:

```typescript
import { swarm } from '@cogitator-ai/swarms';

const mySwarm = swarm('dev-team')
  .strategy('hierarchical')
  .supervisor(supervisorAgent)
  .workers([frontendAgent, backendAgent])
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

// Run with auto-assigned models
const result = await mySwarm.run({ input: 'Build a REST API' });
console.log(mySwarm.getLastAssessment()?.totalEstimatedCost);
```

---

## API Reference

### Swarm Class

```typescript
class Swarm {
  constructor(cogitator: Cogitator, config: SwarmConfig, assessorConfig?: AssessorConfig);

  // Identifiers
  get name(): string;
  get id(): string;
  get strategyType(): string;

  // Run the swarm
  run(options: SwarmRunOptions): Promise<StrategyResult>;

  // Dry run — analyze model assignments without executing (requires assessor)
  dryRun(options: { input: string }): Promise<AssessmentResult>;

  // Get last assessor result
  getLastAssessment(): AssessmentResult | undefined;

  // Access individual agents
  getAgent(name: string): SwarmAgent | undefined;
  getAgents(): SwarmAgent[];

  // Communication interfaces
  get messageBus(): MessageBus;
  get blackboard(): Blackboard;
  get events(): SwarmEventEmitter;

  // Event subscription (returns unsubscribe fn)
  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;
  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;

  // Resource usage
  getResourceUsage(): SwarmResourceUsage;

  // Control
  pause(): void;
  resume(): void;
  abort(): void;
  isPaused(): boolean;
  isAborted(): boolean;
  reset(): void;

  // Close distributed connections
  close(): Promise<void>;
}
```

### SwarmConfig

```typescript
interface SwarmConfig {
  name: string;

  // Strategy selection
  strategy:
    | 'hierarchical'
    | 'round-robin'
    | 'consensus'
    | 'auction'
    | 'pipeline'
    | 'debate'
    | 'negotiation';

  // Agents
  supervisor?: Agent;
  workers?: Agent[];
  agents?: Agent[];
  stages?: PipelineStage[]; // legacy alias for pipeline.stages
  moderator?: Agent;
  router?: Agent;

  // Strategy-specific config (use the matching key for your strategy)
  hierarchical?: HierarchicalConfig;
  roundRobin?: RoundRobinConfig;
  consensus?: ConsensusConfig;
  auction?: AuctionConfig;
  pipeline?: PipelineConfig;
  debate?: DebateConfig;
  negotiation?: NegotiationConfig;

  // Communication
  messaging?: MessageBusConfig;
  blackboard?: BlackboardConfig;

  // Resources & limits
  resources?: SwarmResourceConfig;
  errorHandling?: SwarmErrorConfig;

  // Observability
  observability?: {
    tracing?: boolean;
    messageLogging?: boolean;
    blackboardLogging?: boolean;
  };

  // Distributed execution (Redis-backed)
  distributed?: DistributedSwarmConfig;
}
```

### SwarmRunOptions

```typescript
interface SwarmRunOptions {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
  timeout?: number;
  saveHistory?: boolean;

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
  agentResults: Map<string, RunResult>;

  // Strategy-specific fields
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
// Good: Specific, non-overlapping roles
const team = new Swarm(cog, {
  name: 'content-team',
  strategy: 'pipeline',
  pipeline: {
    stages: [
      {
        name: 'research',
        agent: new Agent({ name: 'researcher', instructions: 'Find and verify information.' }),
      },
      {
        name: 'write',
        agent: new Agent({ name: 'writer', instructions: 'Write clear, engaging content.' }),
      },
      {
        name: 'edit',
        agent: new Agent({ name: 'editor', instructions: 'Polish grammar and style.' }),
      },
    ],
  },
});

// Bad: Vague, overlapping roles
const badTeam = new Swarm(cog, {
  name: 'bad-team',
  strategy: 'round-robin',
  agents: [
    new Agent({ name: 'helper1', instructions: 'Help with tasks.' }),
    new Agent({ name: 'helper2', instructions: 'Assist with work.' }),
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
const swarm = new Swarm(cog, {
  name: 'bounded-swarm',
  strategy: 'round-robin',
  agents: [...],
  messaging: {
    enabled: true,
    protocol: 'direct',
    // Limit message length
    maxMessageLength: 2000,

    // Limit messages per turn
    maxMessagesPerTurn: 5,

    // Prevent infinite loops
    maxTotalMessages: 100,
  },
});
```

### 4. Graceful Degradation

```typescript
const swarm = new Swarm(cog, {
  name: 'resilient-swarm',
  strategy: 'auction',
  agents: [...],
  errorHandling: {
    onAgentFailure: 'failover',
    // If specialist unavailable, use generalist
    failover: {
      'python-expert': 'general-coder',
      'devops-expert': 'general-coder',
    },

    // Continue with partial results
    partialResults: true,
  },
});
```
