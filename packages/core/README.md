# @cogitator/core

Core runtime for Cogitator AI agents. Build and run LLM-powered agents with tool calling, streaming, and multi-provider support.

## Installation

```bash
pnpm add @cogitator/core
```

## Quick Start

```typescript
import { Cogitator, Agent, tool } from '@cogitator/core';
import { z } from 'zod';

// Create a tool
const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string(),
  }),
  execute: async ({ expression }) => {
    return { result: eval(expression) };
  },
});

// Create an agent
const agent = new Agent({
  name: 'math-assistant',
  instructions: 'You are a helpful math assistant',
  model: 'ollama/llama3.2:3b',
  tools: [calculator],
});

// Run the agent
const cog = new Cogitator();
const result = await cog.run(agent, {
  input: 'What is 25 * 4?',
});

console.log(result.output);
```

## Features

- Multiple LLM backends (Ollama, OpenAI, Anthropic, Google)
- Type-safe tool definitions with Zod
- Streaming responses
- Memory integration
- Built-in tools (calculator, datetime, filesystem, HTTP, etc.)

## LLM Backends

```typescript
// Ollama (default)
const cog = new Cogitator({ defaultModel: 'ollama/llama3.2:3b' });

// OpenAI
const cog = new Cogitator({ defaultModel: 'openai/gpt-4o' });

// Anthropic
const cog = new Cogitator({ defaultModel: 'anthropic/claude-sonnet-4-20250514' });

// Google
const cog = new Cogitator({ defaultModel: 'google/gemini-1.5-flash' });
```

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
