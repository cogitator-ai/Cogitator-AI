# Security Model

This document describes the security controls Cogitator implements, the threats they address, and what you have to add yourself when you deploy it. The website covers each control in more depth: [Security](https://cogitator.app/docs/advanced/security), [Sandbox](https://cogitator.app/docs/deployment/sandbox), [Constitutional AI](https://cogitator.app/docs/advanced/constitutional-ai), [Tool Approvals](https://cogitator.app/docs/tools/approvals), [Multiple Users](https://cogitator.app/docs/advanced/multi-user), [Server Adapters](https://cogitator.app/docs/server-adapters) and [A2A](https://cogitator.app/docs/integrations/a2a).

Cogitator is a library. It has no hosted service, admin UI, user accounts or credential store: authentication, encryption at rest and log retention belong to the application and infrastructure that embed it.

## Execution Sandboxing

`@cogitator-ai/sandbox` provides three executors behind a `SandboxManager`: WASM, Docker and native.

### How Tools Use the Sandbox

A tool opts in with its `sandbox` option. The runtime (`packages/core/src/cogitator/tool-executor.ts`) then does **not** call the tool's `execute()` in a sandbox:

- **`sandbox.type: 'docker'`** — the call's `command` argument runs as `sh -c <command>` in the container, with the call's `cwd` and `env` arguments when given. The tool's `execute()` is not called; the result is `{ stdout, stderr, exitCode, timedOut, duration }`. The built-in `exec` tool works this way (image `cogitator/sandbox:base`, 256 MB, `network.mode: 'none'`).
- **`sandbox.type: 'wasm'`** — the validated arguments go to the module (`wasmModule`, export `wasmFunction`, default `run`) as JSON input; the module's JSON output is the result.
- **No `sandbox`, or `type: 'native'`** — `execute()` runs in your Node.js process, with no isolation.

Arguments are validated against the tool's Zod schema before anything runs.

**Fallbacks are not fail-closed.** When `@cogitator-ai/sandbox` cannot be loaded, a sandboxed tool's `execute()` runs natively in your process and the runtime logs `Sandbox unavailable, executing natively`. When the package loads but the requested executor is unavailable (Docker daemon unreachable, Extism missing), `SandboxManager` falls back WASM → Docker → native and logs `[sandbox] <type> unavailable, falling back to <type> execution`. A Docker tool's command then runs on the host. When untrusted commands must never run on the host, check `isDockerAvailable()` / `isWasmAvailable()` on a `SandboxManager` before you register such tools.

### WASM Sandbox

The WASM executor (`packages/sandbox/src/executors/wasm.ts`) runs modules with [Extism](https://extism.org/), each plugin in its own worker thread.

| Control            | Implementation                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory isolation   | WebAssembly linear memory, bounds-checked; no access to host memory                                                                                                                                |
| Memory limit       | `sandbox.wasm.memoryPages` on the Cogitator (64 KiB pages, default 256 = 16 MB) caps both the module's own memory declaration and Extism's                                                         |
| Filesystem and env | None unless `wasi: true`                                                                                                                                                                           |
| Network            | None by default; HTTP through Extism only to hosts listed in `network.allowedHosts` (ignored when `network.mode` is `'none'`)                                                                      |
| Timeout            | `timeout` per call (default 30 s); a timed-out plugin is closed, which terminates its worker                                                                                                       |
| Output size        | `stdout` and `stderr` cut to 50,000 characters each                                                                                                                                                |
| Plugin reuse       | Idle plugins are kept per module/WASI/hosts combination and reused across calls, up to `sandbox.wasm.cacheSize` (default 10), oldest evicted first. A module can keep state between calls this way |

```typescript
import type { SandboxConfig } from '@cogitator-ai/types';

const config: SandboxConfig = {
  type: 'wasm',
  wasmModule: '/path/to/module.wasm',
  timeout: 5000,
  wasi: false,
};
```

Keep `wasi: false` for untrusted modules. Modules compiled with `extism-js` embed QuickJS and need `wasi: true` (see `@cogitator-ai/wasm-tools`).

### Docker Sandbox

The Docker executor (`packages/sandbox/src/executors/docker.ts`, containers created in `packages/sandbox/src/pool/container-pool.ts`) runs each call with `docker exec` in a pooled container started as `sleep infinity`.

| Control              | Implementation                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Network              | `NetworkMode` from `network.mode`, default `'none'`; `network.allowedHosts` is rejected                  |
| Capabilities         | `CapDrop: ['ALL']`                                                                                       |
| Privilege escalation | `SecurityOpt: ['no-new-privileges']`                                                                     |
| Process limit        | `PidsLimit` from `resources.pidsLimit`, default 100                                                      |
| Memory and CPU       | `resources.memory` (e.g. `'512MB'`), `resources.cpus`, `resources.cpuShares`; unlimited when not set     |
| Host mounts          | Only those in `mounts` (`readOnly` per mount); none by default                                           |
| User                 | `user` option; not set by default, so the image's user (root for `alpine:3.19`, the default image)       |
| Root filesystem      | Writable (`ReadonlyRootfs: false`); working directory `/workspace`                                       |
| Timeout              | `timeout` per call (default 30 s); exit code 124, and the container is destroyed instead of being reused |
| Output size          | `stdout` and `stderr` capped at 50,000 bytes each                                                        |

```typescript
import type { SandboxConfig } from '@cogitator-ai/types';

const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine:3.19',
  timeout: 30_000,
  resources: { cpus: 1, memory: '512MB', pidsLimit: 100 },
  network: { mode: 'none' },
  mounts: [],
  user: '1000:1000',
};
```

**Container reuse.** Containers are pooled (`sandbox.pool.maxSize`, default 5) and reused by every call with the same image, resources, network mode, DNS, mounts and user, whichever agent, run or user it comes from. Files written to a container stay there until it is destroyed: after a timeout, after `sandbox.pool.idleTimeoutMs` of idleness (default 60 s), or on shutdown. Do not rely on a clean container per call.

Recommendations:

- Use minimal images (distroless, Alpine) and set `user` to a non-root user
- Keep `network.mode: 'none'` unless the tool needs the network
- Docker's default seccomp profile applies; Cogitator has no option for a custom profile, so configure one at the daemon level if you need it
- Consider gVisor or Kata Containers as the Docker runtime for stronger isolation

### Native Executor

The native executor spawns commands on the host. A single-element command runs through the system shell; longer commands run with their exact argv and no shell.

**It provides no isolation** and is meant for development and trusted code:

- Full access to the host filesystem and network
- Only `PATH`, `HOME`, temp-dir, locale and Windows system variables are inherited from `process.env`; anything else must be passed explicitly via `env`
- Timeout (default 30 s) kills the whole process group; output is capped at 50,000 bytes per stream
- No CPU or memory limits beyond what the OS enforces

### Comparison

| Control           | WASM                       | Docker                          | Native  |
| ----------------- | -------------------------- | ------------------------------- | ------- |
| Memory isolation  | Linear memory, page cap    | cgroups (`resources.memory`)    | None    |
| Filesystem access | None without `wasi`        | Container filesystem + `mounts` | Full    |
| Network access    | Extism `allowedHosts` only | `network.mode` (default `none`) | Full    |
| Process isolation | Worker thread per plugin   | Container PID namespace         | None    |
| Resource limits   | Memory pages, timeout      | Memory, CPU, PIDs, timeout      | Timeout |

## Threat Model

### Untrusted Tool Code

**Threat**: tool code or commands that read sensitive files, make network requests, exhaust resources or try to escape isolation.

**Mitigations**:

1. Run untrusted commands with `sandbox: { type: 'docker' }` or modules with `type: 'wasm'`, and check executor availability first (see [Fallbacks](#how-tools-use-the-sandbox))
2. Set `resources` and `timeout`; keep `network.mode: 'none'`
3. Mark side-effecting tools with `requiresApproval` so a person confirms each call
4. Review tool code before deployment; tools without `sandbox` run in your process

### LLM Prompt Injection

**Threat**: adversarial input that makes the model call tools it should not, leak its instructions or data, or produce harmful output.

**Mitigations** (all opt-in unless noted):

1. **Argument validation** (always on): every tool call is checked against the tool's Zod schema; invalid calls fail with `Invalid arguments`
2. **Least privilege**: give each agent only the tools it needs (`tools` in the agent config)
3. **Injection detection**: `security.promptInjection` on the Cogitator analyzes each run's input before anything reaches the model; with `action: 'block'` (the default) a detected injection fails the run with `PROMPT_INJECTION_DETECTED`. The local classifier is pattern-based; `classifier: 'llm'` asks a model
4. **Guardrails**: `guardrails` on the Cogitator turns on Constitutional AI: input, output and tool-call filtering, critique and revision, and a tool guard that refuses dangerous shell commands (`rm -rf /`, `mkfs.`, `dd of=/dev/...`) and system paths (`/etc/shadow`, `~/.ssh/`)
5. **Tool approvals**: `requiresApproval: true` (or a function of the arguments) pauses the run until someone decides with `cogitator.resume()`, or asks `onApproval` inline
6. **Loop limits** (always on): `maxIterations` per agent (default 10) and a run timeout (`timeout` on the run or agent, else `limits.defaultTimeout`, else 120 s)

```typescript
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator({
  security: {
    promptInjection: { action: 'block', threshold: 0.7 },
    pii: { mode: 'mask' },
  },
  guardrails: { filterToolCalls: true },
});
```

### Sensitive Data Sent to Model Providers

`security.pii` keeps personal data and secrets (emails, phone numbers, card numbers, IBANs, SSNs, IP addresses, API keys, plus your own `custom` patterns) away from the model provider:

- `mask` (default): requests carry placeholders such as `[EMAIL_1]`; answers, their stream and tool call arguments get the real values back
- `redact`: placeholders, and nothing after the model gets the values back
- `block`: a run whose input contains any fails with `PII_DETECTED`

Masking happens at the LLM backend boundary only. Memory adapters, run results, `onToolCall` arguments and observability exporters still see the real values. `onDetect` reports counts per kind (never the values) for audit logs.

### API Security

**Threat**: unauthorized access to the HTTP endpoints that expose your agents.

**Mitigations** (configured in code on each server adapter):

1. **Authentication**: the `auth` option of the Express, Fastify, Hono and Koa adapters is an async function that receives the request and returns an `AuthContext` (`userId`, `roles`, `permissions`, `metadata`). Throwing rejects the request with `401`; returning `undefined` lets it through anonymously. Express and Fastify also authenticate WebSocket upgrades with it; Koa's WebSocket takes its own `websocket.auth`. Tetsu's `auth` refuses a request when it returns `undefined`. Next.js handlers use `beforeRun(req, input)`: throw to reject (`401` by default), return run options such as `{ userId }`
2. **Per-user threads**: the `userId` from `auth` is passed to every run and checked by the thread routes. A thread belongs to the user who created it; another user gets `THREAD_ACCESS_DENIED` (`403`). See [Multiple Users](https://cogitator.app/docs/advanced/multi-user)
3. **Rate limiting**: Express has a built-in limiter (`rateLimit: { windowMs, max, keyGenerator, skip, trustProxy }`); Fastify registers `@fastify/rate-limit` (`rateLimit: { max, timeWindow, keyGenerator }`). Hono, Koa and Tetsu have none built in: add your framework's rate-limit middleware
4. **CORS**: Express has a `cors` option (origin allowlist, credentials, methods, headers); for the other adapters use the framework's CORS middleware
5. **A2A**: `A2AServer` takes `auth: { type: 'bearer' | 'apiKey', validate }`. `validate(credentials)` returns `false` to reject, `true` to admit a caller without a user, or `{ userId }` to scope tasks, contexts and memory to that user. Push notification webhooks to private, loopback and link-local addresses are refused unless `allowPrivateUrls: true`; Agent Cards can be HMAC-signed with `cardSigning`

```typescript
import { A2AServer } from '@cogitator-ai/a2a';

const a2a = new A2AServer({
  agents: { assistant },
  cogitator,
  auth: {
    type: 'bearer',
    validate: async (token) => {
      const user = await lookupToken(token);
      return user ? { userId: user.id } : false;
    },
  },
});
```

In the Express, Fastify, Hono and Koa adapters the health routes (`/health`, `/ready`) sit behind the same `auth` function (Tetsu's do not); let it admit them if your load balancer probes without credentials.

### Memory and State Security

**Threat**: sensitive data exposed through memory stores.

Cogitator does not encrypt memory itself. Mitigations:

1. Use storage-level encryption at rest (managed Postgres/MongoDB encryption, encrypted volumes)
2. Use TLS to the stores: `?sslmode=require` in the Postgres connection string, `rediss://` URLs and `password` for Redis
3. Bound retention: the Redis adapter expires keys after `ttl` seconds (default 86400); other adapters keep data until you delete it
4. Scope data per user with `userId` on runs: the threads a run creates belong to its user, and the facts and embeddings put into its context are filtered by it
5. Delete data with the adapter API (`deleteThread`, `clearThread`, `deleteEntry`, `deleteFact`, `deleteBySource`)

## Configuration Hardening

### Secrets

Provider keys reach the runtime through `llm.providers.<name>.apiKey`. `loadConfig()` from `@cogitator-ai/config` fills them from `COGITATOR_<PROVIDER>_API_KEY` or the provider's usual variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, ...). Inject these from a secret manager, never from committed files.

```yaml
NODE_ENV: production

OPENAI_API_KEY: ${VAULT_PATH}
ANTHROPIC_API_KEY: ${VAULT_PATH}

# Read by your code when you configure memory adapters
DATABASE_URL: postgresql://user:${DB_PASS}@host:5432/cogitator?sslmode=require
REDIS_URL: rediss://user:${REDIS_PASS}@host:6379

# Read by the core logger: debug | info | warn | error
LOG_LEVEL: info
```

Sandboxing, guardrails, injection detection, PII masking, authentication and rate limits are configured in code, not through environment variables: see `sandbox`, `guardrails` and `security` in `CogitatorConfig` and the `auth` / `rateLimit` options of the server adapters.

### Kubernetes Security

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: cogitator
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
  containers:
    - name: cogitator
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
      resources:
        limits:
          memory: '2Gi'
          cpu: '1'
```

A pod like this cannot reach a Docker daemon; run Docker-sandboxed tools against a separate daemon (`sandbox.docker.host` / `socketPath`) or use WASM tools.

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do NOT** open a public issue
2. Email security@cogitator.dev with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. Allow 90 days for a fix before public disclosure

## Security Reviews

- [x] Internal review of the WASM and Docker executors (December 2024)
- [ ] External penetration test
- [ ] SOC 2 audit

Cogitator has not been through an external penetration test or a SOC 2 audit. [SOC2-COMPLIANCE.md](./SOC2-COMPLIANCE.md) maps the framework's controls to the Trust Service Criteria for teams that run it.

## Security Incident Response

### Sandbox Escape Detection

Monitor for:

- `[sandbox] ... falling back to native execution` and `Sandbox unavailable, executing natively` warnings
- Unexpected network connections from sandbox hosts
- File access outside designated paths
- Process creation outside containers
- Memory usage anomalies

### Response Procedure

1. **Isolate**: stop affected agents and sandboxes (`cogitator.close()` shuts the sandbox pool down)
2. **Contain**: revoke API keys if compromised
3. **Investigate**: check your logs and traces
4. **Remediate**: patch the vulnerability, rotate secrets
5. **Report**: document the incident and notify affected users
