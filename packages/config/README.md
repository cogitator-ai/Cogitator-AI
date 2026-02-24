# @cogitator-ai/config

Configuration loading for Cogitator. Supports YAML files, environment variables, and programmatic overrides with full Zod validation.

## Installation

```bash
pnpm add @cogitator-ai/config
```

## Quick Start

### YAML Configuration

Create `cogitator.yml` in your project root:

```yaml
llm:
  defaultProvider: openai
  defaultModel: gpt-4o
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    ollama:
      baseUrl: http://localhost:11434

memory:
  adapter: redis
  redis:
    url: redis://localhost:6379

logging:
  level: info
  format: pretty
```

### Load Configuration

```typescript
import { loadConfig, defineConfig } from '@cogitator-ai/config';

// Load from file with env vars and overrides
const config = loadConfig({
  configPath: './cogitator.yml',
  overrides: {
    logging: { level: 'debug' },
  },
});

// Or define config programmatically with type safety
const config = defineConfig({
  llm: {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
});
```

---

## Configuration Reference

### LLM Configuration

```yaml
llm:
  defaultProvider: openai # ollama | openai | anthropic | google | azure | bedrock | vllm
  defaultModel: gpt-4o
  providers:
    ollama:
      baseUrl: http://localhost:11434
    openai:
      apiKey: sk-xxx
      baseUrl: https://api.openai.com/v1 # optional, for proxies
    anthropic:
      apiKey: sk-ant-xxx
    google:
      apiKey: xxx
    azure:
      apiKey: xxx
      endpoint: https://xxx.openai.azure.com
      apiVersion: 2024-02-15-preview # optional
    bedrock:
      region: us-east-1
      accessKeyId: xxx # optional, uses AWS credentials chain
      secretAccessKey: xxx # optional
    vllm:
      baseUrl: http://localhost:8000
```

### Memory Configuration

```yaml
memory:
  adapter: postgres  # memory | redis | postgres | sqlite | mongodb | qdrant

  # In-memory (for development)
  inMemory:
    maxEntries: 1000

  # Redis
  redis:
    url: redis://localhost:6379
    # Or individual settings:
    host: localhost
    port: 6379
    password: secret
    keyPrefix: cogitator:
    ttl: 3600  # seconds
    # Cluster mode:
    cluster:
      nodes:
        - host: redis-1
          port: 6379
        - host: redis-2
          port: 6379
      scaleReads: slave  # master | slave | all

  # PostgreSQL with pgvector
  postgres:
    connectionString: postgresql://user:pass@localhost:5432/cogitator
    schema: public
    poolSize: 10

  # SQLite
  sqlite:
    path: ./data/cogitator.db
    walMode: true

  # MongoDB
  mongodb:
    uri: mongodb://localhost:27017
    database: cogitator
    collectionPrefix: cog_

  # Qdrant (vector database)
  qdrant:
    url: http://localhost:6333
    apiKey: xxx
    collection: cogitator
    dimensions: 1536

  # Embedding service for semantic search
  embedding:
    provider: openai  # openai | ollama | google
    apiKey: sk-xxx
    model: text-embedding-3-small

  # Context builder settings
  contextBuilder:
    maxTokens: 4000
    reserveTokens: 500
    strategy: recent  # recent | relevant | hybrid
    includeSystemPrompt: true
    includeFacts: true
    includeSemanticContext: true
    includeGraphContext: false
    graphContextOptions:
      maxNodes: 20
      maxDepth: 3
```

### Sandbox Configuration

```yaml
sandbox:
  defaults:
    type: docker # docker | native | wasm
    image: python:3.11-slim
    timeout: 30000
    workdir: /workspace
    user: sandbox
    resources:
      memory: 512m
      cpus: 0.5
      cpuShares: 512
      pidsLimit: 100
    network:
      mode: none # none | bridge | host
      allowedHosts:
        - api.example.com
      dns:
        - 8.8.8.8

  pool:
    maxSize: 10
    idleTimeoutMs: 60000

  docker:
    socketPath: /var/run/docker.sock
    # Or TCP:
    host: localhost
    port: 2375

  wasm:
    wasmModule: ./tools.wasm
    memoryPages: 256
    functionName: run
    wasi: true
    cacheSize: 100
```

### Reflection Configuration

```yaml
reflection:
  enabled: true
  reflectAfterToolCall: true
  reflectAfterError: true
  reflectAtEnd: true
  storeInsights: true
  maxInsightsPerAgent: 50
  minConfidenceToStore: 0.7
  useSmallModelForReflection: true
  reflectionModel: gpt-4o-mini
```

### Guardrails Configuration

```yaml
guardrails:
  enabled: true
  model: gpt-4o-mini
  filterInput: true
  filterOutput: true
  filterToolCalls: true
  filterToolResults: false
  enableCritiqueRevision: true
  maxRevisionIterations: 3
  revisionConfidenceThreshold: 0.8
  strictMode: false
  logViolations: true
  thresholds:
    violence: high
    hate: high
    sexual: medium
    self-harm: high
    illegal: high
    privacy: medium
    misinformation: medium
    manipulation: medium
```

### Cost Routing Configuration

```yaml
costRouting:
  enabled: true
  autoSelectModel: true
  preferLocal: true
  minCapabilityMatch: 0.3
  trackCosts: true
  ollamaUrl: http://localhost:11434
  budget:
    maxCostPerRun: 0.10
    maxCostPerHour: 5.00
    maxCostPerDay: 50.00
    warningThreshold: 0.8
```

### Limits Configuration

```yaml
limits:
  maxConcurrentRuns: 10
  defaultTimeout: 120000
  maxTokensPerRun: 100000
```

### Logging Configuration

```yaml
logging:
  level: info # debug | info | warn | error | silent
  format: pretty # json | pretty
  destination: console # console | file
  filePath: ./logs/cogitator.log
```

---

## Environment Variables

All configuration can be set via environment variables with `COGITATOR_` prefix:

| Variable                               | Description           |
| -------------------------------------- | --------------------- |
| `COGITATOR_LLM_DEFAULT_PROVIDER`       | Default LLM provider  |
| `COGITATOR_LLM_DEFAULT_MODEL`          | Default model         |
| `COGITATOR_OLLAMA_BASE_URL`            | Ollama base URL       |
| `COGITATOR_OLLAMA_API_KEY`             | Ollama API key        |
| `COGITATOR_OPENAI_API_KEY`             | OpenAI API key        |
| `COGITATOR_OPENAI_BASE_URL`            | OpenAI base URL       |
| `COGITATOR_ANTHROPIC_API_KEY`          | Anthropic API key     |
| `COGITATOR_GOOGLE_API_KEY`             | Google API key        |
| `COGITATOR_VLLM_BASE_URL`              | vLLM base URL         |
| `COGITATOR_AZURE_API_KEY`              | Azure OpenAI API key  |
| `COGITATOR_AZURE_ENDPOINT`             | Azure OpenAI endpoint |
| `COGITATOR_AZURE_API_VERSION`          | Azure API version     |
| `COGITATOR_BEDROCK_REGION`             | AWS Bedrock region    |
| `COGITATOR_BEDROCK_ACCESS_KEY_ID`      | AWS access key ID     |
| `COGITATOR_BEDROCK_SECRET_ACCESS_KEY`  | AWS secret access key |
| `COGITATOR_LIMITS_MAX_CONCURRENT_RUNS` | Max concurrent runs   |
| `COGITATOR_LIMITS_DEFAULT_TIMEOUT`     | Default timeout (ms)  |
| `COGITATOR_LIMITS_MAX_TOKENS_PER_RUN`  | Max tokens per run    |
| `COGITATOR_DEPLOY_TARGET`              | Deploy target         |
| `COGITATOR_DEPLOY_PORT`                | Deploy port           |
| `COGITATOR_DEPLOY_REGISTRY`            | Container registry    |

Standard provider env vars are also supported:

```bash
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
GOOGLE_API_KEY=xxx
OLLAMA_HOST=http://localhost:11434
AZURE_OPENAI_API_KEY=xxx
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
```

---

## Priority Order

Configuration is merged in this order (later overrides earlier):

1. **Defaults** (lowest priority)
2. **YAML config file** (`cogitator.yml`)
3. **Environment variables** (`COGITATOR_*`)
4. **Programmatic overrides** (highest priority)

---

## Schema Validation

All configuration is validated using Zod schemas:

```typescript
import {
  CogitatorConfigSchema,
  LLMConfigSchema,
  MemoryConfigSchema,
  ReflectionConfigSchema,
} from '@cogitator-ai/config';

// Validate raw config
const result = CogitatorConfigSchema.safeParse(rawConfig);
if (!result.success) {
  console.error('Invalid config:', result.error.issues);
}

// Type-safe config
import type { CogitatorConfigInput, CogitatorConfigOutput } from '@cogitator-ai/config';
```

### Available Schemas

| Schema                           | Description                  |
| -------------------------------- | ---------------------------- |
| `CogitatorConfigSchema`          | Full configuration           |
| `LLMConfigSchema`                | LLM providers and defaults   |
| `MemoryConfigSchema`             | Memory adapters and settings |
| `SandboxConfigSchema`            | Sandbox execution settings   |
| `ReflectionConfigSchema`         | Self-reflection settings     |
| `GuardrailConfigSchema`          | Safety guardrails            |
| `CostRoutingConfigSchema`        | Cost-aware model selection   |
| `KnowledgeGraphConfigSchema`     | Knowledge graph settings     |
| `PromptOptimizationConfigSchema` | Prompt optimization          |
| `SecurityConfigSchema`           | Security / injection config  |
| `ContextManagerConfigSchema`     | Context compression          |
| `LoggingConfigSchema`            | Logging settings             |
| `DeployConfigSchema`             | Deployment settings          |
| `DeployTargetSchema`             | Deploy target enum           |
| `DeployServerSchema`             | Server framework enum        |

---

## Examples

### Development Configuration

```yaml
# cogitator.dev.yml
llm:
  defaultProvider: ollama
  providers:
    ollama:
      baseUrl: http://localhost:11434

memory:
  adapter: memory
  inMemory:
    maxEntries: 100

logging:
  level: debug
  format: pretty

sandbox:
  defaults:
    type: native # no Docker needed
```

### Production Configuration

```yaml
# cogitator.prod.yml
llm:
  defaultProvider: openai
  defaultModel: gpt-4o
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}

memory:
  adapter: postgres
  postgres:
    connectionString: ${DATABASE_URL}
    poolSize: 20
  embedding:
    provider: openai
    apiKey: ${OPENAI_API_KEY}
  contextBuilder:
    maxTokens: 8000
    strategy: hybrid

reflection:
  enabled: true
  storeInsights: true

guardrails:
  enabled: true
  strictMode: true

costRouting:
  enabled: true
  autoSelectModel: true
  budget:
    maxCostPerDay: 100.00

logging:
  level: info
  format: json
  destination: file
  filePath: /var/log/cogitator/app.log

sandbox:
  defaults:
    type: docker
    resources:
      memory: 256m
      cpus: 0.25
  pool:
    maxSize: 20
```

---

## API Reference

### loadConfig(options)

Load configuration from file, environment, and overrides.

```typescript
interface LoadConfigOptions {
  configPath?: string; // Path to YAML file
  skipEnv?: boolean; // Skip loading from environment variables
  skipYaml?: boolean; // Skip loading from YAML file
  overrides?: CogitatorConfigInput; // Programmatic overrides
}

const config = loadConfig({
  configPath: './cogitator.yml',
  overrides: { logging: { level: 'debug' } },
});
```

### defineConfig(config)

Type-safe config definition helper.

```typescript
const config = defineConfig({
  llm: {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: 'sk-xxx' },
    },
  },
});
```

### loadYamlConfig(path?)

Load and parse YAML config file. Returns `null` if no config file found.

```typescript
import { loadYamlConfig } from '@cogitator-ai/config';

const config = loadYamlConfig('./cogitator.yml');
```

### loadEnvConfig()

Load config from environment variables.

```typescript
import { loadEnvConfig } from '@cogitator-ai/config';

const config = loadEnvConfig();
```

---

## License

MIT
