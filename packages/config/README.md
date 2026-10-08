# @cogitator-ai/config

Configuration loading for Cogitator. Supports YAML files, environment variables, and programmatic overrides with full Zod validation.

## Installation

```bash
pnpm add @cogitator-ai/config
```

See also [Configuration](https://cogitator.app/docs/getting-started/configuration) on the website.

## Quick Start

### YAML Configuration

Create `cogitator.yml` in your project root. Without an explicit `configPath`, `loadConfig()` looks in the current directory for `cogitator.yaml`, `cogitator.yml`, `.cogitator.yaml` and `.cogitator.yml`, in that order:

```yaml
llm:
  defaultProvider: openai
  defaultModel: gpt-6.1-sol
  providers:
    openai:
      apiKey: sk-xxx
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
const programmatic = defineConfig({
  llm: {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
});
```

Both validate the result and throw `Invalid configuration: …` with every Zod issue when it does not fit the schema. The result is a `CogitatorConfig`, ready for the runtime. Options that hold functions or objects (stores, callbacks such as `security.pii.onDetect`, `llm.backends`, `prompts.versions` / `prompts.abTests` / `prompts.score`, `runCheckpoints`) cannot come from YAML; add them in code:

```typescript
import { Cogitator } from '@cogitator-ai/core';
import { loadConfig } from '@cogitator-ai/config';

const config = loadConfig();
const cog = new Cogitator({
  ...config,
  prompts: { ...config.prompts, score: (result) => (result.output.length > 0 ? 1 : 0) },
});
```

`prompts.autoDeployWinner` can come from YAML (`prompts: { autoDeployWinner: true }`).

---

## Configuration Reference

### LLM Configuration

```yaml
llm:
  defaultProvider: openai # ollama | openai | anthropic | google | azure | bedrock | vllm | mistral | groq | together | deepseek
  defaultModel: gpt-6.1-sol
  providers:
    ollama:
      baseUrl: http://localhost:11434
    openai:
      apiKey: sk-xxx
      baseUrl: https://api.openai.com/v1 # optional, for proxies
      api: responses # optional: responses (default for api.openai.com) | chat-completions
    anthropic:
      apiKey: sk-ant-xxx
    google:
      apiKey: xxx
    azure:
      apiKey: xxx
      endpoint: https://xxx.openai.azure.com
      apiVersion: 2025-04-01-preview # optional, the default
      deployment: gpt-6.1-sol # optional
      model: gpt-5 # optional: the model the deployments serve, when their names do not say
    bedrock:
      region: us-east-1 # optional, can use AWS config chain
      accessKeyId: xxx # optional, uses AWS credentials chain
      secretAccessKey: xxx # optional
    vllm:
      baseUrl: http://localhost:8000
    mistral:
      apiKey: xxx
    groq:
      apiKey: xxx
    together:
      apiKey: xxx
    deepseek:
      apiKey: xxx
  retry: # or `false`; default: 2 retries with exponential backoff
    maxRetries: 3
    baseDelay: 1000
    maxDelay: 30000
    maxRetryAfter: 60000
    requestTimeout: 180000 # ms one call may take before it is aborted and retried, off by default
  promptCache: # or `false`; on by default
    ttl: 1h # 5m | 1h (Anthropic)
  plugins: # settings for backend plugins registered with registerLLMBackend, by provider name
    my-provider:
      endpoint: http://localhost:9000
```

### Memory Configuration

```yaml
memory:
  adapter: postgres # thread store: memory | redis | postgres | sqlite | mongodb

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
    keyPrefix: 'cogitator:'
    ttl: 3600 # seconds
    # Cluster mode:
    cluster:
      nodes:
        - host: redis-1
          port: 6379
        - host: redis-2
          port: 6379
      scaleReads: slave # master | slave | all

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

  # Qdrant: embedding store searched by contextBuilder, next to the thread store
  qdrant:
    url: http://localhost:6333
    apiKey: xxx
    collection: cogitator
    dimensions: 1536

  # Embedding service for semantic search
  embedding:
    provider: openai # openai | ollama | google (apiKey required for openai and google)
    apiKey: sk-xxx
    model: text-embedding-3-small
    baseUrl: https://api.openai.com/v1 # optional, for every provider
    dimensions: 1536 # optional output size (e.g. text-embedding-3-*)

  # Context builder settings
  contextBuilder:
    maxTokens: 4000
    reserveTokens: 500
    strategy: recent # recent | relevant | hybrid
    includeSystemPrompt: true
    includeFacts: true
    includeSemanticContext: true
    includeGraphContext: false
    graphContextOptions:
      maxNodes: 20
      maxEdges: 50
      maxDepth: 3
      includeInferred: true
      entityTypes: [person, organization] # person | organization | location | concept | event | object | custom
```

The `Cogitator` runtime builds the store `adapter` names from its section: `redis` needs `url`, `host`/`port` or `cluster`, `postgres` needs `connectionString`, `sqlite` needs `path` and `mongodb` needs `uri`. A Postgres store sizes its vector column to `embedding`. `qdrant` is not a thread store: keep one of the others as `adapter`, and with `contextBuilder` (`includeSemanticContext: true`) the runtime searches `memory.qdrant` for semantic context.

### Sandbox Configuration

```yaml
sandbox:
  defaults:
    type: docker # docker | native | wasm
    image: python:3.11-slim
    timeout: 30000
    workdir: /workspace
    user: sandbox
    env:
      PYTHONUNBUFFERED: '1'
    mounts:
      - source: /srv/data
        target: /workspace/data
        readOnly: true
    # wasmModule / wasmFunction / wasi: defaults for wasm tools
    resources:
      memory: 512m
      cpus: 0.5
      cpuShares: 512
      pidsLimit: 100
    network:
      mode: none # none | bridge | host
      # allowedHosts: [api.example.com]  # wasm only; the docker executor rejects it
      dns:
        - 8.8.8.8

  pool:
    maxSize: 10
    idleTimeoutMs: 60000
    reuseContainers: false # true: reuse containers between executions with the same settings

  # false: fail Docker-sandboxed tools when Docker is unavailable instead of running them on the host
  allowNativeFallback: true

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

`sandbox.allowNativeFallback` defaults to `true`: Docker-sandboxed tools run unsandboxed on the host when Docker is unavailable, with a warning. `sandbox.pool.reuseContainers` defaults to `false`: every execution gets a fresh container; `true` is faster but lets files and processes left by one execution reach the next.

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
  reflectionModel: gpt-6-luna
```

### Guardrails Configuration

```yaml
guardrails:
  enabled: true
  model: gpt-6-luna
  filterInput: true
  filterOutput: true
  filterToolCalls: true
  filterToolResults: false
  enableCritiqueRevision: true
  maxRevisionIterations: 3
  revisionConfidenceThreshold: 0.8
  strictMode: false
  logViolations: true
  constitution: # optional: your own principles instead of the default constitution
    id: support
    name: Support desk
    version: 1.0.0
    customizable: true
    strictMode: false
    principles:
      - id: no-refund-promises
        name: No refund promises
        description: Never promise refunds the policy does not allow
        category: custom # ethics | safety | privacy | legal | custom
        critiquePrompt: Does the reply promise a refund?
        revisionPrompt: Rewrite the reply without promising a refund.
        severity: medium
        appliesTo: [output] # input | output | tool
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

### Security Configuration

```yaml
security:
  promptInjection:
    detectInjection: true
    detectJailbreak: true
    detectRoleplay: true
    detectEncoding: true
    detectContextManipulation: true
    patterns: # your own regular expression sources, compiled to RegExp
      - 'reveal (the|your) system prompt'
    classifier: local # local | llm
    llmModel: openai/gpt-6-luna # for classifier: llm
    action: block # block | warn | log
    threshold: 0.7
    failMode: secure # when the classifier throws: secure (default) fails the check, open lets the input through
    allowlist:
      - ignore the previous search
  pii:
    mode: mask # mask | redact | block
    detect: [email, phone, credit_card, iban, ssn, ip_address, api_key]
    custom:
      - type: customer_id
        pattern: 'CUS-\d{6}' # a regular expression source, compiled to a RegExp
```

### Context Configuration

```yaml
context:
  enabled: true
  strategy: hybrid # truncate | sliding-window | summarize | hybrid
  compressionThreshold: 0.8
  outputReserve: 0.15
  summaryModel: openai/gpt-6-luna
  windowSize: 10
```

### Deploy Configuration

Read by `@cogitator-ai/deploy` and `cogitator deploy`:

```yaml
deploy:
  target: fly # docker | fly
  server: express # express | fastify | hono | koa
  port: 3000
  registry: registry.fly.io
  image: my-agents
  region: ams
  instances: 2
  services:
    redis: true
    postgres: false
  env:
    NODE_ENV: production
  secrets: [OPENAI_API_KEY]
  health:
    path: /cogitator/health
    interval: 30s
    timeout: 5s
  resources:
    memory: 512mb
    cpu: 1
```

### Limits Configuration

```yaml
limits:
  maxConcurrentRuns: 10 # runs over the limit wait in order
  defaultTimeout: 120000 # ms, for runs and agents that set no timeout
  maxTokensPerRun: 100000 # checked before each model call
```

### Logging Configuration

```yaml
logging:
  level: info # debug | info | warn | error | silent
  format: pretty # json | pretty
  destination: console # console | file
  filePath: ./logs/cogitator.log
```

A `Cogitator` created with `logging` installs it as the process-wide logger (the last such runtime wins). `destination: file` appends one line per entry to `filePath`, as JSON unless `format` is set; without `filePath`, or on runtimes without a file system, it logs to the console. `createLoggerFromConfig()` from `@cogitator-ai/core` builds the same logger in code.

---

## Environment Variables

Supported provider, limits, and deploy settings can be set via environment variables with the `COGITATOR_` prefix:

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
| `COGITATOR_AZURE_DEPLOYMENT`           | Azure deployment name |
| `COGITATOR_BEDROCK_REGION`             | AWS Bedrock region    |
| `COGITATOR_BEDROCK_ACCESS_KEY_ID`      | AWS access key ID     |
| `COGITATOR_BEDROCK_SECRET_ACCESS_KEY`  | AWS secret access key |
| `COGITATOR_BEDROCK_SESSION_TOKEN`      | AWS session token     |
| `COGITATOR_BEDROCK_PROFILE`            | AWS named profile     |
| `COGITATOR_MISTRAL_API_KEY`            | Mistral API key       |
| `COGITATOR_GROQ_API_KEY`               | Groq API key          |
| `COGITATOR_TOGETHER_API_KEY`           | Together API key      |
| `COGITATOR_DEEPSEEK_API_KEY`           | DeepSeek API key      |
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
GOOGLE_API_KEY=xxx            # or GEMINI_API_KEY
OLLAMA_URL=http://localhost:11434   # or OLLAMA_BASE_URL / OLLAMA_HOST, see below
OLLAMA_API_KEY=xxx            # Ollama Cloud / authenticated Ollama
AZURE_OPENAI_API_KEY=xxx
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-6.1-sol
AWS_REGION=us-east-1          # Bedrock region, credentials come from the AWS SDK chain
MISTRAL_API_KEY=xxx
GROQ_API_KEY=xxx
TOGETHER_API_KEY=xxx
DEEPSEEK_API_KEY=xxx
```

When `OLLAMA_API_KEY` is set without any Ollama URL (from env or YAML), the Ollama base URL defaults to `https://ollama.com`; otherwise it defaults to `http://localhost:11434`. An API key in the environment never replaces a `baseUrl` configured in YAML.

`OLLAMA_BASE_URL`, `OLLAMA_URL` and `OLLAMA_HOST` (first one set wins) are read the way Ollama reads `OLLAMA_HOST`: `gpu-box` and `0.0.0.0` mean port 11434, a wildcard address such as `0.0.0.0` is reached as `localhost`, and `http://` or `https://` keep the scheme's own port. Other tools set these variables too (`OLLAMA_HOST=0.0.0.0` makes `ollama serve` listen on every interface), so they only apply when cogitator.yml has no `llm.providers.ollama.baseUrl`. `COGITATOR_OLLAMA_BASE_URL` overrides the YAML value like every `COGITATOR_` variable. `loadEnvDefaults()` returns this layer and `resolveOllamaHost(value)` parses a single value.

Bedrock credentials stay with the AWS SDK: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, SSO and instance roles all work as the SDK resolves them, so temporary credentials keep their session token. Static credentials only come from `COGITATOR_BEDROCK_*` or `llm.providers.bedrock` in YAML (`accessKeyId`, `secretAccessKey`, `sessionToken`, `profile`).

`PROVIDER_ENV` lists every variable of every built-in provider (what `loadConfig` reads, what the provider SDK reads and what a provider cannot run without). `cogitator deploy` uses the same table to decide which secrets a deployment needs.

Without `configPath`, `loadConfig` reads the first of `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml` and `.cogitator.yaml` in the working directory. `findConfigFile(dir)` finds it the same way.

### `${VAR}` References in YAML

String values in YAML files can reference environment variables:

```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      baseUrl: ${OPENAI_BASE_URL:-https://api.openai.com/v1}
```

| Syntax            | Result                                        |
| ----------------- | --------------------------------------------- |
| `${VAR}`          | Value of `VAR`, or an empty string when unset |
| `${VAR:-default}` | `default` when `VAR` is unset **or empty**    |
| `${VAR-default}`  | `default` only when `VAR` is unset            |
| `$$`              | A literal `$`                                 |

Substituted values are always strings, so use references for string fields (keys, URLs, model names) — numeric fields such as `deploy.port` must stay literal.

---

## Priority Order

Configuration is deep-merged in this order (later overrides earlier):

1. **YAML config file** (`cogitator.yml`; lowest priority)
2. **Environment variables** (`COGITATOR_*` and the standard provider variables)
3. **Programmatic overrides** (highest priority)

Fields nobody sets stay unset, and the runtime applies its own defaults. The one default the schema fills in is the Ollama `baseUrl` (see above). Unknown top-level keys are dropped by validation.

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

| Schema                           | Description                            |
| -------------------------------- | -------------------------------------- |
| `CogitatorConfigSchema`          | Full configuration                     |
| `LLMConfigSchema`                | LLM providers and defaults             |
| `MemoryConfigSchema`             | Memory adapters and settings           |
| `SandboxConfigSchema`            | Sandbox execution settings             |
| `ReflectionConfigSchema`         | Self-reflection settings               |
| `GuardrailConfigSchema`          | Safety guardrails                      |
| `ConstitutionSchema`             | `guardrails.constitution` principles   |
| `CostRoutingConfigSchema`        | Cost-aware model selection             |
| `KnowledgeGraphConfigSchema`     | Knowledge graph settings               |
| `PromptOptimizationConfigSchema` | Prompt optimization                    |
| `SecurityConfigSchema`           | Prompt injection and PII masking       |
| `ContextManagerConfigSchema`     | Context compression                    |
| `LoggingConfigSchema`            | Logging settings                       |
| `DeployConfigSchema`             | Deployment settings                    |
| `DeployTargetSchema`             | Deploy target enum (`docker` \| `fly`) |
| `DeployServerSchema`             | Server framework enum                  |
| `LLMRetryConfigSchema`           | `llm.retry` (`false` or retry options) |
| `PromptsConfigSchema`            | `prompts` (`autoDeployWinner`)         |

`KnowledgeGraphConfigSchema` and `PromptOptimizationConfigSchema` validate those configs on their own; they are not keys of `CogitatorConfigSchema`.

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
  defaultModel: gpt-6.1-sol
  providers:
    openai:
      apiKey: sk-prod-openai
    anthropic:
      apiKey: sk-ant-prod

memory:
  adapter: postgres
  postgres:
    connectionString: postgresql://user:pass@db.example.com:5432/cogitator
    poolSize: 20
  embedding:
    provider: openai
    apiKey: sk-prod-openai
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

Load and parse a YAML config file and resolve `${VAR}` references. Without a path it searches the default file names; a path that does not exist throws `Config file not found`. Returns `null` if no config file is found or the file is empty; throws when the file cannot be parsed (the message includes the path) or its top level is not a mapping. The result is not validated yet (`loadConfig` does that).

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

### interpolateEnv(value, env?) / interpolateEnvString(value, env?)

Apply `${VAR}` substitution to a parsed config object or a single string (used by `loadYamlConfig`).

```typescript
import { interpolateEnvString } from '@cogitator-ai/config';

interpolateEnvString('${HOST:-localhost}:${PORT}', { PORT: '8080' }); // 'localhost:8080'
```

### parseDotenv(content) / loadDotenvFile(path)

Parse `.env` files (`KEY=VALUE`, `export` prefix, single/double quotes with escapes, inline comments). `loadDotenvFile` returns `{}` when the file does not exist. Neither function mutates `process.env`.

```typescript
import { loadDotenvFile } from '@cogitator-ai/config';

const env = { ...loadDotenvFile('.env'), ...process.env };
```

---

## License

MIT
