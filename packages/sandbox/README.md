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

if (result.success) {
  console.log(result.data.stdout); // "Hello!"
} else {
  console.error(result.error);
}
```

`execute()` returns a `SandboxResult`: `{ success: true, data }` or `{ success: false, error }`. A command that exits non-zero is still a success; check `data.exitCode`.

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

### Fallback and Initialization

`initialize()` is idempotent and safe to call concurrently; `execute()` calls it automatically. When the requested backend is unavailable the manager falls back (`wasm` → `docker` → `native`, `docker` → `native`) with a warning, and the manager `defaults` are applied to the fallback execution as well. The native fallback has **no isolation** — check `isDockerAvailable()` / `isWasmAvailable()` first if untrusted code must never reach the host.

When no `docker` connection options are given, Dockerode's defaults are used, so `DOCKER_HOST` is respected.

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

Docker containers are created with this host configuration:

| Setting       | Value                                         |
| ------------- | --------------------------------------------- |
| `NetworkMode` | `network.mode`, default `'none'` (no network) |
| `CapDrop`     | `['ALL']` (every capability dropped)          |
| `SecurityOpt` | `['no-new-privileges']`                       |
| `PidsLimit`   | `resources.pidsLimit`, default `100`          |
| Root FS       | Writable (not configurable)                   |
| Working dir   | `/workspace`                                  |
| Label         | `ai.cogitator.sandbox=true`                   |

- `command` is executed as an argv array (no shell); use `['sh', '-c', '...']` for shell syntax.
- Output is demultiplexed frame by frame (frames split across network chunks are reassembled) and capped at 50 000 bytes per stream.
- Timed-out containers are destroyed instead of being returned to the pool.
- `network.dns` is applied to new containers. `network.allowedHosts` is rejected because Docker cannot enforce an egress allow-list — use `mode: 'none'` or a dedicated network.
- Containers are labeled `ai.cogitator.sandbox=true` (`SANDBOX_CONTAINER_LABEL`), so leftovers from a crashed process can be removed with `docker rm -f $(docker ps -aq --filter label=ai.cogitator.sandbox)`.

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

Containers are only reused for requests with identical settings (image, resources, network mode, DNS, mounts and user), so a container created with a host mount or network access is never handed to a request that asked for isolation. The idle-cleanup timer does not keep the Node.js process alive.

### Pool Options

| Option          | Type     | Default | Description                            |
| --------------- | -------- | ------- | -------------------------------------- |
| `maxSize`       | `number` | `5`     | Maximum containers to keep warm        |
| `idleTimeoutMs` | `number` | `60000` | Time before destroying idle containers |

---

## WASM Executor

Execute WebAssembly modules via Extism. Each plugin runs in its own worker thread, so a timeout terminates a runaway module instead of blocking the event loop. Idle plugins are pooled per module / WASI / allowed-host combination (up to `cacheSize`); concurrent executions use separate plugin instances.

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

- Local paths, module specifiers and `http(s)` URLs are supported for `wasmModule`.
- `wasmModule`, `functionName` and `wasi` from the executor options are used when the per-request config omits them.
- `network.allowedHosts` is forwarded to Extism's HTTP allow-list (empty when `network.mode` is `'none'`).
- `memoryPages` (default 256 = 16 MB) caps the module's own memory: its memory section gets that maximum before the module loads, so `memory.grow` past it fails inside the module, and a module that needs more to start is refused. Extism's memory for plugin input, output and vars gets the same limit. Modules from a URL are fetched by the executor so the cap applies to them too.

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

if (result.success) console.log(result.data.stdout);
```

**Warning:** Native execution has no isolation. Use only when Docker is unavailable.

- A single-element command (`['ls -la | wc -l']`) runs through the system shell; longer commands are executed directly with exact argv (no shell), like Docker.
- `stdin` is piped to the process.
- Only `PATH`, `HOME`, temp-dir, locale and Windows system variables are inherited from the host environment; secrets in `process.env` are not passed to executed code. Add variables explicitly via `env`.
- On timeout the whole process group is killed (`SIGKILL`) and the result is returned immediately with exit code `124`.
- Output is capped at 50 000 bytes per stream while the process is still drained.

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

Supported formats: `'256B'`, `'256KB'`, `'256MB'`, `'1GB'`, `'1TB'`, Docker-style `'512m'` / `'2g'` and binary `'1GiB'` (all binary multiples, case-insensitive). Zero or negative memory and CPU limits are rejected instead of silently running unlimited.

### CPU

`SandboxConfig` is exported as a type (`import type { SandboxConfig } from '@cogitator-ai/sandbox'`).

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine',
  resources: {
    cpus: 0.5,
    cpuShares: 512,
  },
};
```

### Process Limits

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine',
  resources: {
    pidsLimit: 50,
  },
};
```

---

## Network Configuration

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine',
  network: {
    mode: 'none',
  },
};
```

Network modes:

- `'none'` - No network access (default, most secure)
- `'bridge'` - Docker bridge network
- `'host'` - Host network (not recommended)

---

## Volume Mounts

Mount host directories into the container:

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine',
  mounts: [
    { source: '/host/data', target: '/data', readOnly: true },
    { source: '/host/output', target: '/output', readOnly: false },
  ],
};
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

The runtime starts a `SandboxManager` from `new Cogitator({ sandbox })` on the first sandboxed tool call. For a Docker tool it does not call `execute`: the sandbox runs the tool's `command` argument with `sh -c` (with optional `cwd` / `env` arguments) and the output becomes the tool result. A WASM tool gets its arguments as JSON on stdin and its JSON stdout is the result. When no sandbox can start, the tool runs natively with a warning. See [Sandbox](https://cogitator.app/docs/deployment/sandbox) on the website.

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

if (result.success) {
  const output = JSON.parse(result.data.stdout);
  console.log(output.sum);
}
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

if (result.success && result.data.timedOut) {
  console.log('Command timed out');
}
```

### Check Exit Codes

```typescript
const result = await manager.execute(
  { command: ['sh', '-c', 'exit 42'] },
  { type: 'docker', image: 'alpine' }
);

if (result.success) console.log('Exit code:', result.data.exitCode);
```

---

## License

MIT
