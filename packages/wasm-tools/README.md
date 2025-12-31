# @cogitator-ai/wasm-tools

WASM-based tools for Cogitator agents. Secure, sandboxed tool execution using WebAssembly.

## Installation

```bash
pnpm add @cogitator-ai/wasm-tools
```

## Usage

This package provides WASM tool configurations to be used with `@cogitator-ai/sandbox`.

### With Sandbox Executor

```typescript
import { WasmSandbox } from '@cogitator-ai/sandbox';
import { calcToolConfig, jsonToolConfig } from '@cogitator-ai/wasm-tools';

// Create executor
const sandbox = new WasmSandbox(calcToolConfig);

// Calculate expression
const result = await sandbox.execute({ expression: '2 + 2 * 3' });
// { result: 8, expression: '2 + 2 * 3' }
```

### With Cogitator Tools

```typescript
import { tool } from '@cogitator-ai/core';
import { WasmSandbox } from '@cogitator-ai/sandbox';
import {
  calcToolConfig,
  calcToolSchema,
  jsonToolConfig,
  jsonToolSchema,
} from '@cogitator-ai/wasm-tools';

const calcSandbox = new WasmSandbox(calcToolConfig);

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate mathematical expressions safely',
  parameters: calcToolSchema,
  execute: async (input) => {
    const result = await calcSandbox.execute(input);
    return result;
  },
});
```

### Available Exports

| Export              | Description                                   |
| ------------------- | --------------------------------------------- |
| `calcToolConfig`    | Sandbox config for calculator WASM module     |
| `calcToolSchema`    | Zod schema for calculator input               |
| `jsonToolConfig`    | Sandbox config for JSON processor WASM module |
| `jsonToolSchema`    | Zod schema for JSON processor input           |
| `getWasmPath(name)` | Get path to a WASM module by name             |

## Security

WASM tools run in a secure sandbox:

- No filesystem access
- No network access
- Memory limits enforced
- Timeout enforcement

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
