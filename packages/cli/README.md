# @cogitator-ai/cli

Command-line interface for the Cogitator AI agent runtime. Scaffold projects, manage Docker services, and run agents from the terminal.

## Installation

```bash
# Global installation (recommended)
pnpm add -g @cogitator-ai/cli

# Or use with npx
npx @cogitator-ai/cli <command>
```

## Features

- **Project Scaffolding** - Create new Cogitator projects with sensible defaults
- **Docker Services** - Start/stop Redis, PostgreSQL, and Ollama with one command
- **Agent Runner** - Run agents from the command line with streaming output
- **Interactive Mode** - Chat with agents in a REPL environment
- **Model Management** - List and pull Ollama models
- **Service Status** - Monitor running Docker services
- **Log Viewer** - View logs from all services

---

## Quick Start

```bash
# Create a new project
cogitator init my-project
cd my-project

# Start Docker services (Redis, Postgres, Ollama)
cogitator up

# Run the example agent
pnpm dev

# Or run a quick chat
cogitator run "What is the capital of France?"
```

---

## Commands

### cogitator init

Create a new Cogitator project with all necessary files.

```bash
cogitator init <name> [options]
```

| Option         | Description                            |
| -------------- | -------------------------------------- |
| `--no-install` | Skip automatic dependency installation |

**Generated Project Structure:**

```
my-project/
├── package.json         # Dependencies and scripts
├── tsconfig.json        # TypeScript configuration
├── cogitator.yml        # Cogitator configuration
├── docker-compose.yml   # Docker services
├── .gitignore           # Git ignore rules
└── src/
    └── agent.ts         # Example agent with tools
```

**Example:**

```bash
# Create project and install dependencies
cogitator init my-ai-app

# Create project without installing
cogitator init my-ai-app --no-install
```

---

### cogitator up

Start Docker services for local development.

```bash
cogitator up [options]
```

| Option         | Default | Description                        |
| -------------- | ------- | ---------------------------------- |
| `-d, --detach` | `true`  | Run services in background         |
| `--no-detach`  | -       | Run services in foreground         |
| `--pull`       | `false` | Pull latest images before starting |

**Services Started:**

| Service    | Port  | Description                       |
| ---------- | ----- | --------------------------------- |
| Redis      | 6379  | In-memory cache and queue backend |
| PostgreSQL | 5432  | Vector database with pgvector     |
| Ollama     | 11434 | Local LLM inference server        |

**Connection Strings:**

```
Redis:    redis://localhost:6379
Postgres: postgresql://cogitator:cogitator@localhost:5432/cogitator
Ollama:   http://localhost:11434
```

**Examples:**

```bash
# Start in background (default)
cogitator up

# Pull latest images and start
cogitator up --pull

# Run in foreground (see all logs)
cogitator up --no-detach
```

---

### cogitator down

Stop Docker services.

```bash
cogitator down [options]
```

| Option          | Description                       |
| --------------- | --------------------------------- |
| `-v, --volumes` | Remove volumes (deletes all data) |

**Examples:**

```bash
# Stop services (keep data)
cogitator down

# Stop services and delete all data
cogitator down --volumes
```

---

### cogitator run

Run an agent with a message or start interactive mode.

```bash
cogitator run [message] [options]
```

| Option                | Default         | Description                             |
| --------------------- | --------------- | --------------------------------------- |
| `-c, --config <path>` | `cogitator.yml` | Config file path                        |
| `-m, --model <model>` | auto-detect     | Model to use (e.g., `ollama/gemma3:4b`) |
| `-i, --interactive`   | `false`         | Force interactive mode                  |
| `-s, --stream`        | `true`          | Stream response tokens                  |
| `--no-stream`         | -               | Disable streaming                       |

**Model Auto-Detection:**

If no model is specified, the CLI will:

1. Check `COGITATOR_MODEL` environment variable
2. Query Ollama for available models
3. Select from preferred models: llama3.1:8b, llama3:8b, gemma3:4b, gemma2:9b, mistral:7b
4. Fall back to first available model

**Examples:**

```bash
# Single message with auto-detected model
cogitator run "Explain quantum computing in simple terms"

# Specify a model
cogitator run -m ollama/gemma3:4b "Write a haiku about AI"

# Use OpenAI
cogitator run -m openai/gpt-4o "Analyze this code..."

# Disable streaming
cogitator run --no-stream "Hello"

# Interactive mode (starts automatically if no message)
cogitator run
cogitator run -i
```

---

### Interactive Mode

When running without a message or with `-i`, you enter interactive mode:

```
   ___            _ _        _
  / __\___   __ _(_) |_ __ _| |_ ___  _ __
 / /  / _ \ / _` | | __/ _` | __/ _ \| '__|
/ /__| (_) | (_| | | || (_| | || (_) | |
\____/\___/ \__, |_|\__\__,_|\__\___/|_|
            |___/

  AI Agent Runtime v0.1.0

Model: llama3.1:8b
Commands: /model <name>, /clear, /help, exit

> Hello!
→ Hi there! How can I help you today?

[1] > What's 2 + 2?
→ 2 + 2 equals 4.

[2] >
```

**Interactive Commands:**

| Command          | Description                               |
| ---------------- | ----------------------------------------- |
| `/model [name]`  | Show current model or switch to a new one |
| `/clear`         | Clear conversation history (start fresh)  |
| `/help`          | Show available commands                   |
| `exit` or `quit` | Exit interactive mode                     |

**Examples:**

```
> /model
Current model: ollama/llama3.1:8b

> /model gemma3:4b
✓ Switched to model: ollama/gemma3:4b

> /clear
Conversation cleared

> exit
Goodbye!
```

---

### cogitator status

Show status of all Cogitator services.

```bash
cogitator status
# or
cogitator ps
```

**Output Example:**

```
ℹ Cogitator Services Status

  Docker Compose Services:

  ● my-project-redis-1      running  Up 2 minutes
  ● my-project-postgres-1   running  Up 2 minutes
  ● my-project-ollama-1     running  Up 2 minutes

  External Services:

  ● Ollama               running  localhost:11434
```

---

### cogitator logs

View logs from Docker services.

```bash
cogitator logs [service] [options]
```

| Option               | Default | Description                        |
| -------------------- | ------- | ---------------------------------- |
| `-f, --follow`       | `false` | Follow log output (like `tail -f`) |
| `-n, --tail <lines>` | `100`   | Number of lines to show            |
| `-t, --timestamps`   | `false` | Show timestamps                    |

**Available Services:**

- `redis` - Redis cache/queue logs
- `postgres` - PostgreSQL database logs
- `ollama` - Ollama LLM server logs

**Examples:**

```bash
# View last 100 lines from all services
cogitator logs

# Follow logs in real-time
cogitator logs -f

# View only Ollama logs
cogitator logs ollama

# Follow Ollama logs with timestamps
cogitator logs ollama -f -t

# Show last 50 lines
cogitator logs -n 50
```

---

### cogitator models

List and manage Ollama models.

```bash
cogitator models [options]
```

| Option           | Description                       |
| ---------------- | --------------------------------- |
| `--pull <model>` | Pull a model from Ollama registry |

**Output Example:**

```
✓ Found 3 model(s)

  llama3.1:8b               4.7 GB  2 days ago
  gemma3:4b                 2.8 GB  1 week ago
  mistral:7b                4.1 GB  3 weeks ago

Use with: cogitator run -m ollama/<model> "message"
```

**Examples:**

```bash
# List installed models
cogitator models

# Pull a new model
cogitator models --pull llama3.1:8b
cogitator models --pull gemma3:4b
cogitator models --pull mistral:7b
```

---

## Configuration

### cogitator.yml

The main configuration file for your Cogitator project:

```yaml
# cogitator.yml

llm:
  defaultProvider: ollama
  providers:
    ollama:
      baseUrl: http://localhost:11434
    openai:
      apiKey: ${OPENAI_API_KEY}

memory:
  adapter: memory
  # Or use Redis:
  # adapter: redis
  # redis:
  #   url: redis://localhost:6379
```

### Environment Variables

| Variable            | Description                                    |
| ------------------- | ---------------------------------------------- |
| `COGITATOR_CONFIG`  | Path to config file (overrides auto-detection) |
| `COGITATOR_MODEL`   | Default model to use                           |
| `OPENAI_API_KEY`    | OpenAI API key                                 |
| `ANTHROPIC_API_KEY` | Anthropic API key                              |

**Example .env:**

```bash
COGITATOR_MODEL=ollama/llama3.1:8b
OPENAI_API_KEY=sk-...
```

---

## Project Templates

### Basic Agent (Generated by `init`)

```typescript
// src/agent.ts
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const greet = tool({
  name: 'greet',
  description: 'Greet someone by name',
  parameters: z.object({
    name: z.string().describe('Name to greet'),
  }),
  execute: async ({ name }) => `Hello, ${name}! 👋`,
});

const agent = new Agent({
  id: 'my-agent',
  name: 'My Agent',
  model: 'ollama/llama3.1:8b',
  instructions: 'You are a helpful assistant. Use the greet tool when asked to greet someone.',
  tools: [greet],
});

const cog = new Cogitator();

const result = await cog.run(agent, {
  input: 'Hello! Can you greet Alex?',
});

console.log('Agent:', result.output);

await cog.close();
```

### Agent with Multiple Tools

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Perform mathematical calculations',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async ({ expression }) => {
    const result = Function(`return ${expression}`)();
    return String(result);
  },
});

const datetime = tool({
  name: 'datetime',
  description: 'Get current date and time',
  parameters: z.object({}),
  execute: async () => new Date().toISOString(),
});

const agent = new Agent({
  name: 'Assistant',
  model: 'ollama/llama3.1:8b',
  instructions: 'You are a helpful assistant with calculator and datetime tools.',
  tools: [calculator, datetime],
});

const cog = new Cogitator();
const result = await cog.run(agent, {
  input: 'What is 15 * 23 + 42? Also, what time is it?',
});

console.log(result.output);
await cog.close();
```

---

## Docker Compose

The generated `docker-compose.yml`:

```yaml
name: my-project

services:
  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    volumes:
      - redis-data:/data

  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - '5432:5432'
    environment:
      POSTGRES_USER: cogitator
      POSTGRES_PASSWORD: cogitator
      POSTGRES_DB: cogitator
    volumes:
      - postgres-data:/var/lib/postgresql/data

  ollama:
    image: ollama/ollama:latest
    ports:
      - '11434:11434'
    volumes:
      - ollama-data:/root/.ollama

volumes:
  redis-data:
  postgres-data:
  ollama-data:
```

---

## Troubleshooting

### Ollama Not Running

```
✗ Cannot connect to Ollama
Start Ollama with: ollama serve
```

**Solutions:**

1. Start Ollama: `ollama serve`
2. Or use Docker: `cogitator up`
3. Install Ollama: https://ollama.ai

### No Models Found

```
⚠ No models installed
Pull a model with: cogitator models --pull llama3.1:8b
```

**Solution:**

```bash
cogitator models --pull llama3.1:8b
# or
ollama pull llama3.1:8b
```

### Docker Not Running

```
✗ Docker is not installed or not running
Install Docker: https://docs.docker.com/get-docker/
```

**Solutions:**

1. Start Docker Desktop
2. Or: `sudo systemctl start docker`

### Config File Not Found

```
No config file found
```

The CLI searches for config in this order:

1. `COGITATOR_CONFIG` environment variable
2. `-c` option value
3. `cogitator.yml` in current directory
4. `cogitator.yaml` in current directory
5. `cogitator.json` in current directory

---

## NPM Scripts

After `cogitator init`, these scripts are available:

```bash
# Run agent in watch mode (auto-reload on changes)
pnpm dev

# Run agent once
pnpm start

# Build TypeScript
pnpm build
```

---

## License

MIT
