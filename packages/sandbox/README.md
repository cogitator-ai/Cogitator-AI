# @cogitator-ai/sandbox

Secure sandbox execution for Cogitator agents. Run untrusted code in isolated Docker containers, WASM modules, or native fallback with resource limits, network isolation, and timeout enforcement.

## Installation

```bash
pnpm add @cogitator-ai/sandbox

# Optional peer dependencies
pnpm add dockerode       # For Docker sandbox
pnpm add @extism/extism  # For WASM sandbox
```

## Quick Start

```typescript
import { SandboxManager } from '@cogitator-ai/sandbox';

const manager = new SandboxManager();
await manager.initialize();

const result = await manager.execute(
  { command: ['python', '-c', 'print("Hello!")'] },
  { type: 'docker', image: 'python:3.11-alpine' }
);

console.log(result.data?.stdout); // "Hello!"
```

## Features

- **Docker Sandbox** - Full container isolation with dropped capabilities
- **WASM Sandbox** - Extism-powered WebAssembly execution
- **Native Fallback** - Direct execution when containers unavailable
- **Container Pool** - Reuse warm containers for faster execution
- **Resource Limits** - Memory, CPU, PID limits
- **Network Isolation** - Disabled by default
- **Timeout Enforcement** - Kill runaway processes
- **Security Hardening** - No privilege escalation, all capabilities dropped

---

## Sandbox Manager

The `SandboxManager` orchestrates multiple execution backends with automatic fallback.

```typescript
import { SandboxManager } from '@cogitator-ai/sandbox';

const manager = new SandboxManager({
  docker: {
    socketPath: '/var/run/docker.sock',
  },
  pool: {
    maxSize: 10,
    idleTimeoutMs: 120_000,
  },
  defaults: {
    timeout: 30_000,
    resources: {
      memory: '256MB',
      cpus: 1,
    },
    network: { mode: 'none' },
  },
});

await manager.initialize();

const result = await manager.execute(
  {
    command: ['node', '-e', 'console.log(2+2)'],
    timeout: 5000,
    env: { NODE_ENV: 'production' },
    cwd: '/workspace',
  },
  {
    type: 'docker',
    image: 'node:20-alpine',
  }
);

if (result.success) {
  console.log('Output:', result.data.stdout);
  console.log('Exit code:', result.data.exitCode);
  console.log('Duration:', result.data.duration, 'ms');
}
```

### Availability Checks

```typescript
const dockerAvailable = await manager.isDockerAvailable();
const wasmAvailable = await manager.isWasmAvailable();

console.log('Docker:', dockerAvailable);
console.log('WASM:', wasmAvailable);
```

### Shutdown

```typescript
await manager.shutdown();
```

---

## Docker Executor

Full container isolation with security hardening.

```typescript
import { DockerSandboxExecutor } from '@cogitator-ai/sandbox';

const docker = new DockerSandboxExecutor({
  docker: {
    socketPath: '/var/run/docker.sock',
  },
  pool: {
    maxSize: 5,
    idleTimeoutMs: 60_000,
  },
});

const connectResult = await docker.connect();
if (!connectResult.success) {
  console.error('Docker not available:', connectResult.error);
}

const result = await docker.execute(
  {
    command: ['python', '-c', 'print("Hello!")'],
    stdin: 'input data',
    timeout: 10_000,
    cwd: '/app',
    env: { MY_VAR: 'value' },
  },
  {
    type: 'docker',
    image: 'python:3.11-alpine',
    timeout: 30_000,
    resources: {
      memory: '512MB',
      cpus: 2,
      pidsLimit: 50,
    },
    network: {
      mode: 'none',
    },
    mounts: [{ source: '/tmp/data', target: '/data', readOnly: true }],
    env: { GLOBAL_VAR: 'value' },
    workdir: '/workspace',
    user: 'nobody',
  }
);

await docker.disconnect();
```

### Security Features

Docker containers run with these security settings:

```typescript
{
  NetworkMode: 'none',          // No network access
  CapDrop: ['ALL'],             // Drop all capabilities
  SecurityOpt: ['no-new-privileges'],  // No privilege escalation
  PidsLimit: 100,               // Limit process count
  ReadonlyRootfs: false,        // Writable (can enable true)
}
```

---

## Container Pool

Reuse warm containers for faster execution.

```typescript
import { ContainerPool } from '@cogitator-ai/sandbox';

const pool = new ContainerPool(dockerClient, {
  maxSize: 10,
  idleTimeoutMs: 60_000,
});

const container = await pool.acquire('python:3.11-alpine', {
  memory: 256 * 1024 * 1024,
  cpus: 1,
  networkMode: 'none',
  mounts: [],
});

await pool.release(container);

await pool.destroyAll();
```

### Pool Options

| Option          | Type     | Default | Description                            |
| --------------- | -------- | ------- | -------------------------------------- |
| `maxSize`       | `number` | `5`     | Maximum containers to keep warm        |
| `idleTimeoutMs` | `number` | `60000` | Time before destroying idle containers |

---

## WASM Executor

Execute WebAssembly modules via Extism.

```typescript
import { WasmSandboxExecutor } from '@cogitator-ai/sandbox';

const wasm = new WasmSandboxExecutor({
  wasm: {
    cacheSize: 10,
    wasi: true,
  },
});

await wasm.connect();

const result = await wasm.execute(
  {
    command: ['process'],
    stdin: JSON.stringify({ data: 'input' }),
  },
  {
    type: 'wasm',
    wasmModule: 'https://example.com/plugin.wasm',
    wasmFunction: 'run',
    wasi: true,
    timeout: 5000,
  }
);

await wasm.disconnect();
```

---

## Native Executor

Direct execution without isolation (fallback mode).

```typescript
import { NativeSandboxExecutor } from '@cogitator-ai/sandbox';

const native = new NativeSandboxExecutor();
await native.connect();

const result = await native.execute(
  {
    command: ['ls', '-la'],
    cwd: '/tmp',
    env: { LC_ALL: 'C' },
    timeout: 5000,
  },
  { type: 'native' }
);

console.log(result.data?.stdout);
```

**Warning:** Native execution has no isolation. Use only when Docker is unavailable.

---

## Execution Request

```typescript
interface SandboxExecutionRequest {
  command: string[];
  stdin?: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}
```

## Execution Result

```typescript
interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration: number;
}
```

---

## Resource Limits

### Memory

```typescript
const result = await manager.execute(request, {
  type: 'docker',
  image: 'alpine',
  resources: {
    memory: '256MB',
  },
});
```

Supported formats: `'256B'`, `'256KB'`, `'256MB'`, `'256GB'`

### CPU

```typescript
{
  resources: {
    cpus: 0.5,
    cpuShares: 512,
  },
}
```

### Process Limits

```typescript
{
  resources: {
    pidsLimit: 50,
  },
}
```

---

## Network Configuration

```typescript
{
  network: {
    mode: 'none',
  },
}
```

Network modes:

- `'none'` - No network access (default, most secure)
- `'bridge'` - Docker bridge network
- `'host'` - Host network (not recommended)

---

## Volume Mounts

Mount host directories into the container:

```typescript
{
  mounts: [
    { source: '/host/data', target: '/data', readOnly: true },
    { source: '/host/output', target: '/output', readOnly: false },
  ],
}
```

---

## Utility Functions

### Parse Memory

```typescript
import { parseMemory } from '@cogitator-ai/sandbox';

parseMemory('256MB');
parseMemory('1GB');
parseMemory('512KB');
```

### CPU to NanoCPUs

```typescript
import { cpusToNanoCpus } from '@cogitator-ai/sandbox';

cpusToNanoCpus(0.5);
cpusToNanoCpus(2);
```

---

## Type Reference

```typescript
import type {
  SandboxType,
  SandboxConfig,
  SandboxResourceLimits,
  SandboxNetworkConfig,
  SandboxMount,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxManagerConfig,
  SandboxPoolConfig,
  SandboxDockerConfig,
  SandboxResult,
} from '@cogitator-ai/sandbox';
```

---

## Integration with Cogitator

Use sandboxed tools in your agents:

```typescript
import { Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const shellTool = tool({
  name: 'run_shell',
  description: 'Execute shell commands safely',
  parameters: z.object({
    command: z.string(),
  }),
  sandbox: {
    type: 'docker',
    image: 'ubuntu:22.04',
    resources: { memory: '256MB' },
    network: { mode: 'none' },
  },
  timeout: 30000,
  execute: async ({ command }) => command,
});

const cog = new Cogitator({
  sandbox: {
    pool: { maxSize: 5 },
  },
});
```

---

## Examples

### Run Python Code

```typescript
const result = await manager.execute(
  {
    command: [
      'python',
      '-c',
      `
import json
data = {"sum": 2 + 2}
print(json.dumps(data))
    `,
    ],
  },
  {
    type: 'docker',
    image: 'python:3.11-alpine',
    timeout: 10_000,
  }
);

const output = JSON.parse(result.data!.stdout);
console.log(output.sum);
```

### Run Node.js Code

```typescript
const result = await manager.execute(
  {
    command: ['node', '-e', 'console.log(JSON.stringify({result: 42}))'],
  },
  {
    type: 'docker',
    image: 'node:20-alpine',
    resources: { memory: '128MB' },
  }
);
```

### Run Shell Commands

```typescript
const result = await manager.execute(
  {
    command: ['sh', '-c', 'ls -la /workspace && pwd'],
    cwd: '/workspace',
  },
  {
    type: 'docker',
    image: 'alpine:3.19',
  }
);
```

### Handle Timeouts

```typescript
const result = await manager.execute(
  { command: ['sleep', '60'] },
  { type: 'docker', image: 'alpine', timeout: 5000 }
);

if (result.data?.timedOut) {
  console.log('Command timed out');
}
```

### Check Exit Codes

```typescript
const result = await manager.execute(
  { command: ['sh', '-c', 'exit 42'] },
  { type: 'docker', image: 'alpine' }
);

console.log('Exit code:', result.data?.exitCode);
```

---

## License

MIT
