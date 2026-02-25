# Security Model

This document describes Cogitator's security architecture, threat model, and hardening guidelines.

## Execution Sandboxing

Cogitator provides three sandbox execution modes with different security characteristics:

### WASM Sandbox (Recommended for Production)

The WASM sandbox uses [Extism](https://extism.org/) to execute code in a WebAssembly sandbox.

**Security Properties:**

- **Memory Isolation**: WASM linear memory is bounds-checked; no access to host memory
- **No Filesystem Access**: By default, WASM modules cannot access the host filesystem
- **No Network Access**: WASM modules cannot make network requests without explicit host functions
- **CPU Limits**: Execution can be time-bounded via timeout configuration
- **Memory Limits**: `memoryPages` is defined in `SandboxWasmConfig` (64KB per page) but is not currently enforced at the Extism level; rely on `timeout` and output size limits instead

**Configuration:**

```typescript
const config: SandboxConfig = {
  type: 'wasm',
  wasmModule: '/path/to/module.wasm',
  timeout: 5000, // 5 second timeout
  wasi: false, // Disable WASI for maximum isolation
};
```

**Known Limitations:**

- WASM modules must be pre-compiled; dynamic code execution is not supported
- QuickJS runtime embedded in WASM modules adds ~2MB overhead
- Some JavaScript features may not be available in the QuickJS environment

### Docker Sandbox

Docker provides container-level isolation for more complex tool execution.

**Security Properties:**

- **Process Isolation**: Runs in a separate container with its own PID namespace
- **Filesystem Isolation**: Container has its own filesystem; host mounts are configurable
- **Network Isolation**: Configurable network access (default: disabled)
- **Resource Limits**: CPU, memory, and I/O can be limited via cgroups

**Configuration:**

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine:3.19',
  timeout: 30000, // 30 seconds
  resources: {
    cpus: 1, // 1 CPU core
    memory: '512m', // 512MB RAM
  },
  network: {
    mode: 'none', // No network access
  },
  mounts: [], // No host mounts
};
```

**Recommendations:**

- Use minimal base images (Alpine, distroless)
- Run containers as non-root user
- Disable privileged mode
- Use seccomp profiles
- Enable read-only root filesystem where possible

### Native Sandbox (Development Only)

Native execution runs tools directly in the Node.js process.

**WARNING**: This mode provides NO isolation and should only be used for development and trusted code.

**Security Properties:**

- No isolation from host process
- Full access to filesystem, network, and environment
- No resource limits beyond OS-level controls

## Threat Model

### Untrusted Tool Code

**Threat**: Malicious or buggy tool code attempting to:

- Access sensitive files
- Make unauthorized network requests
- Exhaust system resources (DoS)
- Escape sandbox isolation

**Mitigations**:

1. Use WASM or Docker sandbox for untrusted code
2. Apply resource limits (CPU, memory, time)
3. Disable network access by default
4. Audit tool code before deployment

### LLM Prompt Injection

**Threat**: Adversarial inputs causing the LLM to:

- Execute unintended tool calls
- Reveal system prompts or sensitive data
- Generate harmful outputs

**Mitigations**:

1. Validate tool call arguments against schemas (Zod validation)
2. Limit available tools to minimum necessary set
3. Use tool allowlists/denylists per agent
4. Implement output filtering for sensitive patterns
5. Set maximum iteration limits to prevent runaway loops

### API Security

**Threat**: Unauthorized access to Cogitator APIs

**Mitigations**:

1. Pluggable auth via `AuthFunction` — implement API key (`X-API-Key`), JWT, or any scheme
2. Rate limiting built-in via `RateLimitConfig` (windowMs, max, keyGenerator)
3. CORS control via `CorsConfig` (origin allowlist, credentials, methods)
4. Auth context (`userId`, `roles`, `permissions`) available to all route handlers

### Memory and State Security

**Threat**: Sensitive data exposure through memory systems

**Mitigations**:

1. Encrypt data at rest in Postgres (TDE)
2. Use Redis AUTH and TLS
3. Implement memory TTLs for automatic expiration
4. Sanitize logs to remove PII

## Configuration Hardening

### Production Checklist

```yaml
# Environment variables for production
NODE_ENV: production

# LLM Configuration
OPENAI_API_KEY: ${VAULT_PATH} # Use secret manager
ANTHROPIC_API_KEY: ${VAULT_PATH}

# Database
DATABASE_URL: postgresql://user:${DB_PASS}@host:5432/cogitator?sslmode=require
REDIS_URL: rediss://user:${REDIS_PASS}@host:6379 # TLS enabled

# Sandbox defaults
SANDBOX_DEFAULT_TYPE: wasm
SANDBOX_TIMEOUT: 10000
SANDBOX_NETWORK_ENABLED: false

# API Security
API_KEY_REQUIRED: true
RATE_LIMIT_REQUESTS: 100
RATE_LIMIT_WINDOW: 60000

# Logging
LOG_LEVEL: info
LOG_REDACT_PATTERNS: password,secret,token,key
```

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

## WASM vs Docker Security Comparison

| Feature              | WASM                  | Docker                 |
| -------------------- | --------------------- | ---------------------- |
| Memory Isolation     | Yes (linear memory)   | Yes (cgroups)          |
| Filesystem Isolation | Yes (no access)       | Yes (configurable)     |
| Network Isolation    | Yes (no access)       | Yes (configurable)     |
| Process Isolation    | N/A (single-threaded) | Yes (PID namespace)    |
| Resource Limits      | Memory pages, timeout | CPU, memory, I/O       |
| Cold Start           | 1-10ms                | 1-5s                   |
| Overhead             | ~2MB per module       | 50-200MB per container |
| Escape Risk          | Very Low              | Low                    |

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do NOT** open a public issue
2. Email security@cogitator.dev with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. Allow 90 days for fix before public disclosure

## Security Audits

- [x] Initial security review (Month 9) - Completed
- [ ] External penetration test (planned)
- [ ] SOC 2 compliance (planned for cloud offering)

---

## Internal Security Review (Month 9)

### WASM Sandbox Security Analysis

**Reviewed**: December 2024

**Implementation**: `packages/sandbox/src/executors/wasm.ts`

#### Security Properties Verified

| Property             | Status | Notes                                         |
| -------------------- | ------ | --------------------------------------------- |
| Memory isolation     | ✅     | Extism provides linear memory bounds checking |
| No filesystem access | ✅     | WASM modules cannot access host filesystem    |
| No network access    | ✅     | No network primitives available in WASM       |
| Timeout enforcement  | ✅     | Promise.race with configurable timeout        |
| Output size limits   | ✅     | MAX_OUTPUT_SIZE = 50,000 bytes                |
| Plugin caching       | ✅     | FIFO cache with configurable size (cacheSize) |

#### WASI Configuration

When `wasi: true` is enabled:

- Limited filesystem access may be exposed
- Environment variables may be accessible
- **Recommendation**: Keep `wasi: false` for untrusted code

#### Known Attack Vectors

1. **Resource exhaustion**: Mitigated by timeout and output limits
2. **Memory bombs**: Mitigated by Extism memory limits
3. **Infinite loops**: Mitigated by execution timeout
4. **Side-channel attacks**: Low risk in current implementation

#### Recommendations

1. Pin Extism version in production (`@extism/extism@^1.0.3`)
2. Audit WASM modules before deployment
3. Monitor plugin cache memory usage
4. Set conservative timeouts (< 30s recommended)

### Docker Sandbox Security Analysis

**Reviewed**: December 2024

**Implementation**: `packages/sandbox/src/executors/docker.ts`

#### Security Controls Verified

| Control              | Status | Implementation                                 |
| -------------------- | ------ | ---------------------------------------------- |
| Network isolation    | ✅     | `NetworkMode: 'none'`                          |
| Capability dropping  | ✅     | `CapDrop: ['ALL']`                             |
| Privilege escalation | ✅     | `no-new-privileges`                            |
| Non-root user        | ⚠️     | Set via `config.user`; not enforced by default |
| Resource limits      | ✅     | Memory, CPU, PID limits                        |
| Timeout              | ✅     | Container kill after timeout                   |

#### Container Pool Security

- Containers are reused to reduce cold start
- Idle containers are cleaned up after 60s
- Max pool size prevents resource exhaustion

#### Recommendations

1. Use distroless or scratch-based images
2. Enable seccomp profiles in production
3. Consider gVisor or Kata Containers for additional isolation
4. Regularly update base images

### Native Executor Security

**Status**: Development use only

**WARNING**: The native executor provides NO isolation and should never be used with untrusted code in production.

#### Use Cases

- Local development and testing
- Trusted internal tools only
- Debugging and profiling

---

## Security Incident Response

### Sandbox Escape Detection

Monitor for:

- Unexpected network connections from sandbox hosts
- File access outside designated paths
- Process creation outside containers
- Memory usage anomalies

### Response Procedure

1. **Isolate**: Stop affected agents and sandboxes
2. **Contain**: Revoke API keys if compromised
3. **Investigate**: Check audit logs and traces
4. **Remediate**: Patch vulnerability, rotate secrets
5. **Report**: Document incident and notify affected users
