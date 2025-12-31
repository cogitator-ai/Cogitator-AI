# @cogitator-ai/sandbox

Sandbox execution for Cogitator agents. Supports Docker containers and WASM (via Extism) for secure code execution.

## Installation

```bash
pnpm add @cogitator-ai/sandbox

# Optional peer dependencies
pnpm add dockerode  # For Docker sandbox
pnpm add @extism/extism  # For WASM sandbox
```

## Usage

### Docker Sandbox

```typescript
import { DockerSandboxExecutor } from '@cogitator-ai/sandbox';

const sandbox = new DockerSandboxExecutor({
  image: 'cogitator/sandbox-node:latest',
  timeout: 30000,
  resources: {
    memory: '256m',
    cpus: '0.5',
  },
});

const result = await sandbox.execute({
  command: 'node',
  args: ['-e', 'console.log("Hello!")'],
});

console.log(result.stdout); // "Hello!"
```

### WASM Sandbox

```typescript
import { WasmSandboxExecutor } from '@cogitator-ai/sandbox';

const sandbox = new WasmSandboxExecutor({
  timeout: 10000,
  wasi: true,
});

const result = await sandbox.execute({
  module: 'https://example.com/tool.wasm',
  input: { data: 'test' },
});
```

### Sandbox Manager

Automatic fallback between sandboxes:

```typescript
import { SandboxManager } from '@cogitator-ai/sandbox';

const manager = new SandboxManager({
  preferredType: 'docker',
  fallbackToNative: true,
});

// Uses Docker if available, falls back to native
const result = await manager.execute(request);
```

### Security Features

- Network isolation (`NetworkMode: 'none'`)
- Dropped capabilities (`CapDrop: ['ALL']`)
- No privilege escalation (`SecurityOpt: ['no-new-privileges']`)
- Resource limits (memory, CPU, PIDs)
- Timeout enforcement

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
