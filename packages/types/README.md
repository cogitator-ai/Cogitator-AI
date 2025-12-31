# @cogitator-ai/types

Shared TypeScript types for the Cogitator AI agent runtime.

## Installation

```bash
pnpm add @cogitator-ai/types
```

## Usage

```typescript
import type { Agent, Tool, Message, RunResult } from '@cogitator-ai/types';

const agent: Agent = {
  name: 'my-agent',
  instructions: 'You are a helpful assistant',
  model: 'ollama/llama3.2:3b',
};
```

## Types

- **Agent** - Agent configuration
- **Tool** - Tool definition with Zod schemas
- **Message** - Chat messages (user, assistant, tool)
- **RunResult** - Execution results with usage stats
- **Workflow** - DAG workflow definitions
- **Swarm** - Multi-agent swarm configurations
- **Memory** - Memory adapters and context builders

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
