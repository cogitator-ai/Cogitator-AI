# @cogitator-ai/openai-compat

OpenAI Assistants API compatibility layer for Cogitator. Use OpenAI SDK clients with Cogitator backend.

## Installation

```bash
pnpm add @cogitator-ai/openai-compat
```

## Usage

### Start the Server

```typescript
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import { Cogitator } from '@cogitator-ai/core';

const cogitator = new Cogitator();
const server = createOpenAIServer(cogitator, {
  port: 3001,
  apiKey: 'your-api-key', // Optional auth
});

await server.start();
```

### Use with OpenAI SDK

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3001/v1',
  apiKey: 'your-api-key',
});

// Create an assistant
const assistant = await openai.beta.assistants.create({
  name: 'My Assistant',
  instructions: 'You are a helpful assistant',
  model: 'ollama/llama3.2:3b',
});

// Create a thread
const thread = await openai.beta.threads.create();

// Add a message
await openai.beta.threads.messages.create(thread.id, {
  role: 'user',
  content: 'Hello!',
});

// Run the assistant
const run = await openai.beta.threads.runs.create(thread.id, {
  assistant_id: assistant.id,
});
```

### Supported Endpoints

- `POST /v1/assistants` - Create assistant
- `GET /v1/assistants` - List assistants
- `DELETE /v1/assistants/:id` - Delete assistant
- `POST /v1/threads` - Create thread
- `GET /v1/threads/:id` - Get thread
- `POST /v1/threads/:id/messages` - Add message
- `GET /v1/threads/:id/messages` - List messages
- `POST /v1/threads/:id/runs` - Create run
- `GET /v1/threads/:id/runs/:id` - Get run status

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
