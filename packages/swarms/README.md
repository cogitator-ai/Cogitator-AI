# @cogitator-ai/swarms

Multi-agent swarm coordination for Cogitator. Orchestrate teams of AI agents with eight collaboration strategies, automatic model selection, shared communication primitives, workflow integration and Redis-backed distributed execution.

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

Strategies equip agents with the tools they need: the hierarchical supervisor receives `delegate_task`, `check_progress`, `request_revision` and `list_workers`, consensus voters receive the voting tools, negotiating agents receive the negotiation tools, and the lead and the members of a team receive the task list and mailbox tools. `agentTools` adds the messaging and blackboard tools to every agent (see [Built-in Swarm Tools](#built-in-swarm-tools)). Tools an agent already defines with the same name are kept.

## Features

- **8 Coordination Strategies** - hierarchical, round-robin, consensus, auction, pipeline, debate, negotiation, team
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

Turns are labelled with the speaker's name and role (`[optimist (advocate)]: ...`). `synthesisPrompt` replaces the moderator's default task, with `{topic}` and `{transcript}` filled in. `maxTokensPerTurn` is the length of a turn's answer: the output limit of a model that does not reason, and the length debaters are asked to keep to. A reasoning model spends its reasoning from the same limit, so a turn it spent thinking (cut off or empty, with little visible text) is run once more with room to reason on top: `reasoningTokensPerTurn`, 4096, or twice what it reasoned. Set `reasoningTokensPerTurn` to give that room from the first try; within it the instructions, not the provider, keep the answer short. A model that does not reason keeps the limit as it is, and a turn that called tools is never run again.

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

### Team

Agent teams, in the spirit of Claude Code's agent teams: a lead plans the work as a shared task list, members claim or are assigned tasks and work through them, everyone talks through mailboxes, and the lead writes the final answer from the results. The lead is the swarm's `supervisor` (`.lead()` in the builder), the members are its `workers` (`.members()`).

```typescript
const swarm = new SwarmBuilder('newsroom')
  .strategy('team')
  .lead(new Agent({ name: 'editor', model, instructions: 'Plan the article and assign the work' }))
  .members([
    new Agent({ name: 'researcher', model, description: 'Finds facts', instructions: 'Research' }),
    new Agent({ name: 'writer', model, description: 'Writes clearly', instructions: 'Write' }),
  ])
  .team({ maxTurnsPerMember: 6, maxConcurrentMembers: 2 })
  .build(cogitator);

const result = await swarm.run({ input: 'Write an article about tides' });
console.log(result.output);
console.log(result.teamResult?.tasks); // every task with its status, owner and result
```

How a run goes:

- The lead takes the first turn and creates tasks with `create_task` (`dependsOn` makes a task wait for others, `assignee` gives it to a member) and `assign_task`. If the request needs no team, it answers at once and the run ends there (`stopReason: 'no-tasks'`).
- A task is `pending`, `in_progress` or `completed`, the statuses of `write_todos`. A pending task with unfinished dependencies cannot be claimed, completing a task unblocks the tasks that wait for it, and a member works on one task at a time.
- A member takes a turn when it has a task: one assigned to it, or with `selfClaim` the next unassigned one that is not blocked. The task is claimed for it before the turn, in one synchronous step on the blackboard, so two members never get the same task. Unassigned tasks wait while the lead is in a turn, since the lead may still assign them.
- Each agent has a mailbox. `send_message` writes to a member, to the lead (`"lead"`) or to everyone (`"everyone"`), and a message wakes its recipient. Every message is marked with the agent that sent it and comes with a notice that it is from another agent, not from the user, so a teammate's claim of approval is never taken as the user's.
- The lead gets a turn when messages reach it, and when nobody can go on with the tasks left (for example a task assigned to a member that used its turns). Once every task is completed, or no agent has a reason or a turn left, the lead writes the final answer from the task results.

| Tool           | Lead | Member | What it does                                                                     |
| -------------- | ---- | ------ | -------------------------------------------------------------------------------- |
| `create_task`  | yes  |        | Puts a task on the list, with `dependsOn`, `assignee` and an optional `id`       |
| `assign_task`  | yes  |        | Gives a pending task to a member                                                 |
| `list_tasks`   | yes  | yes    | The task list with statuses, owners, blockers and results, and what can be taken |
| `claim_task`   |      | yes    | Starts the named task, or the next one the member can take                       |
| `update_task`  | yes  | yes    | Completes a task with its result, releases it (`pending`) or adds a note         |
| `send_message` | yes  | yes    | Writes to a member, `lead` or `everyone`                                         |
| `read_inbox`   | yes  | yes    | Reads the unread messages, each marked with its sender                           |

| Option                 | Default                         | Description                                                                            |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `tasks`                | `[]`                            | Tasks on the list before the lead's first turn (`TeamTaskInput[]`)                     |
| `selfClaim`            | `true`                          | Idle members take unassigned tasks, without it only assigned tasks are worked on       |
| `maxConcurrentMembers` | `resources.maxConcurrency` or 4 | Members working at the same time                                                       |
| `maxLeadTurns`         | `6`                             | Lead turns before the final answer, its first turn included                            |
| `maxTurnsPerMember`    | `8`                             | Turns of each member, a member out of turns gives its tasks back to the list           |
| `maxTasks`             | `50`                            | Tasks the list holds                                                                   |
| `synthesize`           | `true`                          | The lead writes the final answer, without it the output is the tasks and their results |

Every turn spends one of these finite budgets, so a run always ends. `result.teamResult` holds the tasks, the state of each agent (`idle`, `working`, `stopped`, `failed`), the turns taken and the `stopReason`: `completed`, `no-tasks`, `stalled` (nobody could go on) or `turn-limit`. A member whose turn fails fails the run, unless `errorHandling` asks for `partialResults` or `onAgentFailure: 'skip'`: then it is marked failed and its tasks go back to the list. The team strategy runs in-process only, like `hierarchical` and `negotiation`.

The task list lives in the blackboard section `team` and the mailboxes on the message bus. `TeamTaskBoard` and `TeamMailbox` work on them directly, for tests or custom strategies, and the `team:*` events (see [Swarm Events](#swarm-events)) report every change, enough to draw the team live, which [Cogitator Studio](https://cogitator.app/docs/getting-started/studio) does.

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

A turn whose agent run pauses for tool approvals (`requiresApproval`) fails with an `AgentRunPausedError` from `@cogitator-ai/core`, carrying the waiting calls and the checkpoint, instead of passing the pre-tool text on as the answer. It is never retried, skipped or failed over, and does not trip the circuit breaker.

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
| `createTeamTools`        | `create_task`, `assign_task`, `list_tasks`, `claim_task`, `update_task`, `send_message`, `read_inbox` (`teamToolsFor(tools, role)` picks the lead's or a member's)        |

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

`conditionalSwarmNode(swarm, condition, options)` and `parallelSwarmsNode([{ swarm, key }], merge)` are also available. Pass a `SwarmConfig` instead of a `Swarm` to create (and close) a fresh swarm per execution. The nodes pass the workflow run's abort signal to the swarm, so a node timeout, pause or cancel stops it and its agent turns. Outside workflows, `swarm.run({ input, signal })` takes a signal the same way.

---

## Swarm Events

```typescript
swarm.on('agent:complete', (event) => console.log(event.agentName));
swarm.once('swarm:complete', () => console.log('done'));
const unsubscribe = swarm.on('*', (event) => console.log(event.type));
unsubscribe();
```

Subscriptions survive the coordinator rebuild that happens after model assessment.

| Event                                                                                                          | Description                                        |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `swarm:start` / `swarm:complete` / `swarm:error`                                                               | Run lifecycle                                      |
| `swarm:paused` / `swarm:resumed` / `swarm:aborted` / `swarm:reset`                                             | Control actions                                    |
| `agent:start` / `agent:complete` / `agent:error`                                                               | Agent turns                                        |
| `message:sent` / `message:received`                                                                            | Bus messages sent / delivered to an agent's turn   |
| `blackboard:write`                                                                                             | Section written or deleted                         |
| `assessor:complete`                                                                                            | Model assessment finished                          |
| `consensus:*`, `debate:*`, `auction:*`, `pipeline:*`, `round-robin:assigned`, `negotiation:*`                  | Strategy progress                                  |
| `team:start` / `team:complete`                                                                                 | Team run lifecycle, with the stop reason           |
| `team:member-started` / `team:member-finished`                                                                 | A turn of the lead or a member, with its reason    |
| `team:task-created` / `team:task-assigned` / `team:task-claimed` / `team:task-updated` / `team:task-completed` | Task list changes, each with the task as it is now |
| `team:message-sent`                                                                                            | A message written into mailboxes                   |

The data of each `team:*` event is typed by `TeamEventMap` from `@cogitator-ai/types`:

```typescript
import type { TeamEventMap } from '@cogitator-ai/types';

swarm.on('team:task-completed', (event) => {
  const { task, unblocked } = event.data as TeamEventMap['team:task-completed'];
  console.log(`${task.id} done by ${task.owner}, unblocks ${unblocked.join(', ')}`);
});
```

---

## Distributed Execution

With `distributed.enabled`, the swarm keeps its message bus, blackboard and events in Redis and dispatches every agent turn as a job. Worker nodes from `@cogitator-ai/worker` execute the turns and hand the results back.

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
    redis: { url: 'redis://localhost:6379', keyPrefix: 'swarm' },
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
  redis: { url: 'redis://localhost:6379' }, // the same Redis as distributed.redis
  keyPrefix: 'swarm', // must match distributed.redis.keyPrefix
  queue: 'swarm-agent-jobs', // must match distributed.queue
  concurrency: 4,
  cogitator: new Cogitator({ llm: { defaultModel: 'ollama/llama3.2' } }),
  tools: [searchTool, calculatorTool], // implementations of tools the agents reference
});

await worker.start();
process.on('SIGTERM', () => void worker.stop());
```

`retry` re-dispatches jobs that fail on a worker or time out (defaults: 3 retries, exponential backoff from 1000 ms up to 30000 ms, without it nothing is re-dispatched), a timed-out job may still be running, so its turn can run twice. `cleanupAfter` expires the swarm's Redis state after `close()` (default one hour, `0` deletes it at once). `workerConcurrency` is deprecated - set `concurrency` on the worker. The swarm's `errorHandling` (retry, failover), budgets and circuit breaking work the same as for local swarms: each turn carries the whole agent in the agent wire format of `@cogitator-ai/core` (response format, reasoning, stop sequences, timeout and the rest), and comes back with the cost, duration and flags (`truncated`, `blocked`) the worker measured. `RedisMessageBus`, `RedisBlackboard` and `RedisSwarmEventEmitter` are exported for direct use.

`distributed.redis` is a `RedisConnectionConfig` (`url`, `host`, `port`, `username`, `password`, `db`, `tls`, `cluster.nodes`) plus `keyPrefix`, the same config the worker takes. The `url` is read first (`rediss://` turns on TLS) and the explicit fields win over it. With `cluster` the swarm and its workers connect to a Redis Cluster, and the url and fields give only the credentials and TLS.

Keys carry Redis Cluster hash tags, with literal braces: the queue is `<keyPrefix>:jobs:{<queue>}` and the swarm's state keys are `<keyPrefix>:{<swarmId>}:...`, so in a cluster each group sits in one slot. Earlier versions used keys without the braces, so upgrade coordinators and workers together.

The queue is reliable. A worker moves each turn with `BLMOVE` (Redis 6.2 or newer) from the queue to its own list `<queue key>:processing:<workerId>` and takes it off once the turn is done. It keeps a heartbeat key `<queue key>:heartbeat:<workerId>` (expiring after three `heartbeatInterval`s, 5000 ms by default) and is listed in the set `<queue key>:workers`. On start and on every beat, a worker moves the turns of workers whose heartbeat is gone back to the head of the queue, so a crashed worker loses no turns. A worker also checks its own list on every beat: a turn on it that the worker does not run at two beats in a row, such as one a `BLMOVE` moved while a dropped connection lost its reply, goes back to the head of the queue and is reported with the worker's own id. A worker silent for three intervals counts as gone, so a turn on a stalled worker can run twice.

The worker keeps each result under the job's `stateKeys.result` (`<keyPrefix>:{<swarmId>}:result:<jobId>`) for `resultTtl` ms, which the coordinator sets to the larger of `timeout` and `cleanupAfter`, and then publishes it. The coordinator reads the stored result when a turn times out, when either of its connections reconnects and every few seconds, so a result published while it reconnected is not lost. A result the worker cannot keep under its key is still published. A worker skips a job whose result is already there, and the coordinator deletes the stored result before it re-dispatches a retry.

The building blocks are exported too: `swarmJobQueueKey` and `swarmQueueKeys` give the queue keys, `deliverSwarmJobResult` (with `DEFAULT_SWARM_RESULT_TTL`) hands a result back the way workers do, and `resolveRedisOptions`, `clusterNodeOptions`, `createSwarmRedis`, `duplicateSwarmRedis`, `scanSwarmKeys` and `closeSwarmRedis` turn a `RedisConnectionConfig` into ioredis clients (`SwarmRedis`, a `Redis` or `Cluster`) and work with them on both.

---

## License

MIT
