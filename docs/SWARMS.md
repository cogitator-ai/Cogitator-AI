# Swarms

> Multi-agent coordination patterns

## Overview

Swarms enable multiple agents to work together on complex tasks. Cogitator supports several coordination strategies:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Swarm Coordinator                                   │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Strategy Engine                                 │   │
│   │                                                                         │   │
│   │   Hierarchical  │  Round-Robin  │  Consensus  │  Auction  │  Pipeline  │   │
│   │                                                                         │   │
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

const devTeam = new Swarm({
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
      model: 'claude-3-5-sonnet',
      instructions: 'You are a frontend developer. Build React/Vue components.',
      tools: [fileWrite, npmRun],
    }),

    new Agent({
      name: 'backend-dev',
      model: 'claude-3-5-sonnet',
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
});

const result = await cog.run(devTeam, {
  input: 'Build a user authentication system with login, register, and password reset',
});
```

### 2. Round-Robin

Tasks rotate between agents for balanced workload:

```typescript
const supportTeam = new Swarm({
  name: 'support-team',
  strategy: 'round-robin',

  agents: [
    new Agent({ name: 'support-1', instructions: 'Handle customer support tickets.' }),
    new Agent({ name: 'support-2', instructions: 'Handle customer support tickets.' }),
    new Agent({ name: 'support-3', instructions: 'Handle customer support tickets.' }),
  ],

  // Optional: sticky sessions (same agent handles follow-ups)
  routing: {
    sticky: true,
    stickyKey: (input) => input.ticketId,
  },
});
```

### 3. Consensus

All agents must agree on a decision:

```typescript
const reviewBoard = new Swarm({
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

const result = await cog.run(reviewBoard, {
  input: 'Should we merge this pull request?',
  context: { prDiff: '...' },
});

console.log(result.output);
// { approved: true, votes: { security: 'approve', performance: 'approve', maintainability: 'reject' } }
```

### 4. Auction

Agents bid on tasks based on capability:

```typescript
const expertPool = new Swarm({
  name: 'expert-pool',
  strategy: 'auction',

  agents: [
    new Agent({
      name: 'python-expert',
      instructions: 'Python and data science specialist.',
      metadata: { expertise: ['python', 'pandas', 'ml'] },
    }),
    new Agent({
      name: 'typescript-expert',
      instructions: 'TypeScript and Node.js specialist.',
      metadata: { expertise: ['typescript', 'node', 'react'] },
    }),
    new Agent({
      name: 'devops-expert',
      instructions: 'DevOps and infrastructure specialist.',
      metadata: { expertise: ['docker', 'kubernetes', 'aws'] },
    }),
  ],

  auction: {
    // How agents bid
    bidding: 'capability-match', // Match task keywords to expertise

    // Custom bidding function
    bidFunction: async (agent, task) => {
      const taskKeywords = extractKeywords(task);
      const matchScore = calculateMatch(agent.metadata.expertise, taskKeywords);
      return matchScore;
    },

    // Winner selection
    selection: 'highest-bid', // 'highest-bid' | 'weighted-random'
  },
});

// Task automatically routed to most capable agent
const result = await cog.run(expertPool, {
  input: 'Write a Kubernetes deployment for our Node.js service',
});
// Routed to devops-expert
```

### 5. Pipeline

Sequential processing through specialized agents:

```typescript
const contentPipeline = new Swarm({
  name: 'content-pipeline',
  strategy: 'pipeline',

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
});

const article = await cog.run(contentPipeline, {
  input: 'Write an article about the future of AI agents',
});
```

### 6. Debate

Agents argue opposing positions:

```typescript
const debateSwarm = new Swarm({
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

const decision = await cog.run(debateSwarm, {
  input: 'Should we rewrite our backend in Rust?',
  context: { currentStack: 'Node.js', teamSize: 5 },
});
```

---

## Agent Communication

### Message Passing

Agents can communicate directly:

```typescript
const collaborativeSwarm = new Swarm({
  name: 'collaborative-team',

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
    waitForReply: z.boolean().default(false),
  }),
  execute: async ({ to, message, waitForReply }, { swarm }) => {
    const response = await swarm.sendMessage(to, message, { waitForReply });
    return response;
  },
});
```

### Shared Blackboard

Agents share a common knowledge space:

```typescript
const researchSwarm = new Swarm({
  name: 'research-team',

  agents: [
    new Agent({ name: 'searcher', instructions: 'Find relevant sources.' }),
    new Agent({ name: 'reader', instructions: 'Extract key information.' }),
    new Agent({ name: 'synthesizer', instructions: 'Combine findings.' }),
  ],

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
  execute: async ({ section }, { swarm }) => {
    return swarm.blackboard.read(section);
  },
});

const writeBlackboard = tool({
  name: 'write_blackboard',
  parameters: z.object({
    section: z.string(),
    content: z.any(),
  }),
  execute: async ({ section, content }, { swarm }) => {
    await swarm.blackboard.write(section, content);
    return { success: true };
  },
});
```

### Event-Driven Coordination

Agents react to events:

```typescript
const eventDrivenSwarm = new Swarm({
  name: 'event-driven-team',

  agents: [monitorAgent, responderAgent, escalatorAgent],

  events: {
    error_detected: {
      handler: responderAgent,
      priority: 'high',
    },
    threshold_exceeded: {
      handler: escalatorAgent,
      priority: 'critical',
    },
    task_completed: {
      handler: monitorAgent,
      priority: 'low',
    },
  },
});

// Emit events from agents
const emitEvent = tool({
  name: 'emit_event',
  parameters: z.object({
    event: z.string(),
    data: z.any(),
  }),
  execute: async ({ event, data }, { swarm }) => {
    await swarm.emit(event, data);
    return { emitted: true };
  },
});
```

---

## Swarm Patterns

### 1. Supervisor-Worker

Classic delegation pattern:

```typescript
const supervisorWorker = new Swarm({
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

  coordination: {
    // Supervisor can see worker outputs
    visibility: 'full',

    // Workers cannot message each other directly
    workerCommunication: false,

    // All messages go through supervisor
    routeThrough: 'supervisor',
  },
});
```

### 2. Peer-to-Peer

Equal agents collaborating:

```typescript
const peerToPeer = new Swarm({
  strategy: 'collaborative',

  agents: [
    new Agent({ name: 'alice', instructions: 'Collaborate with peers on problem-solving.' }),
    new Agent({ name: 'bob', instructions: 'Collaborate with peers on problem-solving.' }),
    new Agent({ name: 'charlie', instructions: 'Collaborate with peers on problem-solving.' }),
  ],

  collaboration: {
    // Everyone can message everyone
    topology: 'full-mesh',

    // Take turns speaking
    turnTaking: 'round-robin',

    // End when consensus reached or max turns
    termination: {
      consensus: true,
      maxTurns: 20,
    },
  },
});
```

### 3. Specialist Team

Route to specialists based on need:

```typescript
const specialistTeam = new Swarm({
  strategy: 'specialist',

  router: new Agent({
    name: 'router',
    model: 'gpt-4o-mini', // Fast model for routing
    instructions: `
      Analyze incoming requests and route to the appropriate specialist:
      - database: Database queries, schema design, SQL optimization
      - api: REST APIs, GraphQL, authentication
      - frontend: React, Vue, CSS, user interfaces
      - devops: Docker, Kubernetes, CI/CD, monitoring

      Return the specialist name and reformulated task.
    `,
    responseFormat: {
      type: 'json_schema',
      schema: z.object({
        specialist: z.enum(['database', 'api', 'frontend', 'devops']),
        task: z.string(),
      }),
    },
  }),

  specialists: {
    database: databaseAgent,
    api: apiAgent,
    frontend: frontendAgent,
    devops: devopsAgent,
  },
});
```

### 4. Quality Gate

Multi-stage validation:

```typescript
const qualityGate = new Swarm({
  strategy: 'pipeline',

  stages: [
    { name: 'generate', agent: generatorAgent },
    { name: 'validate', agent: validatorAgent, gate: true },
    { name: 'refine', agent: refinerAgent },
    { name: 'final-review', agent: reviewerAgent, gate: true },
  ],

  gates: {
    validate: {
      // Must pass to continue
      condition: (output) => output.valid === true,
      onFail: 'retry-previous', // or 'abort', 'skip', 'human-review'
      maxRetries: 3,
    },
    'final-review': {
      condition: (output) => output.approved === true,
      onFail: 'goto:refine', // Go back to refine stage
      maxRetries: 2,
    },
  },
});
```

### 5. Self-Improving Team

Agents learn from feedback:

```typescript
const selfImproving = new Swarm({
  strategy: 'adaptive',

  agents: [coderAgent, reviewerAgent],

  learning: {
    enabled: true,

    // Track success metrics
    metrics: ['code_quality', 'review_accuracy', 'iteration_count'],

    // Adjust agent prompts based on performance
    adaptation: {
      trigger: 'after-each-run',
      strategy: 'prompt-refinement',
    },

    // Store learnings
    memory: {
      store: 'postgres',
      retention: '30d',
    },
  },

  feedback: {
    // Human feedback integration
    requestFeedback: true,
    feedbackPrompt: 'Rate the quality of this solution (1-5):',
  },
});
```

---

## Configuration

### Resource Management

```typescript
const swarm = new Swarm({
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
const swarm = new Swarm({
  agents: [...],

  errorHandling: {
    // What to do when an agent fails
    onAgentFailure: 'retry', // 'retry' | 'skip' | 'failover' | 'abort'

    // Retry configuration
    retry: {
      maxRetries: 3,
      backoff: 'exponential',
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
const swarm = new Swarm({
  agents: [...],

  observability: {
    // Trace all agent interactions
    tracing: true,

    // Log message passing
    messageLogging: true,

    // Export metrics
    metrics: {
      exporter: 'prometheus',
      labels: ['swarm_name', 'agent_name', 'strategy'],
    },

    // Visualize in dashboard
    dashboard: {
      enabled: true,
      showAgentState: true,
      showMessageFlow: true,
    },
  },
});
```

---

## API Reference

### Swarm Class

```typescript
class Swarm {
  constructor(config: SwarmConfig);

  // Run the swarm
  run(input: any): Promise<SwarmResult>;

  // Access individual agents
  getAgent(name: string): Agent;

  // Send message to agent
  sendMessage(agentName: string, message: string): Promise<any>;

  // Access blackboard
  blackboard: Blackboard;

  // Event handling
  on(event: string, handler: Function): void;
  emit(event: string, data: any): void;

  // Control
  pause(): void;
  resume(): void;
  abort(): void;
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
    | 'collaborative'
    | 'specialist'
    | 'adaptive';

  // Agents
  supervisor?: Agent;
  workers?: Agent[];
  agents?: Agent[];
  stages?: StageConfig[];
  specialists?: Record<string, Agent>;
  router?: Agent;
  moderator?: Agent;

  // Strategy-specific config
  consensus?: ConsensusConfig;
  auction?: AuctionConfig;
  debate?: DebateConfig;
  collaboration?: CollaborationConfig;

  // Communication
  messaging?: MessagingConfig;
  blackboard?: BlackboardConfig;
  events?: EventConfig;

  // Resources & limits
  resources?: ResourceConfig;
  errorHandling?: ErrorConfig;
  observability?: ObservabilityConfig;
}
```

---

## Best Practices

### 1. Clear Agent Roles

```typescript
// Good: Specific, non-overlapping roles
const team = new Swarm({
  agents: [
    new Agent({ name: 'researcher', instructions: 'Find and verify information.' }),
    new Agent({ name: 'writer', instructions: 'Write clear, engaging content.' }),
    new Agent({ name: 'editor', instructions: 'Polish grammar and style.' }),
  ],
});

// Bad: Vague, overlapping roles
const badTeam = new Swarm({
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

### 3. Communication Limits

```typescript
const swarm = new Swarm({
  messaging: {
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
const swarm = new Swarm({
  errorHandling: {
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
