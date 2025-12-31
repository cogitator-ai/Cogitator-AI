# @cogitator-ai/swarms

Multi-agent swarm coordination for Cogitator. Orchestrate teams of AI agents with various collaboration strategies, automatic model selection, built-in communication primitives, and workflow integration.

## Installation

```bash
pnpm add @cogitator-ai/swarms
```

## Quick Start

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { SwarmBuilder } from '@cogitator-ai/swarms';

const cogitator = new Cogitator({ defaultModel: 'gpt-4o' });

const swarm = new SwarmBuilder('dev-team')
  .strategy('hierarchical')
  .supervisor(new Agent({ name: 'lead', instructions: 'Coordinate the team' }))
  .workers([
    new Agent({ name: 'coder', instructions: 'Write code' }),
    new Agent({ name: 'tester', instructions: 'Test code' }),
  ])
  .build(cogitator);

const result = await swarm.run({
  input: 'Build a REST API for user management',
});

console.log(result.output);
```

## Features

- **6 Coordination Strategies** - Hierarchical, round-robin, consensus, pipeline, debate, auction
- **Automatic Model Selection** - SwarmAssessor matches optimal models to agent roles
- **Agent Communication** - Message bus and shared blackboard
- **Built-in Tools** - Messaging, delegation, voting, and blackboard tools for agents
- **Workflow Integration** - Use swarms as nodes in DAG workflows
- **Resource Tracking** - Monitor tokens, costs, and time budgets
- **Circuit Breaker** - Prevent cascading failures in swarm execution

---

## Strategies

### Hierarchical

Supervisor delegates tasks to workers:

```typescript
import { SwarmBuilder, Swarm } from '@cogitator-ai/swarms';

const swarm = new SwarmBuilder('dev-team')
  .strategy('hierarchical')
  .supervisor(
    new Agent({
      name: 'tech-lead',
      instructions: 'Break down tasks and delegate to workers',
    })
  )
  .workers([
    new Agent({ name: 'frontend-dev', instructions: 'Build UI components' }),
    new Agent({ name: 'backend-dev', instructions: 'Build API endpoints' }),
    new Agent({ name: 'tester', instructions: 'Write and run tests' }),
  ])
  .hierarchical({
    maxDelegations: 5,
    requireApproval: false,
    parallelExecution: true,
  })
  .build(cogitator);

const result = await swarm.run({
  input: 'Build a user authentication system',
});
```

### Round-Robin

Load-balanced rotation across agents:

```typescript
const swarm = new SwarmBuilder('support-team')
  .strategy('round-robin')
  .agents([
    new Agent({ name: 'support-1', instructions: 'Handle customer queries' }),
    new Agent({ name: 'support-2', instructions: 'Handle customer queries' }),
    new Agent({ name: 'support-3', instructions: 'Handle customer queries' }),
  ])
  .roundRobin({
    maxRounds: 10,
    skipUnavailable: true,
  })
  .build(cogitator);
```

### Consensus

Voting-based decisions with multiple agents:

```typescript
const swarm = new SwarmBuilder('review-board')
  .strategy('consensus')
  .agents([
    new Agent({ name: 'reviewer-1', instructions: 'Review from security perspective' }),
    new Agent({ name: 'reviewer-2', instructions: 'Review from performance perspective' }),
    new Agent({ name: 'reviewer-3', instructions: 'Review from UX perspective' }),
  ])
  .consensus({
    votingMethod: 'majority',
    minVotes: 2,
    timeout: 30000,
    tieBreaker: 'random',
  })
  .build(cogitator);
```

### Pipeline

Sequential processing stages:

```typescript
const swarm = new SwarmBuilder('content-pipeline')
  .strategy('pipeline')
  .pipeline({
    stages: [
      { agent: new Agent({ name: 'researcher', instructions: 'Research the topic' }) },
      { agent: new Agent({ name: 'writer', instructions: 'Write the content' }) },
      { agent: new Agent({ name: 'editor', instructions: 'Edit and refine' }) },
      { agent: new Agent({ name: 'reviewer', instructions: 'Final review' }) },
    ],
    stopOnError: true,
    passContext: true,
  })
  .build(cogitator);
```

### Debate

Multiple perspectives with synthesis:

```typescript
const swarm = new SwarmBuilder('analysis-team')
  .strategy('debate')
  .agents([
    new Agent({ name: 'optimist', instructions: 'Present positive aspects' }),
    new Agent({ name: 'skeptic', instructions: 'Challenge assumptions' }),
    new Agent({ name: 'pragmatist', instructions: 'Focus on practicality' }),
  ])
  .moderator(
    new Agent({
      name: 'moderator',
      instructions: 'Guide discussion and synthesize conclusions',
    })
  )
  .debate({
    rounds: 3,
    requireSynthesis: true,
    maxTurnsPerRound: 2,
  })
  .build(cogitator);
```

### Auction

Bidding-based task assignment:

```typescript
const swarm = new SwarmBuilder('contractor-pool')
  .strategy('auction')
  .agents([
    new Agent({ name: 'contractor-1', instructions: 'Bid based on expertise' }),
    new Agent({ name: 'contractor-2', instructions: 'Bid based on expertise' }),
    new Agent({ name: 'contractor-3', instructions: 'Bid based on expertise' }),
  ])
  .auction({
    biddingRounds: 2,
    selectionCriteria: 'lowest',
    allowNegotiation: true,
  })
  .build(cogitator);
```

---

## SwarmAssessor (Automatic Model Selection)

SwarmAssessor automatically analyzes tasks and matches optimal models to agent roles based on capabilities, cost, and availability.

### Basic Usage

```typescript
import { SwarmBuilder, createAssessor } from '@cogitator-ai/swarms';

const swarm = new SwarmBuilder('smart-team')
  .strategy('hierarchical')
  .supervisor(new Agent({ name: 'lead', instructions: '...' }))
  .workers([
    new Agent({ name: 'coder', instructions: '...' }),
    new Agent({ name: 'analyst', instructions: '...' }),
  ])
  .withAssessor({
    mode: 'rules',
    preferLocal: true,
    minCapabilityMatch: 0.3,
    maxCostPerRun: 0.5,
  })
  .build(cogitator);

// Models are automatically selected based on task requirements
const result = await swarm.run({ input: 'Complex coding task' });

// View what models were assigned
const assessment = swarm.getLastAssessment();
console.log(assessment?.assignments);
```

### Dry Run (Preview Assignments)

```typescript
const assessment = await swarm.dryRun({
  input: 'Build a recommendation engine',
});

console.log('Task complexity:', assessment.taskAnalysis.complexity);
console.log('Estimated cost:', assessment.totalEstimatedCost);

for (const assignment of assessment.assignments) {
  console.log(`${assignment.agentName}: ${assignment.assignedModel} (score: ${assignment.score})`);
}
```

### Assessor Configuration

```typescript
import { createAssessor, SwarmAssessor } from '@cogitator-ai/swarms';

const assessor = createAssessor({
  mode: 'rules',
  assessorModel: 'gpt-4o-mini',
  preferLocal: true,
  minCapabilityMatch: 0.3,
  ollamaUrl: 'http://localhost:11434',
  enabledProviders: ['ollama', 'openai', 'anthropic', 'google'],
  cacheAssessments: true,
  cacheTTL: 5 * 60 * 1000,
  maxCostPerRun: 1.0,
});
```

### Model Suggestions

```typescript
const candidates = await assessor.suggestModels({
  capabilities: ['code', 'reasoning'],
  complexity: 'complex',
  contextLength: 8000,
});

for (const model of candidates) {
  console.log(`${model.modelId} (${model.provider}): score ${model.score}`);
}
```

### Assessor Components

| Component        | Description                                   |
| ---------------- | --------------------------------------------- |
| `TaskAnalyzer`   | Analyzes task complexity and requirements     |
| `ModelDiscovery` | Discovers available models from all providers |
| `ModelScorer`    | Scores models against role requirements       |
| `RoleMatcher`    | Matches agents to optimal models              |

---

## Agent Communication

### Message Bus

Agents can send direct messages and broadcasts:

```typescript
import { InMemoryMessageBus, createMessagingTools } from '@cogitator-ai/swarms';

const messageBus = new InMemoryMessageBus();

// Create tools for an agent
const tools = createMessagingTools(messageBus, 'agent-1');

// Tools available:
// - send_message: Send to specific agent
// - read_messages: Read incoming messages
// - broadcast_message: Send to all agents
// - reply_to_message: Reply to a specific message
```

### Blackboard (Shared State)

Agents can read/write shared state:

```typescript
import { InMemoryBlackboard, createBlackboardTools } from '@cogitator-ai/swarms';

const blackboard = new InMemoryBlackboard();

const tools = createBlackboardTools(blackboard, 'agent-1');

// Tools available:
// - read_blackboard: Read a section
// - write_blackboard: Write to a section
// - append_blackboard: Append to array section
// - list_blackboard_sections: List all sections
// - get_blackboard_history: Get change history
```

### Swarm Configuration with Communication

```typescript
const swarm = new SwarmBuilder('research-team')
  .strategy('hierarchical')
  .supervisor(supervisorAgent)
  .workers([researcher1, researcher2])
  .messaging({
    enabled: true,
    historySize: 100,
    channels: ['findings', 'questions', 'progress'],
  })
  .blackboardConfig({
    enabled: true,
    sections: {
      findings: [],
      sources: [],
      conclusions: '',
    },
  })
  .build(cogitator);
```

---

## Built-in Swarm Tools

### All Tools at Once

```typescript
import { createSwarmTools, SwarmToolContext } from '@cogitator-ai/swarms';

const context: SwarmToolContext = {
  coordinator,
  blackboard,
  messageBus,
  events,
  agentName: 'my-agent',
  agentWeight: 1,
};

const tools = createSwarmTools(context);
// Returns 16 tools: messaging (4) + blackboard (5) + delegation (4) + voting (4)
```

### Strategy-Specific Tools

```typescript
import { createStrategyTools } from '@cogitator-ai/swarms';

// Get tools appropriate for the strategy
const tools = createStrategyTools('hierarchical', context);
// Returns: messaging + blackboard + delegation tools

const debateTools = createStrategyTools('debate', context);
// Returns: messaging + blackboard + voting tools
```

### Delegation Tools (Hierarchical)

```typescript
import { createDelegationTools } from '@cogitator-ai/swarms';

const tools = createDelegationTools(coordinator, blackboard, 'supervisor');

// delegate_task - Assign work to a worker
// check_progress - Monitor worker status
// request_revision - Ask for corrections
// list_workers - See available workers
```

### Voting Tools (Consensus/Debate)

```typescript
import { createVotingTools } from '@cogitator-ai/swarms';

const tools = createVotingTools(blackboard, events, 'voter-1', 1.0);

// cast_vote - Submit a vote
// get_votes - See current votes
// change_vote - Modify your vote
// get_consensus_status - Check if consensus reached
```

---

## Workflow Integration

Use swarms as nodes in DAG workflows.

### Basic Swarm Node

```typescript
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { swarmNode, SwarmNodeContext } from '@cogitator-ai/swarms';

const analysisSwarm = new SwarmBuilder('analysis')
  .strategy('debate')
  .agents([...])
  .build(cogitator);

const workflow = new WorkflowBuilder('analysis-flow')
  .addNode('analyze', swarmNode(analysisSwarm, {
    inputMapper: (state) => state.document,
    stateMapper: (result) => ({ analysis: result.output }),
  }))
  .build();

const result = await workflow.run({
  cogitator,
  input: { document: 'Analyze this document...' },
});
```

### Conditional Swarm Node

```typescript
import { conditionalSwarmNode } from '@cogitator-ai/swarms';

const workflow = new WorkflowBuilder('conditional-flow')
  .addNode(
    'expert-review',
    conditionalSwarmNode(expertSwarm, (state) => state.needsExpertReview, {
      stateMapper: (result) => ({ expertOpinion: result.output }),
    })
  )
  .build();
```

### Parallel Swarms Node

```typescript
import { parallelSwarmsNode } from '@cogitator-ai/swarms';

const workflow = new WorkflowBuilder('parallel-analysis')
  .addNode(
    'multi-analyze',
    parallelSwarmsNode(
      [
        { swarm: technicalSwarm, key: 'technical' },
        { swarm: businessSwarm, key: 'business' },
        { swarm: legalSwarm, key: 'legal' },
      ],
      (results) => ({
        technicalAnalysis: results.technical.output,
        businessAnalysis: results.business.output,
        legalAnalysis: results.legal.output,
      })
    )
  )
  .build();
```

---

## Resource Tracking

Monitor and limit resource usage during swarm execution.

### Configuration

```typescript
const swarm = new SwarmBuilder('budget-conscious')
  .strategy('hierarchical')
  .supervisor(lead)
  .workers(workers)
  .resources({
    tokenBudget: 100000,
    costLimit: 5.0,
    timeout: 300000,
  })
  .build(cogitator);
```

### ResourceTracker API

```typescript
import { ResourceTracker } from '@cogitator-ai/swarms';

const tracker = new ResourceTracker({
  tokenBudget: 50000,
  costLimit: 2.0,
  timeout: 60000,
});

// Track agent runs
tracker.trackAgentRun('agent-1', runResult);

// Check budget
console.log('Within budget:', tracker.isWithinBudget());
console.log('Remaining:', tracker.getRemainingBudget());

// Get usage stats
const usage = tracker.getUsage();
console.log('Total tokens:', usage.totalTokens);
console.log('Total cost:', usage.totalCost);
console.log('Elapsed time:', usage.elapsedTime);

// Per-agent usage
const agentUsage = tracker.getAgentUsage('agent-1');
console.log('Agent tokens:', agentUsage?.tokens);
```

### Swarm Resource Usage

```typescript
const result = await swarm.run({ input: 'Task...' });

const usage = swarm.getResourceUsage();
console.log('Total tokens:', usage.totalTokens);
console.log('Total cost:', usage.totalCost);

for (const [agent, stats] of usage.agentUsage) {
  console.log(`${agent}: ${stats.tokens} tokens, ${stats.runs} runs`);
}
```

---

## Circuit Breaker

Prevent cascading failures in swarm execution.

```typescript
import { CircuitBreaker } from '@cogitator-ai/swarms';

const breaker = new CircuitBreaker({
  threshold: 5,
  resetTimeout: 30000,
  successThreshold: 2,
});

// Check before execution
if (breaker.canExecute()) {
  try {
    const result = await runTask();
    breaker.recordSuccess();
  } catch (error) {
    breaker.recordFailure();
    throw error;
  }
} else {
  console.log('Circuit is open, skipping execution');
}

// Monitor state changes
breaker.onStateChange((state) => {
  console.log('Circuit state:', state); // 'closed' | 'open' | 'half-open'
});

// Reset manually
breaker.reset();
```

### Swarm Error Handling Configuration

```typescript
const swarm = new SwarmBuilder('resilient-team')
  .strategy('hierarchical')
  .supervisor(lead)
  .workers(workers)
  .errorHandling({
    retryCount: 3,
    retryDelay: 1000,
    circuitBreaker: {
      threshold: 5,
      resetTimeout: 30000,
    },
    fallbackAgent: fallbackAgent,
  })
  .build(cogitator);
```

---

## Swarm Events

Subscribe to swarm lifecycle events.

```typescript
const swarm = new SwarmBuilder('monitored-team')
  .strategy('hierarchical')
  .supervisor(lead)
  .workers(workers)
  .build(cogitator);

// Subscribe to specific events
swarm.on('swarm:start', (event) => {
  console.log('Swarm started:', event.swarmId);
});

swarm.on('agent:start', (event) => {
  console.log(`Agent ${event.agentName} started`);
});

swarm.on('agent:complete', (event) => {
  console.log(`Agent ${event.agentName} completed`);
});

swarm.on('swarm:complete', (event) => {
  console.log('Swarm completed, agents used:', event.agentCount);
});

swarm.on('swarm:error', (event) => {
  console.error('Swarm error:', event.error);
});

// Subscribe to all events
swarm.on('*', (event) => {
  console.log('Event:', event);
});

// One-time subscription
swarm.once('swarm:complete', (event) => {
  console.log('Finished!');
});
```

### Event Types

| Event               | Description                  |
| ------------------- | ---------------------------- |
| `swarm:start`       | Swarm execution started      |
| `swarm:complete`    | Swarm execution completed    |
| `swarm:error`       | Error during swarm execution |
| `swarm:paused`      | Swarm paused                 |
| `swarm:resumed`     | Swarm resumed                |
| `swarm:aborted`     | Swarm aborted                |
| `swarm:reset`       | Swarm reset                  |
| `agent:start`       | Agent started execution      |
| `agent:complete`    | Agent completed execution    |
| `agent:error`       | Agent encountered error      |
| `assessor:complete` | Model assessment completed   |
| `message:sent`      | Message sent between agents  |
| `blackboard:write`  | Blackboard updated           |
| `vote:cast`         | Vote cast in consensus       |

---

## Swarm Control

### Pause and Resume

```typescript
const swarm = new SwarmBuilder('controllable')
  .strategy('pipeline')
  .pipeline({ stages: [...] })
  .build(cogitator);

// Start execution
const resultPromise = swarm.run({ input: 'Process this...' });

// Pause mid-execution
setTimeout(() => {
  swarm.pause();
  console.log('Paused:', swarm.isPaused());

  // Resume later
  setTimeout(() => {
    swarm.resume();
  }, 5000);
}, 2000);

const result = await resultPromise;
```

### Abort

```typescript
const timeoutId = setTimeout(() => {
  if (!swarm.isAborted()) {
    swarm.abort();
    console.log('Swarm aborted due to timeout');
  }
}, 60000);

try {
  const result = await swarm.run({ input: 'Task...' });
  clearTimeout(timeoutId);
} catch (error) {
  if (swarm.isAborted()) {
    console.log('Task was aborted');
  }
}
```

### Reset

```typescript
// Reset swarm state for a new run
swarm.reset();

// Run again with fresh state
const result = await swarm.run({ input: 'New task...' });
```

---

## Type Reference

### Core Types

```typescript
import type {
  SwarmConfig,
  SwarmRunOptions,
  SwarmAgent,
  SwarmAgentMetadata,
  SwarmAgentState,
  StrategyResult,
  SwarmStrategy,
} from '@cogitator-ai/swarms';
```

### Strategy Types

```typescript
import type {
  HierarchicalConfig,
  RoundRobinConfig,
  ConsensusConfig,
  AuctionConfig,
  PipelineConfig,
  PipelineStage,
  DebateConfig,
} from '@cogitator-ai/swarms';
```

### Communication Types

```typescript
import type {
  MessageBus,
  MessageBusConfig,
  Blackboard,
  BlackboardConfig,
  BlackboardEntry,
  SwarmMessage,
  SwarmMessageType,
} from '@cogitator-ai/swarms';
```

### Assessor Types

```typescript
import type {
  AssessorConfig,
  AssessmentResult,
  TaskRequirements,
  RoleRequirements,
  ModelAssignment,
  ModelCandidate,
  DiscoveredModel,
  ScoredModel,
} from '@cogitator-ai/swarms';
```

### Event Types

```typescript
import type {
  SwarmEventEmitter,
  SwarmEventType,
  SwarmEvent,
  SwarmEventHandler,
} from '@cogitator-ai/swarms';
```

---

## Examples

### Research Team with Shared Knowledge

```typescript
const swarm = new SwarmBuilder('research-team')
  .strategy('hierarchical')
  .supervisor(
    new Agent({
      name: 'lead-researcher',
      instructions: 'Coordinate research and synthesize findings',
    })
  )
  .workers([
    new Agent({
      name: 'web-researcher',
      instructions: 'Search and analyze web sources',
      tools: [webSearchTool],
    }),
    new Agent({
      name: 'data-analyst',
      instructions: 'Analyze data and statistics',
      tools: [calculatorTool],
    }),
    new Agent({
      name: 'writer',
      instructions: 'Write clear summaries',
    }),
  ])
  .messaging({ enabled: true })
  .blackboardConfig({
    enabled: true,
    sections: { findings: [], sources: [], draft: '' },
  })
  .withAssessor({ preferLocal: true })
  .build(cogitator);

const result = await swarm.run({
  input: 'Research the impact of AI on job markets',
});
```

### Code Review Pipeline

```typescript
const swarm = new SwarmBuilder('code-review')
  .strategy('pipeline')
  .pipeline({
    stages: [
      {
        agent: new Agent({
          name: 'syntax-checker',
          instructions: 'Check for syntax errors and style issues',
        }),
      },
      {
        agent: new Agent({
          name: 'security-reviewer',
          instructions: 'Check for security vulnerabilities',
        }),
      },
      {
        agent: new Agent({
          name: 'performance-reviewer',
          instructions: 'Check for performance issues',
        }),
      },
      {
        agent: new Agent({
          name: 'summarizer',
          instructions: 'Summarize all findings',
        }),
      },
    ],
    stopOnError: false,
    passContext: true,
  })
  .build(cogitator);
```

### Decision Making with Consensus

```typescript
const swarm = new SwarmBuilder('investment-committee')
  .strategy('consensus')
  .agents([
    new Agent({ name: 'risk-analyst', instructions: 'Evaluate risks' }),
    new Agent({ name: 'growth-analyst', instructions: 'Evaluate growth potential' }),
    new Agent({ name: 'market-analyst', instructions: 'Evaluate market conditions' }),
  ])
  .consensus({
    votingMethod: 'weighted',
    minVotes: 3,
    weights: { 'risk-analyst': 1.5, 'growth-analyst': 1.0, 'market-analyst': 1.0 },
  })
  .build(cogitator);

const result = await swarm.run({
  input: 'Should we invest in Company X?',
});

console.log('Decision:', result.output);
console.log('Vote breakdown:', result.metadata?.votes);
```

---

## License

MIT
