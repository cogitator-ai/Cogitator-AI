# @cogitator/workflows

DAG-based workflow engine for Cogitator agents. Build complex multi-step workflows with branching, loops, and checkpoints.

## Installation

```bash
pnpm add @cogitator/workflows
```

## Usage

### Basic Workflow

```typescript
import { WorkflowBuilder, WorkflowExecutor } from '@cogitator/workflows';

const workflow = new WorkflowBuilder<{ count: number }>('counter')
  .initialState({ count: 0 })
  .addNode('increment', async (ctx) => ({
    state: { count: ctx.state.count + 1 },
  }))
  .addNode('done', async (ctx) => ({
    output: `Final count: ${ctx.state.count}`,
  }))
  .build();

const executor = new WorkflowExecutor(cogitator);
const result = await executor.execute(workflow);
```

### Conditional Branching

```typescript
const workflow = new WorkflowBuilder('approval')
  .addNode('review', reviewNode)
  .addConditional('check', (state) => state.approved, {
    after: ['review'],
  })
  .addNode('approve', approveNode, { after: ['check:true'] })
  .addNode('reject', rejectNode, { after: ['check:false'] })
  .build();
```

### Loops

```typescript
const workflow = new WorkflowBuilder('retry')
  .addNode('attempt', attemptNode)
  .addLoop('check', {
    condition: (state) => !state.success && state.attempts < 3,
    back: 'attempt',
    exit: 'done',
    after: ['attempt'],
  })
  .addNode('done', doneNode)
  .build();
```

### Checkpoints

Resume workflows from saved state:

```typescript
import { FileCheckpointStore } from '@cogitator/workflows';

const store = new FileCheckpointStore('./checkpoints');

// Save checkpoint
await executor.execute(workflow, {
  checkpointStore: store,
  checkpointInterval: 5000,
});

// Resume from checkpoint
const result = await executor.resume(checkpointId, store);
```

### Pre-built Nodes

```typescript
import { agentNode, toolNode, functionNode } from '@cogitator/workflows';

const workflow = new WorkflowBuilder('pipeline')
  .addNode('analyze', agentNode(analyzerAgent))
  .addNode('transform', toolNode('json-transform', { mapping: '...' }))
  .addNode('validate', functionNode(async (ctx) => ({ valid: true })))
  .build();
```

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
