# @cogitator-ai/swarms

Multi-agent swarm coordination for Cogitator. Orchestrate teams of AI agents with seven collaboration strategies, automatic model selection, shared communication primitives, workflow integration and Redis-backed distributed execution.

## Installation

```bash
pnpm add @cogitator-ai/swarms @cogitator-ai/core
```

Website docs: [Swarms](https://cogitator.app/docs/swarms), [Strategies](https://cogitator.app/docs/swarms/strategies), [Builder](https://cogitator.app/docs/swarms/builder), [Communication](https://cogitator.app/docs/swarms/communication), [Assessment](https://cogitator.app/docs/swarms/assessment), [Distributed](https://cogitator.app/docs/swarms/distributed).

## Quick Start

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { SwarmBuilder } from '@cogitator-ai/swarms';

const cogitator = new Cogitator({ llm: { defaultModel: 'ollama/llama3.2' } });
const model = 'ollama/llama3.2';

const swarm = new SwarmBuilder('dev-team')
  .strategy('hierarchical')
  .supervisor(new Agent({ name: 'lead', model, instructions: 'Coordinate the team' }))
  .workers([
    new Agent({ name: 'coder', model, instructions: 'Write code' }),
    new Agent({ name: 'tester', model, instructions: 'Test code' }),
  ])
  .build(cogitator);

const result = await swarm.run({ input: 'Build a REST API for user management' });
console.log(result.output);
```

Strategies equip agents with the tools they need: the hierarchical supervisor receives `delegate_task`, `check_progress`, `request_revision` and `list_workers`; consensus voters receive the voting tools; negotiating agents receive the negotiation tools. `agentTools` adds the messaging and blackboard tools to every agent (see [Built-in Swarm Tools](#built-in-swarm-tools)). Tools an agent already defines with the same name are kept.

## Features

- **7 Coordination Strategies** — hierarchical, round-robin, consensus, auction, pipeline, debate, negotiation
- **Automatic Model Selection** — `SwarmAssessor` matches models to agent roles
- **Agent Communication** — message bus with read tracking, shared blackboard, `message:*` / `blackboard:write` events
- **Built-in Tools** — messaging, blackboard, delegation, voting and negotiation tools
- **Run Control** — per-run timeout, thread ids, lifecycle callbacks, pause/resume/abort with cancellation of in-flight LLM calls
- **Resilience** — retry with backoff, failover chains, skip, partial results, circuit breaker
- **Resource Limits** — per-run token/cost/time budgets and per-agent caps
- **Workflow Integration** — run swarms as DAG workflow nodes
- **Distributed Execution** — Redis-backed state and worker nodes from `@cogitator-ai/worker`

---

## Agent Roles and Metadata

Agents keep their swarm metadata (role, expertise, weight, model lock) in `agentMetadata`, keyed by agent name. Slot defaults apply automatically: `supervisor` → `role: 'supervisor'`, `workers` → `role: 'worker'`, `moderator` → `role: 'moderator'`, `router` → `role: 'router'`.

```typescript
const swarm = new SwarmBuilder('debate-club')
  .strategy('debate')
  .agents([pro, con])
  .agentMetadata({
    pro: { role: 'advocate', expertise: ['economics'] },
    con: { role: 'critic', weight: 2 },
  })
  .debate({ rounds: 2 })
  .build(cogitator);
```

Agent names must be unique within a swarm.

---

## Strategies

### Hierarchical

A supervisor delegates tasks to workers through the `delegate_task` tool.

```typescript
const swarm = new SwarmBuilder('dev-team')
  .strategy('hierarchical')
  .supervisor(lead)
  .workers([frontend, backend, tester])
  .hierarchical({
    maxDelegationDepth: 2, // workers may re-delegate once
    workerCommunication: false, // workers can only message the supervisor
    routeThrough: 'supervisor',
    visibility: 'summary', // supervisor sees the first 500 chars of worker output
  })
  .build(cogitator);
```

Workers that ran during the supervisor turn are included in `result.agentResults`. Delegating to yourself or to the supervisor is refused.

### Round-Robin

```typescript
const swarm = new SwarmBuilder('support-team')
  .strategy('round-robin')
  .agents([support1, support2, support3])
  .roundRobin({
    rotation: 'sequential',
    sticky: true,
    stickyKey: (input) => String(input).slice(0, 20),
  })
  .build(cogitator);
```

With `sticky: true` a known `stickyKey` stays with the agent that handled it first; new keys keep rotating. Without `stickyKey` every run rotates.

### Consensus

Agents vote with `VOTE: <decision>` in their answer or with the `cast_vote` tool, which voters get automatically together with `get_votes`, `change_vote` and `get_consensus_status`. A decision wins when its share of **all eligible voters** reaches the threshold and it is not tied; abstentions count against it.

```typescript
const swarm = new SwarmBuilder('review-board')
  .strategy('consensus')
  .agents([security, performance, ux])
  .consensus({
    threshold: 0.66,
    maxRounds: 3,
    resolution: 'weighted', // 'majority' | 'unanimous' | 'weighted'
    weights: { security: 2 },
    onNoConsensus: 'escalate', // 'fail' | 'supervisor-decides' | 'escalate'
  })
  .build(cogitator);

const result = await swarm.run({ input: 'Approve the new caching layer?' });
console.log(result.votes);
```

### Pipeline

```typescript
const swarm = new SwarmBuilder('content-pipeline')
  .strategy('pipeline')
  .pipeline({
    stages: [
      { name: 'research', agent: researcher },
      { name: 'draft', agent: writer, gate: true },
      { name: 'edit', agent: editor },
    ],
    gates: {
      draft: {
        condition: (output) => String(output).length > 200,
        onFail: 'retry-previous', // 'abort' | 'skip' | 'goto:<stage>'
        maxRetries: 2,
      },
    },
  })
  .build(cogitator);

const result = await swarm.run({ input: 'Write about vector databases' });
console.log(result.pipelineOutputs);
```

With `new Swarm(cogitator, config)` the stages can also be given as the top-level `stages` field; `gates` and `stageInput` still come from `pipeline`, and different stages in both places are rejected.

### Debate

```typescript
const swarm = new SwarmBuilder('analysis-team')
  .strategy('debate')
  .agents([optimist, skeptic])
  .agentMetadata({ optimist: { role: 'advocate' }, skeptic: { role: 'critic' } })
  .moderator(moderator)
  .debate({ rounds: 3, format: 'structured', maxTokensPerTurn: 400 })
  .build(cogitator);
```

Turns are labelled with the speaker's name and role (`[optimist (advocate)]: ...`). `synthesisPrompt` replaces the moderator's default task, with `{topic}` and `{transcript}` filled in. `maxTokensPerTurn` is the length of a turn's answer. A reasoning model spends its reasoning from the same limit, so a turn it came back from empty or cut off is run once more with room to reason on top (`reasoningTokensPerTurn`, default 4096 on the retry, or twice what it reasoned); set `reasoningTokensPerTurn` to give that room from the first try. A model that does not reason keeps the limit as it is.

### Auction

```typescript
const swarm = new SwarmBuilder('contractor-pool')
  .strategy('auction')
  .agents([contractorA, contractorB])
  .auction({
    bidding: 'capability-match', // agents bid via LLM; or 'custom' with bidFunction
    selection: 'highest-bid', // or 'weighted-random'
    minBid: 0.3,
  })
  .build(cogitator);
```

### Negotiation

Agents negotiate with structured offers through the negotiation tools (`make_offer`, `counter_offer`, `accept_offer`, `reject_offer`, coalitions, interests). An offer becomes an agreement once **every recipient** accepted it.

```typescript
const swarm = new SwarmBuilder('deal-makers')
  .strategy('negotiation')
  .agents([buyer, seller])
  .negotiation({
    maxRounds: 6,
    onDeadlock: 'arbitrate', // 'escalate' | 'supervisor-decides' | 'majority-rules' | 'arbitrate' | 'fail'
    maxOffersPerRound: 2,
    offerTimeout: 120_000,
    turnTimeout: 60_000,
    allowCoalitions: false,
    quorum: 1, // all parties must be part of the agreement
  })
  .build(cogitator);

const result = await swarm.run({ input: 'Agree on price and delivery date' });
console.log(result.negotiationResult?.agreement);
```

When stagnation is detected, the strategy proposes a mediated compromise as an offer from `mediator`; agents accept it with `accept_offer`.

Approval gates (`approvalGates`) announce each request with the `negotiation:approval-required` event. A gate with `timeout` resolves by its `timeoutAction`; a gate without one waits for your answer. A run `timeout` or `swarm.abort()` stops the wait.

```typescript
import type { NegotiationApprovalRequest } from '@cogitator-ai/types';

swarm.on('negotiation:approval-required', (event) => {
  const { request } = event.data as { request: NegotiationApprovalRequest };
  swarm.respondToApproval(request.id, {
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

## Running Swarms

```typescript
const result = await swarm.run({
  input: 'Plan the release',
  threadId: 'release-42', // each agent uses thread `release-42:<agent>`
  timeout: 120_000, // rejects with SwarmTimeoutError and cancels the run
  saveHistory: false,
  context: { project: 'cogitator' },
  onAgentStart: (agent) => console.log('start', agent),
  onAgentComplete: (agent, run) => console.log('done', agent, run.usage.totalTokens),
  onAgentError: (agent, error) => console.error(agent, error.message),
  onMessage: (message) => console.log(`${message.from} → ${message.to}`),
  onEvent: (event) => console.log(event.type),
});
```

A `Swarm` instance runs one task at a time; create separate instances for concurrent runs.

A run that times out or fails is cancelled as a whole: in-flight LLM calls are aborted, and work its strategy still has in flight starts no further agents or retries, even after `run()` has rejected or the next run of the same swarm has begun. Coordinators bind strategy work to its run with `runInScope(scope, work)` (`BaseSwarmCoordinator`), so every agent run takes the thread, user and abort signal of the run that started it.

### Pause, Resume, Abort, Reset

```typescript
const running = swarm.run({ input: 'Long task' });

swarm.pause(); // agents wait before their next turn
swarm.resume();
swarm.abort(); // rejects pending turns and cancels in-flight LLM calls

await running.catch(() => {});
await swarm.reset(); // clears abort state, budgets, messages and blackboard
```

---

## Error Handling and Limits

```typescript
const swarm = new SwarmBuilder('resilient-team')
  .strategy('round-robin')
  .agents([primary, backup])
  .errorHandling({
    onAgentFailure: 'failover', // 'retry' | 'failover' | 'skip' | 'abort'
    failover: { primary: 'backup' },
    retry: { maxRetries: 3, backoff: 'exponential', initialDelay: 500, maxDelay: 10_000 },
    circuitBreaker: { enabled: true, threshold: 5, resetTimeout: 30_000 },
    partialResults: true, // parallel phases return the agents that succeeded
  })
  .resources({
    maxConcurrency: 4,
    tokenBudget: 100_000, // per run
    costLimit: 5,
    timeout: 300_000,
    perAgent: { maxTokens: 2_000, maxIterations: 5, timeout: 60_000 },
  })
  .build(cogitator);

const usage = swarm.getResourceUsage();
```

`CircuitBreaker` and `ResourceTracker` are exported for standalone use.

---

## Agent Communication

### Message Bus

```typescript
await swarm.messageBus.send({
  swarmId: swarm.id,
  from: 'operator',
  to: 'coder',
  type: 'notification',
  content: 'Use TypeScript strict mode',
});
```

Unread messages are injected into the recipient's next turn exactly once (`message:received` event). `maxMessagesPerTurn` limits how many messages an agent may send per turn.

### Blackboard

```typescript
const swarm = new SwarmBuilder('research-team')
  .strategy('hierarchical')
  .supervisor(lead)
  .workers([researcher])
  .messaging({ enabled: true, maxMessagesPerTurn: 5 })
  .blackboardConfig({ enabled: true, sections: { findings: [] }, trackHistory: true })
  .observability({ messageLogging: true, blackboardLogging: true })
  .build(cogitator);

swarm.blackboard.subscribe('findings', (data, writer) => console.log(writer, data));
```

---

## Built-in Swarm Tools

Enable `agentTools` to give every agent the messaging and blackboard tools, bound to the swarm's own bus and blackboard (local swarms only; rejected when distributed or when the bus / blackboard is disabled):

```typescript
const swarm = new SwarmBuilder('research-team')
  .strategy('round-robin')
  .agents([researcher, writer])
  .agentTools({ messaging: true, blackboard: true })
  .build(cogitator);
```

Consensus voters get the voting tools automatically. For custom strategies and coordinators, the factories build any tool set:

```typescript
import { createSwarmTools, createStrategyTools, type SwarmToolContext } from '@cogitator-ai/swarms';

const context: SwarmToolContext = {
  coordinator, // the swarm coordinator (SwarmCoordinatorInterface)
  blackboard: swarm.blackboard,
  messageBus: swarm.messageBus,
  events: swarm.events,
  agentName: 'coder',
  swarmId: swarm.id,
};

const allTools = createSwarmTools(context); // messaging, blackboard, delegation, voting, negotiation
const hierarchicalTools = createStrategyTools('hierarchical', context);
```

| Factory                  | Tools                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMessagingTools`   | `send_message` (optional `waitForReply`), `read_messages` (marks returned messages read), `broadcast_message`, `reply_to_message`                                         |
| `createBlackboardTools`  | `read_blackboard`, `write_blackboard` (`merge` extends arrays / merges objects), `append_blackboard`, `list_blackboard_sections`, `get_blackboard_history`                |
| `createDelegationTools`  | `delegate_task`, `check_progress`, `request_revision`, `list_workers`                                                                                                     |
| `createVotingTools`      | `cast_vote`, `get_votes`, `change_vote`, `get_consensus_status`                                                                                                           |
| `createNegotiationTools` | `make_offer`, `counter_offer`, `accept_offer`, `reject_offer`, `get_negotiation_status`, `get_current_offers`, `propose_coalition`, `join_coalition`, `declare_interests` |

Messaging tools created through `createSwarmTools`/`createStrategyTools` enforce the hierarchical communication policy (`createHierarchyMessageAuthorizer`).

---

## SwarmAssessor (Automatic Model Selection)

```typescript
const swarm = new SwarmBuilder('smart-team')
  .strategy('hierarchical')
  .supervisor(lead)
  .workers([coder, analyst])
  .agentMetadata({ lead: { locked: true }, coder: { expertise: ['code'] } })
  .withAssessor({
    mode: 'rules',
    preferLocal: true,
    minCapabilityMatch: 0.3,
    maxCostPerRun: 0.5,
    enabledProviders: ['ollama', 'openai'],
  })
  .build(cogitator);

const preview = await swarm.dryRun({ input: 'Build a recommendation engine' });
for (const a of preview.assignments) {
  console.log(`${a.agentName}: ${a.assignedModel} (score ${a.score})`);
}

await swarm.run({ input: 'Build a recommendation engine' });
console.log(swarm.getLastAssessment()?.assignments);
```

Assigned models are provider-qualified (e.g. `ollama/llama3.2:3b`). Unlocked agents are replaced by clones running the assigned model; locked agents keep theirs.

`mode: 'rules'` (default) analyzes the task with keyword rules. `'ai'` lets the `assessorModel` (default: the Cogitator's default model) analyze it; `'hybrid'` adds every hard requirement the rules detect. Both fall back to the rules with a warning when the model cannot run. Inside a Swarm only cloud models whose provider the Cogitator can route (API key configured) are offered; standalone, pass the Cogitator to `createAssessor(config, cogitator)` for the same behaviour.

---

## Workflow Integration

```typescript
import { WorkflowBuilder, WorkflowExecutor } from '@cogitator-ai/workflows';
import { swarmNode, parallelSwarmsNode } from '@cogitator-ai/swarms';

const workflow = new WorkflowBuilder<{ document: string; analysis?: unknown }>('analysis-flow')
  .initialState({ document: '' })
  .addNode(
    'analyze',
    swarmNode(analysisSwarm, {
      inputMapper: (state) => state.document,
      stateMapper: (result) => ({ analysis: result.output }),
    })
  )
  .build();

const result = await new WorkflowExecutor(cogitator).execute(workflow, {
  document: 'Analyze this...',
});
```

`conditionalSwarmNode(swarm, condition, options)` and `parallelSwarmsNode([{ swarm, key }], merge)` are also available. Pass a `SwarmConfig` instead of a `Swarm` to create (and close) a fresh swarm per execution.

---

## Swarm Events

```typescript
swarm.on('agent:complete', (event) => console.log(event.agentName));
swarm.once('swarm:complete', () => console.log('done'));
const unsubscribe = swarm.on('*', (event) => console.log(event.type));
unsubscribe();
```

Subscriptions survive the coordinator rebuild that happens after model assessment.

| Event                                                                                         | Description                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `swarm:start` / `swarm:complete` / `swarm:error`                                              | Run lifecycle                                    |
| `swarm:paused` / `swarm:resumed` / `swarm:aborted` / `swarm:reset`                            | Control actions                                  |
| `agent:start` / `agent:complete` / `agent:error`                                              | Agent turns                                      |
| `message:sent` / `message:received`                                                           | Bus messages sent / delivered to an agent's turn |
| `blackboard:write`                                                                            | Section written or deleted                       |
| `assessor:complete`                                                                           | Model assessment finished                        |
| `consensus:*`, `debate:*`, `auction:*`, `pipeline:*`, `round-robin:assigned`, `negotiation:*` | Strategy progress                                |

---

## Distributed Execution

With `distributed.enabled`, the swarm keeps its message bus, blackboard and events in Redis and dispatches every agent turn as a job. Worker nodes from `@cogitator-ai/worker` execute the turns and publish results back.

```typescript
const swarm = new SwarmBuilder('distributed-team')
  .strategy('pipeline')
  .pipeline({
    stages: [
      { name: 'draft', agent: writer },
      { name: 'review', agent: reviewer },
    ],
  })
  .distributed({
    enabled: true,
    queue: 'swarm-agent-jobs',
    timeout: 300_000,
    redis: { host: 'localhost', port: 6379, keyPrefix: 'swarm' },
    retry: { maxRetries: 2, backoff: 'exponential', initialDelay: 1000 },
    cleanupAfter: 3_600_000,
  })
  .build(cogitator);

const result = await swarm.run({ input: 'Write release notes' });
await swarm.close();
```

Worker node:

```typescript
import { Cogitator } from '@cogitator-ai/core';
import { DistributedSwarmWorker } from '@cogitator-ai/worker';

const worker = new DistributedSwarmWorker({
  redis: { host: 'localhost', port: 6379 },
  keyPrefix: 'swarm', // must match distributed.redis.keyPrefix
  queue: 'swarm-agent-jobs', // must match distributed.queue
  concurrency: 4,
  cogitator: new Cogitator({ llm: { defaultModel: 'ollama/llama3.2' } }),
  tools: [searchTool, calculatorTool], // implementations of tools the agents reference
});

await worker.start();
process.on('SIGTERM', () => void worker.stop());
```

`retry` re-dispatches jobs that fail on a worker or time out (defaults: 3 retries, exponential backoff from 1000 ms up to 30000 ms; without it nothing is re-dispatched); a timed-out job may still be running, so its turn can run twice. `cleanupAfter` expires the swarm's Redis state after `close()` (default one hour, `0` deletes it at once). `workerConcurrency` is deprecated — set `concurrency` on the worker. The swarm's `errorHandling` (retry, failover), budgets and circuit breaking work the same as for local swarms. `RedisMessageBus`, `RedisBlackboard` and `RedisSwarmEventEmitter` are exported for direct use.

---

## License

MIT
