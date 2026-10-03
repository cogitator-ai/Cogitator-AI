# SOC2 Compliance Documentation

This document maps the controls Cogitator implements to the five SOC2 Trust Service Criteria: Security, Availability, Processing Integrity, Confidentiality and Privacy. It is meant for teams that deploy Cogitator and need evidence for their own audit.

> **Note**: Cogitator is an open-source library, not a hosted service, and has not been through a SOC2 audit itself. This document describes what the framework does in code. Authentication, encryption at rest, log retention, backups, monitoring and incident response are operational controls the deploying organization owns. Each section says which side a control is on.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Security Controls](#security-controls)
3. [Availability Controls](#availability-controls)
4. [Processing Integrity Controls](#processing-integrity-controls)
5. [Confidentiality Controls](#confidentiality-controls)
6. [Privacy Controls](#privacy-controls)
7. [Audit & Logging](#audit--logging)
8. [Incident Response](#incident-response)
9. [Vendor Management](#vendor-management)
10. [Control Matrix](#control-matrix)

---

## Executive Summary

Cogitator is an open-source AI agent runtime that processes potentially sensitive data through LLM interactions. This document lists the security controls and data handling behaviour of the framework, with the file or option that implements each one, and the controls a deployment has to add.

### Scope

- **In Scope**: Cogitator core runtime, tool execution sandboxes, memory adapters, server adapters, A2A server, observability exporters
- **Out of Scope**: Third-party LLM providers (OpenAI, Anthropic, etc.), user-deployed infrastructure, custom tools developed by users

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Application                       │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│     Server adapter (Express/Fastify/Hono/Koa/Next.js/Tetsu)     │
│                  auth hook · rate limit · CORS                  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Cogitator Runtime                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Agent     │  │   Tools     │  │   Memory Adapters       │  │
│  │  Execution  │  │  Registry   │  │  (Postgres/Redis/etc)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Sandbox    │  │ Guardrails, │  │   Observability         │  │
│  │(WASM/Docker)│  │ injection,  │  │  (Langfuse/OTLP)        │  │
│  │             │  │ PII masking │  │                         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LLM Providers (External)                     │
│         OpenAI  │  Anthropic  │  Google  │  Ollama (local)      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Security Controls

### CC6.1 - Logical Access Controls

Cogitator ships **no built-in admin UI, user accounts, login, API keys or RBAC**: `packages/dashboard` is only the public website (landing page, docs, cookbook). Access control belongs in front of the server adapter that exposes your agents over HTTP, and is owned by the application that embeds Cogitator.

#### Authentication

| Control                   | Implementation                                                                                                                                                                                          | Evidence                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Adapter auth hook         | `auth` option on Express, Fastify, Hono and Koa: an async function that validates the request (token, session, mTLS identity). Throwing rejects with `401`; returning `undefined` admits it anonymously | `AuthFunction` in `packages/{express,fastify,hono,koa}/src/types.ts` |
| Tetsu auth                | `auth` returns the caller; `undefined` rejects with `401`                                                                                                                                               | `Authenticate` in `packages/tetsu/src/types.ts`                      |
| WebSocket auth            | Express and Fastify run `auth` on WebSocket upgrades; Koa's `websocket.auth` takes its own function; Hono's WebSocket route sits behind the `auth` middleware                                           | Adapter `websocket/` handlers                                        |
| Next.js handlers          | `beforeRun(req, input)` on `createAgentHandler` / `createChatHandler` / the resume handler; throwing rejects (`401` by default), the returned object (e.g. `{ userId }`) becomes run options            | `packages/next/src/types.ts`                                         |
| A2A                       | `auth: { type: 'bearer' \| 'apiKey', validate }` on `A2AServer`; `validate` returns `false` (reject), `true` (no user) or `{ userId }`                                                                  | `A2AAuthConfig` in `packages/a2a/src/types.ts`                       |
| Identity provider (yours) | Bring your own IdP, API gateway or reverse proxy (OAuth/OIDC, API keys, mTLS); Cogitator does not store credentials                                                                                     | Deployment configuration                                             |

#### Authorization

| Control            | Implementation                                                                                                                                                                               | Evidence                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Auth context       | `auth` returns `{ userId, roles, permissions, metadata }`; adapters pass `userId` to every run. `roles` and `permissions` are available to your own routes; Cogitator does not evaluate them | `AuthContext` in adapter types                                            |
| Thread ownership   | A thread belongs to the `userId` of the run that created it; another user's run or thread request fails with `THREAD_ACCESS_DENIED` (`403`). `threadAccess: 'shared'` opts out per run       | `threadAccess` in `RunOptions`, `packages/core/src/cogitator/threads.ts`  |
| A2A task isolation | Tasks and contexts are visible only to the `userId` that created them; another user's task is reported as not found                                                                          | `packages/a2a/src/server.ts`, `ownership.ts`                              |
| Tool allowlists    | `tools` on the agent config limits the tools an agent can call                                                                                                                               | `AgentConfig`                                                             |
| Tool approvals     | `requiresApproval` pauses a run until a person approves or denies the call (`cogitator.resume()` or `onApproval`)                                                                            | `ToolApprovalRequest`, `RunCheckpoint` in `packages/types/src/runtime.ts` |

#### Code Example - API Authentication

```typescript
import express from 'express';
import { CogitatorServer } from '@cogitator-ai/express';

const app = express();

const server = new CogitatorServer({
  app,
  cogitator,
  agents: { assistant },
  config: {
    basePath: '/api',
    auth: async (req) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const user = await verifyToken(token); // your IdP / API key store; throw to reject with 401
      return { userId: user.id, roles: user.roles };
    },
    rateLimit: { windowMs: 60_000, max: 100 },
  },
});

await server.init();
```

See [Server Adapters](https://cogitator.app/docs/server-adapters) and [Multiple Users](https://cogitator.app/docs/advanced/multi-user).

### CC6.2 - System Access Restrictions

#### Sandbox Isolation

Cogitator provides three levels of code execution isolation (`@cogitator-ai/sandbox`):

| Sandbox Type | Isolation Level                           | Use Case                        |
| ------------ | ----------------------------------------- | ------------------------------- |
| **WASM**     | Linear memory, no filesystem or network   | Untrusted modules               |
| **Docker**   | Container, no network and no capabilities | Shell commands, resource limits |
| **Native**   | None                                      | Development, trusted code only  |

How tools use them (`packages/core/src/cogitator/tool-executor.ts`): for a tool with `sandbox.type: 'docker'` the runtime runs the call's `command` argument with `sh -c` in the container instead of calling the tool's `execute()`; for `'wasm'` it passes the arguments to the module as JSON. Tools without `sandbox` run in the host process.

**Fallback behaviour**: when `@cogitator-ai/sandbox` is not installed, sandboxed tools run natively with a logged warning; when Docker or Extism is unavailable, the sandbox falls back WASM → Docker → native, also with a warning. Isolation is therefore not guaranteed unless the deployment checks `isDockerAvailable()` / `isWasmAvailable()` before registering such tools.

#### WASM Sandbox Security Properties

- Memory isolation via WebAssembly linear memory bounds checking
- Memory cap: `sandbox.wasm.memoryPages` (default 256 pages = 16 MB)
- No filesystem or environment access unless `wasi: true`
- No network access unless hosts are listed in `network.allowedHosts`
- Execution timeout (default 30 s); a timed-out plugin's worker thread is terminated
- Output limited to 50,000 characters per stream

#### Docker Sandbox Security Properties

```yaml
Security Controls:
  NetworkMode: 'none' # default; set via SandboxConfig.network.mode
  CapDrop: ['ALL'] # drop all capabilities
  SecurityOpt: ['no-new-privileges']
  ReadonlyRootfs: false # workspace dir is writable (/workspace)
  User: configurable # non-root via SandboxConfig.user (not set by default)
  Resources:
    Memory: '512MB' # via SandboxConfig.resources.memory (no limit by default)
    CPUs: 1 # via SandboxConfig.resources.cpus (no limit by default)
    PidsLimit: 100 # default
  Timeout: 30s # default; the container is destroyed after a timeout
```

Containers are pooled and reused across calls with identical settings, so files written by one call can be seen by a later one until the container is destroyed (idle timeout 60 s by default). See [SECURITY.md](./SECURITY.md#docker-sandbox) and [Sandbox](https://cogitator.app/docs/deployment/sandbox).

#### Input and Output Guards

| Control                    | Implementation                                                                                                                              | Default              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Prompt injection detection | `security.promptInjection`: pattern or LLM classifier on each run's input; `action: 'block'` fails the run with `PROMPT_INJECTION_DETECTED` | Off until configured |
| Guardrails                 | `guardrails`: Constitutional AI filters on input, output and tool calls, critique and revision, dangerous command and path checks for tools | Off until configured |
| PII masking                | `security.pii`: placeholders instead of personal data and secrets in requests to the model provider (`mask`, `redact`, `block`)             | Off until configured |

See [Security](https://cogitator.app/docs/advanced/security) and [Constitutional AI](https://cogitator.app/docs/advanced/constitutional-ai).

### CC6.3 - Security Event Monitoring

Cogitator emits the events; collecting, storing and alerting on them is the deployer's job. See [Audit & Logging](#audit--logging).

### CC6.6 - Encryption

#### Data in Transit

| Component            | Encryption | Configuration                                                               |
| -------------------- | ---------- | --------------------------------------------------------------------------- |
| API Endpoints        | TLS        | Terminate at your reverse proxy or load balancer; adapters serve plain HTTP |
| Database Connections | TLS        | `sslmode=require` in the Postgres connection string                         |
| Redis Connections    | TLS        | `rediss://` URL                                                             |
| LLM API Calls        | TLS        | HTTPS endpoints of the providers                                            |

#### Data at Rest

Cogitator does not encrypt stored data itself. Use the storage layer's encryption:

| Component          | Encryption                                                     | Owner    |
| ------------------ | -------------------------------------------------------------- | -------- |
| Postgres / MongoDB | Managed-service or disk encryption                             | Deployer |
| Redis              | Encrypted persistence of your Redis service, or no persistence | Deployer |
| SQLite             | Encrypted volume                                               | Deployer |
| Logs and traces    | Encryption of your log store and observability platform        | Deployer |

#### Secret Management

Provider keys are passed in `llm.providers` (or loaded by `loadConfig()` from `@cogitator-ai/config`, which reads `COGITATOR_<PROVIDER>_API_KEY` and the providers' usual variables). Inject them from a secret manager:

```typescript
import { Cogitator } from '@cogitator-ai/core';

const cogitator = new Cogitator({
  llm: {
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    },
  },
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
  },
});
```

### CC6.7 - Vulnerability Management

#### Dependency Security

| Control           | Implementation                                                    |
| ----------------- | ----------------------------------------------------------------- |
| Version pinning   | `pnpm-lock.yaml`; CI installs with `--frozen-lockfile`            |
| Security updates  | Dependabot opens weekly npm update PRs (`.github/dependabot.yml`) |
| Dependency audits | `pnpm audit`, run manually; not part of CI                        |

#### Secure Development Practices

- TypeScript strict mode (`tsconfig.json`)
- Zod validation of every tool call's arguments before the tool runs
- CI on every push and pull request to `main`: lint, format check, typecheck, build and unit tests (`.github/workflows/ci.yml`)

---

## Availability Controls

### A1.1 - System Availability Commitments

#### High Availability Architecture

Cogitator instances are stateless when memory, run checkpoints and workflow stores live in shared services, so a deployment can run several behind a load balancer. This is a reference architecture; building and operating it is the deployer's responsibility.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Load Balancer (L7)                         │
│                  Health checks: <basePath>/health               │
└─────────────────────────────────────────────────────────────────┘
                    │                    │
        ┌───────────┴───────────┐        │
        ▼                       ▼        ▼
┌──────────────┐      ┌──────────────┐  ┌──────────────┐
│  Cogitator   │      │  Cogitator   │  │  Cogitator   │
│  Instance 1  │      │  Instance 2  │  │  Instance N  │
└──────────────┘      └──────────────┘  └──────────────┘
        │                    │                │
        └────────────────────┼────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Shared State Layer                           │
│  ┌─────────────────┐              ┌─────────────────────────┐   │
│  │  PostgreSQL     │              │  Redis                  │   │
│  │  (Primary +     │              │  (Sentinel/Cluster)     │   │
│  │   Replicas)     │              │                         │   │
│  └─────────────────┘              └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

Paused runs are kept in the memory adapter's threads by default (process memory without one); pass `runCheckpoints` to share them across instances.

#### Health Check Endpoints

Express, Fastify, Hono, Koa and Tetsu adapters, under the adapter's base path:

| Endpoint  | Response                                                             |
| --------- | -------------------------------------------------------------------- |
| `/health` | `200` with `{ status: 'ok', uptime, timestamp }`                     |
| `/ready`  | `200` with `{ status: 'ok' }`; it does not check memory or providers |

In Express, Fastify, Hono and Koa both pass through the adapter's `auth` function when one is set; Tetsu's health routes skip it.

### A1.2 - Capacity Planning

#### Resource Limits Configuration

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';

const cogitator = new Cogitator({
  limits: {
    maxConcurrentRuns: 20, // further runs wait for a slot
    defaultTimeout: 120_000, // run timeout when neither run nor agent sets one
    maxTokensPerRun: 200_000, // fails the run with RUN_TOKEN_LIMIT_EXCEEDED
  },
  sandbox: {
    defaults: {
      type: 'docker',
      resources: {
        memory: '512MB',
        cpus: 1,
        pidsLimit: 100,
      },
      timeout: 30_000,
    },
  },
  context: {
    compressionThreshold: 0.8, // compress at 80% of the context window
    outputReserve: 0.15, // reserve 15% for output
  },
});

const agent = new Agent({
  name: 'my-agent',
  model: 'openai/gpt-5.5',
  instructions: '...',
  maxIterations: 10, // default 10
  maxTokens: 4096, // output token limit per LLM call
  timeout: 120_000, // run timeout
});
```

#### Auto-Scaling Metrics

Example thresholds for your platform's autoscaler; Cogitator does not scale itself:

| Metric              | Threshold | Action   |
| ------------------- | --------- | -------- |
| CPU Usage           | > 70%     | Scale up |
| Memory Usage        | > 80%     | Scale up |
| Request Latency P95 | > 5s      | Scale up |
| Queue Depth         | > 100     | Scale up |

### A1.3 - Backup and Recovery

Backups are the deployer's responsibility. See [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md) for procedures.

#### Recovery Point Objective (RPO)

Example targets:

| Data Type           | RPO        | Backup Method          |
| ------------------- | ---------- | ---------------------- |
| Agent Configuration | 0          | Version controlled     |
| Conversation Memory | 1 hour     | Database replication   |
| Application Logs    | 15 minutes | Stream to cold storage |
| Traces              | 24 hours   | Observability platform |

#### Recovery Time Objective (RTO)

Example targets:

| Scenario                | RTO         | Recovery Method                      |
| ----------------------- | ----------- | ------------------------------------ |
| Single instance failure | < 1 minute  | Auto-restart, load balancer failover |
| Database failover       | < 5 minutes | Automated replica promotion          |
| Full region failure     | < 1 hour    | Cross-region deployment              |

---

## Processing Integrity Controls

### PI1.1 - Processing Accuracy

#### Input Validation

- Server adapters reject run requests without a non-empty `input` string, or with a non-object `context` or non-string `threadId`, with `400 INVALID_INPUT` (Fastify and Tetsu through request schemas). Hono limits body size with `bodyLimit`
- Validating the content of `input` (length, format) is up to your `auth` function, middleware or `beforeRun` hook

#### Tool Argument Validation

Every tool call is parsed with the tool's Zod schema before the tool runs; a call that does not match fails with `Invalid arguments: ...` and the model sees the error.

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const searchTool = tool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(100).default(10),
  }),
  execute: async ({ query, limit }) => {
    // arguments are guaranteed to match the schema here
    return { query, limit, results: [] };
  },
});
```

### PI1.2 - Processing Completeness

#### Run Callbacks

```typescript
const result = await cogitator.run(agent, {
  input: userMessage,
  threadId,
  onToolCall: (call) => {
    logger.info('Tool call', { name: call.name, args: call.arguments });
  },
  onRunComplete: (result) => {
    logger.info('Run complete', {
      runId: result.runId,
      tokens: result.usage.totalTokens,
      toolCalls: result.toolCalls.length,
    });
  },
});
```

#### Retry Logic

LLM calls are retried by the runtime on every backend: 2 retries with exponential backoff by default, honouring `Retry-After` (`llm.retry`, `false` turns it off). For whole runs, `withRetry` wraps any async function:

```typescript
import { isRetryableError, withRetry } from '@cogitator-ai/core';

const result = await withRetry(() => cogitator.run(agent, { input }), {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential',
  retryIf: (error) => isRetryableError(error),
});
```

A run retried this way starts over: tool calls with side effects may run twice.

### PI1.3 - Processing Timeliness

#### Timeout Configuration

| Operation         | Default                                         | Configured with                                        |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Agent run         | 120 s                                           | `timeout` on the run or agent, `limits.defaultTimeout` |
| LLM request       | No separate timeout; bounded by the run timeout | Run timeout, `llm.retry`                               |
| Tool execution    | No separate timeout; bounded by the run timeout | `timeout` on the tool                                  |
| Sandbox execution | 30 s                                            | `timeout` on the tool or `SandboxConfig`               |
| Tool iterations   | 10                                              | `maxIterations` on the agent                           |

#### Streaming Support

```typescript
const result = await cogitator.run(agent, {
  input: message,
  stream: true,
  onToken: (token) => {
    process.stdout.write(token);
  },
});
```

---

## Confidentiality Controls

### C1.1 - Confidential Information Identification

#### Data Classification

Suggested classification for a deployment; Cogitator does not tag or enforce it:

| Classification   | Examples                       | Suggested Handling                                         |
| ---------------- | ------------------------------ | ---------------------------------------------------------- |
| **Public**       | Documentation, examples        | No restrictions                                            |
| **Internal**     | Agent configurations           | Access controlled                                          |
| **Confidential** | API keys, conversation content | Secret manager, encrypted storage                          |
| **Restricted**   | PII, credentials               | `security.pii` masking, encrypted storage, short retention |

### C1.2 - Confidential Information Protection

#### Keeping Personal Data from Model Providers

```typescript
const cogitator = new Cogitator({
  security: {
    pii: {
      mode: 'mask', // 'mask' | 'redact' | 'block'
      custom: [{ type: 'customer_id', pattern: /CUS-\d{6}/ }],
      onDetect: (counts) => logger.info('PII masked', counts), // counts only, never values
    },
  },
});
```

Built-in detectors: email, phone, credit card, IBAN, SSN, IP address and API keys. `mask` sends placeholders such as `[EMAIL_1]` to the provider and restores the values in answers and tool call arguments; `redact` never restores them; `block` fails a run whose input contains any with `PII_DETECTED`.

Masking applies only to requests to the model provider. Conversation memory, run results, run callbacks and observability exporters receive the original values, and the core logger does not redact. Protect those stores accordingly.

#### Data Minimization

```typescript
const cogitator = new Cogitator({
  memory: {
    adapter: 'redis',
    redis: {
      url: process.env.REDIS_URL,
      ttl: 86400, // keys expire after 24 hours
    },
  },
});
```

Memory stores the conversation messages, including tool calls and tool results. Use `useMemory: false` or `saveHistory: false` on runs that must not be persisted.

### C1.3 - Confidential Information Disposal

#### Data Retention

| Data Type                   | Framework Behaviour                         | Disposal                                     |
| --------------------------- | ------------------------------------------- | -------------------------------------------- |
| Conversation memory (Redis) | Expires after `redis.ttl` (default 86400 s) | Automatic                                    |
| Conversation memory (other) | Kept until deleted                          | `deleteThread`, `clearThread`, `deleteEntry` |
| Facts and embeddings        | Kept until deleted                          | `deleteFact`, `deleteBySource`               |
| In-memory adapter           | Process memory; lost on restart             | Automatic                                    |
| Logs and traces             | Not stored by Cogitator                     | Your log and trace platform's retention      |

---

## Privacy Controls

### P1.1 - Privacy Notice

Cogitator processes data as directed by the deploying organization. Privacy notices should be provided by the organization to their end users.

#### Data Flow Transparency

```
User Input → Cogitator → (PII masking, if configured) → LLM Provider → Response
     │                                                      │
     ▼                                                      ▼
 Memory Store                                         Provider Logs
 (Configurable)                                     (Provider Policy)
```

### P2.1 - Data Collection Consent

Data collection is controlled by the deploying organization through configuration: memory is off unless `memory.adapter` is set, and traces leave the process only through an exporter you wire to the run callbacks.

### P3.1 - Personal Information Collection

#### Configurable Data Collection

```typescript
// No memory config: conversations are not stored
const stateless = new Cogitator({});

// Skip memory for a single run
const result = await cogitator.run(agent, {
  input: message,
  useMemory: false,
});

// Ephemeral in-memory storage (cleared on restart)
const ephemeral = new Cogitator({
  memory: { adapter: 'memory' },
});
```

### P4.1 - Use of Personal Information

Personal information is only used for:

1. Providing the requested AI agent functionality
2. Maintaining conversation context (if enabled)
3. Debugging and troubleshooting (with consent)

### P6.1 - Data Subject Rights

Organizations can implement access and deletion requests with the memory adapter API. Memory calls return a `MemoryResult`; `unwrap()` returns the data or throws:

```typescript
import { unwrap } from '@cogitator-ai/memory';

const memory = await cogitator.getMemory();
if (!memory) throw new Error('Memory is not configured');

// Export a thread's conversation
const thread = unwrap(await memory.getThread(threadId));
const entries = unwrap(await memory.getEntries({ threadId }));

// Remove its messages but keep the thread
unwrap(await memory.clearThread(threadId));

// Delete the thread and all its entries
unwrap(await memory.deleteThread(threadId));
```

The adapter API has no lookup of threads by user: keep a record of each user's thread ids (the owner is in `thread.metadata.userId`). Facts and embeddings are stored separately from threads and need their own deletion (`deleteFact`, `deleteBySource`).

---

## Audit & Logging

Cogitator has **no built-in audit log**. It provides the events an audit trail is built from; storing, retaining and protecting them is the deployer's job.

### Event Sources

| Source                       | Events                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Run callbacks (`RunOptions`) | `onRunStart`, `onRunComplete`, `onRunError`, `onToolCall`, `onToolResult`, `onSpan`, `onHandoff`, `onMemoryError` |
| Tool approvals               | `onApproval` requests, paused runs (`status: 'paused'`, `pendingApprovals`)                                       |
| Prompt injection             | `security.promptInjection.onThreat`; `PromptInjectionDetector.getStats()`                                         |
| PII masking                  | `security.pii.onDetect` with counts per kind                                                                      |
| Guardrails                   | `guardrails.onViolation`; `cogitator.getGuardrails()?.getViolationLog()`                                          |
| Errors                       | `CogitatorError` codes such as `THREAD_ACCESS_DENIED`, `PROMPT_INJECTION_DETECTED`, `PII_DETECTED`                |
| Server adapters              | `401` from `auth`, `403` thread access, `429` rate limits                                                         |
| Core logger                  | Structured logs (`setLogger()`, `LOG_LEVEL`)                                                                      |

### Building an Audit Trail

```typescript
const result = await cogitator.run(agent, {
  input,
  threadId,
  userId: auth.userId,
  onRunStart: ({ runId, agentId, threadId }) =>
    audit.write({ event: 'agent.run.start', runId, agentId, threadId, userId: auth.userId }),
  onToolCall: (call) => audit.write({ event: 'tool.call', tool: call.name }),
  onRunComplete: (result) =>
    audit.write({
      event: 'agent.run.complete',
      runId: result.runId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cost: result.usage.cost,
      duration: result.usage.duration,
      tools: result.toolCalls.map((c) => c.name),
    }),
  onRunError: (error, runId) =>
    audit.write({ event: 'agent.run.error', runId, error: error.message }),
});
```

`audit.write` stands for your own sink (a database table, a log pipeline, a SIEM). Tool call arguments and run inputs can hold personal data; store them only where your retention policy allows.

### Suggested Log Categories

| Category        | Retention | Purpose                                |
| --------------- | --------- | -------------------------------------- |
| Security Events | 1 year    | Authentication, authorization failures |
| API Access      | 90 days   | All API requests                       |
| Agent Execution | 30 days   | Tool calls, LLM interactions           |
| System Events   | 30 days   | Startup, shutdown, errors              |

### Langfuse Integration

`LangfuseExporter` (needs the `langfuse` package) turns runs into Langfuse traces when you wire it to the run callbacks:

```typescript
import { createLangfuseExporter } from '@cogitator-ai/core';

const langfuse = createLangfuseExporter({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
  baseUrl: 'https://cloud.langfuse.com',
  enabled: true,
});
await langfuse.init();

let runId = '';
const result = await cogitator.run(agent, {
  input: message,
  onRunStart: (run) => {
    runId = run.runId;
    langfuse.onRunStart({ ...run, agentName: agent.name, model: agent.model });
  },
  onToolCall: (call) => langfuse.onToolCall(runId, call),
  onToolResult: (toolResult) => langfuse.onToolResult(runId, toolResult),
  onRunComplete: (runResult) => langfuse.onRunComplete(runResult),
});

await langfuse.flush();
```

`OTLPExporter` sends spans to any OpenTelemetry collector. Traces carry run inputs and outputs unmasked. See [Observability](https://cogitator.app/docs/deployment/observability).

---

## Incident Response

Incident response is an operational process of the deploying organization. A suggested structure:

### Incident Classification

| Severity          | Description               | Response Time | Examples                         |
| ----------------- | ------------------------- | ------------- | -------------------------------- |
| **P1 - Critical** | Service down, data breach | < 15 minutes  | Security breach, complete outage |
| **P2 - High**     | Major feature broken      | < 1 hour      | Agent execution failures         |
| **P3 - Medium**   | Degraded performance      | < 4 hours     | Slow response times              |
| **P4 - Low**      | Minor issues              | < 24 hours    | UI bugs, documentation errors    |

### Incident Response Procedure

#### 1. Detection

- Automated monitoring alerts
- User reports
- Security scanning

#### 2. Triage

- Assess severity and impact
- Identify affected systems
- Notify stakeholders

#### 3. Containment

- Isolate affected systems
- Block malicious actors
- Preserve evidence

#### 4. Eradication

- Remove threat
- Patch vulnerabilities
- Update configurations

#### 5. Recovery

- Restore services
- Verify functionality
- Monitor for recurrence

#### 6. Post-Incident

- Root cause analysis
- Documentation
- Process improvements

### Reporting Vulnerabilities in Cogitator

1. **Do NOT** open a public issue
2. Email: security@cogitator.dev
3. Include:
   - Description of vulnerability
   - Steps to reproduce
   - Potential impact
4. Allow 90 days for a fix before public disclosure

---

## Vendor Management

### Third-Party Dependencies

#### LLM Providers

Check each provider's current data-handling terms and attestations before sending them production data:

| Provider  | Data Handling                                     |
| --------- | ------------------------------------------------- |
| OpenAI    | API data retention policy of the provider         |
| Anthropic | API data retention policy of the provider         |
| Google AI | Enterprise data agreements of the provider        |
| Ollama    | Local execution; data does not leave your network |

#### Infrastructure Dependencies

| Dependency  | Purpose                         | Security Posture                         |
| ----------- | ------------------------------- | ---------------------------------------- |
| PostgreSQL  | Memory, workflow stores         | Self-managed or managed (RDS, Cloud SQL) |
| Redis       | Memory, queues, workflow stores | Self-managed or managed (ElastiCache)    |
| Docker      | Sandbox execution               | Container security best practices        |
| Extism/WASM | Sandbox execution               | Memory-safe execution                    |

### Dependency Security

```bash
# Audit dependencies for known vulnerabilities
pnpm audit

# Update dependencies
pnpm update
```

---

## Control Matrix

### SOC2 Trust Service Criteria Mapping

Owner: **Framework** — implemented in Cogitator's code; **Shared** — Cogitator provides the mechanism, the deployer configures or operates it; **Deployer** — outside Cogitator.

| TSC                      | Control                    | Implementation                                                        | Owner     |
| ------------------------ | -------------------------- | --------------------------------------------------------------------- | --------- |
| **Security**             |                            |                                                                       |           |
| CC6.1                    | Logical access controls    | `auth` hooks on server adapters and A2A, thread ownership by `userId` | Shared    |
| CC6.2                    | System access restrictions | WASM/Docker sandboxes, guardrails, tool approvals                     | Shared    |
| CC6.3                    | Security event monitoring  | Run callbacks and security hooks; no built-in audit store             | Shared    |
| CC6.6                    | Encryption                 | TLS to stores and providers; encryption at rest by the storage layer  | Deployer  |
| CC6.7                    | Vulnerability management   | Lockfile, Dependabot, CI checks                                       | Shared    |
| **Availability**         |                            |                                                                       |           |
| A1.1                     | System availability        | `/health`, `/ready` routes; HA deployment                             | Shared    |
| A1.2                     | Capacity planning          | `limits`, sandbox resource limits, `maxIterations`; autoscaling       | Shared    |
| A1.3                     | Backup and recovery        | Database backups, DR plan                                             | Deployer  |
| **Processing Integrity** |                            |                                                                       |           |
| PI1.1                    | Processing accuracy        | Zod validation of tool arguments, request body checks                 | Framework |
| PI1.2                    | Processing completeness    | Run callbacks, LLM retries, `withRetry`                               | Framework |
| PI1.3                    | Processing timeliness      | Run and sandbox timeouts, streaming                                   | Framework |
| **Confidentiality**      |                            |                                                                       |           |
| C1.1                     | Information classification | Data classification policy                                            | Deployer  |
| C1.2                     | Information protection     | `security.pii` masking toward providers; storage encryption           | Shared    |
| C1.3                     | Information disposal       | Redis TTL, delete APIs; log retention                                 | Shared    |
| **Privacy**              |                            |                                                                       |           |
| P1.1                     | Privacy notice             | Provided by the deployer                                              | Deployer  |
| P2.1                     | Consent                    | Memory and tracing are opt-in                                         | Shared    |
| P3.1                     | Collection                 | `memory` config, `useMemory` / `saveHistory` per run                  | Framework |
| P4.1                     | Use                        | Limited to service provision                                          | Deployer  |
| P6.1                     | Data subject rights        | Memory export/delete APIs; per-user thread index kept by deployer     | Shared    |

---

## Document Control

| Version | Date         | Author         | Changes                                                       |
| ------- | ------------ | -------------- | ------------------------------------------------------------- |
| 1.0     | January 2025 | Cogitator Team | Initial release                                               |
| 1.1     | October 2026 | Cogitator Team | Aligned controls with the current code; marked control owners |

---

## References

- [Security Model](./SECURITY.md) - Detailed security architecture
- [Disaster Recovery](./DISASTER_RECOVERY.md) - Backup and recovery procedures
- [Architecture](./ARCHITECTURE.md) - System architecture overview
- [API Documentation](./API.md) - API reference
- [Security](https://cogitator.app/docs/advanced/security), [Multiple Users](https://cogitator.app/docs/advanced/multi-user), [Tool Approvals](https://cogitator.app/docs/tools/approvals) - website guides
