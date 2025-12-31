# @cogitator/swarms

Multi-agent swarm coordination for Cogitator. Orchestrate teams of AI agents with various collaboration strategies.

## Installation

```bash
pnpm add @cogitator/swarms
```

## Usage

### Hierarchical Swarm

Supervisor delegates tasks to workers:

```typescript
import { Swarm, SwarmBuilder } from '@cogitator/swarms';

const swarm = new SwarmBuilder('dev-team')
  .strategy('hierarchical')
  .supervisor(techLeadAgent)
  .workers([coderAgent, testerAgent, reviewerAgent])
  .build();

const result = await swarm.run(cogitator, {
  input: 'Build a REST API for user management',
});
```

### Debate Swarm

Multiple perspectives with synthesis:

```typescript
const swarm = new SwarmBuilder('analysis-team')
  .strategy('debate')
  .agents([optimistAgent, skepticAgent, pragmatistAgent])
  .config({
    rounds: 3,
    moderator: moderatorAgent,
  })
  .build();
```

### Pipeline Swarm

Sequential processing stages:

```typescript
const swarm = new SwarmBuilder('content-pipeline')
  .strategy('pipeline')
  .stages([
    { agent: ideationAgent, name: 'ideation' },
    { agent: writerAgent, name: 'writing' },
    { agent: editorAgent, name: 'editing' },
  ])
  .build();
```

### Communication

Agents can communicate via message bus and shared blackboard:

```typescript
const swarm = new SwarmBuilder('research-team')
  .strategy('hierarchical')
  .supervisor(supervisorAgent)
  .workers([researcher1, researcher2])
  .blackboard({ enabled: true, sections: { findings: [] } })
  .messageBus({ enabled: true })
  .build();
```

### Available Strategies

- **hierarchical** - Supervisor-worker delegation
- **round-robin** - Load-balanced rotation
- **consensus** - Voting-based decisions
- **pipeline** - Sequential stages
- **debate** - Advocate vs critic with synthesis
- **auction** - Bidding for task assignment

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
