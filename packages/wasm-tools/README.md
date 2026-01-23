# @cogitator-ai/wasm-tools

WASM-based tools for Cogitator agents. Secure, sandboxed tool execution using WebAssembly.

## Features

- 🚀 **100-500x faster cold start** than Docker containers
- 🔒 **Memory-safe execution** in isolated Extism sandbox
- 📦 **~20x lower memory footprint** compared to containers
- 🛠️ **Custom tool framework** - create your own WASM tools
- 🔄 **Hot-reload support** - update WASM modules without restart

## Installation

```bash
pnpm add @cogitator-ai/wasm-tools
```

## Quick Start

### Pre-built Tools

Use the built-in WASM tools:

```typescript
import {
  createCalcTool,
  createJsonTool,
  createHashTool,
  createBase64Tool,
} from '@cogitator-ai/wasm-tools';
import { Cogitator, Agent } from '@cogitator-ai/core';

const calc = createCalcTool();
const json = createJsonTool();
const hash = createHashTool();
const base64 = createBase64Tool();

const agent = new Agent({
  name: 'utility-assistant',
  model: 'gpt-4o',
  tools: [calc, json, hash, base64],
});

const cog = new Cogitator({ llm: { defaultProvider: 'openai' } });
const result = await cog.run(agent, {
  input: 'Calculate the SHA-256 hash of "hello world"',
});
```

### Custom WASM Tools

Create custom tools that run in the WASM sandbox:

```typescript
import { defineWasmTool } from '@cogitator-ai/wasm-tools';
import { z } from 'zod';

const hashTool = defineWasmTool({
  name: 'hash_text',
  description: 'Hash text using various algorithms',
  wasmModule: './my-hash.wasm',
  wasmFunction: 'hash',
  parameters: z.object({
    text: z.string().describe('Text to hash'),
    algorithm: z.enum(['sha256', 'sha512', 'md5']),
  }),
  category: 'utility',
  tags: ['hash', 'crypto'],
  timeout: 5000,
});

const agent = new Agent({
  name: 'hasher',
  tools: [hashTool],
});
```

### Hot-Reload with WasmToolManager

Watch WASM files and automatically reload on changes:

```typescript
import { WasmToolManager } from '@cogitator-ai/wasm-tools';
import { Cogitator, Agent } from '@cogitator-ai/core';

const manager = new WasmToolManager({ debounceMs: 200 });

// Watch directory for WASM plugins
await manager.watch('./plugins/*.wasm', {
  onLoad: (name) => console.log(`✓ Loaded: ${name}`),
  onReload: (name) => console.log(`↻ Reloaded: ${name}`),
  onUnload: (name) => console.log(`✗ Unloaded: ${name}`),
  onError: (name, _, err) => console.error(`Error ${name}: ${err.message}`),
});

// Or load a single module
const calcTool = await manager.load('./plugins/calc.wasm');

// Get all tools for agent
const agent = new Agent({
  name: 'wasm-agent',
  tools: manager.getTools(),
});

// Tools automatically use the latest plugin version after reload
const cogitator = new Cogitator({ llm: { defaultProvider: 'openai' } });
await cogitator.run(agent, 'Calculate 2 + 2');

// Cleanup when done
await manager.close();
```

## API Reference

### defineWasmTool(config)

Create a custom WASM tool for agent use.

```typescript
interface WasmToolConfig<TParams> {
  name: string;
  description: string;
  wasmModule: string; // Path to .wasm file
  wasmFunction?: string; // Function to call (default: 'run')
  parameters: ZodType<TParams>;
  category?: ToolCategory;
  tags?: string[];
  timeout?: number; // Execution timeout in ms
  wasi?: boolean; // Enable WASI support
  memoryPages?: number; // WASM memory limit
}
```

### createCalcTool(options?)

Create a calculator tool for mathematical expressions.

```typescript
const calc = createCalcTool({ timeout: 10000 });

// Supports: +, -, *, /, %, parentheses
// Example: "2 + 2 * 3" → 8
```

### createJsonTool(options?)

Create a JSON processor tool with JSONPath query support.

```typescript
const json = createJsonTool({ timeout: 10000 });

// Example: { json: '{"a": {"b": 1}}', query: '$.a.b' } → 1
```

### createHashTool(options?)

Create a cryptographic hash tool supporting multiple algorithms.

```typescript
const hash = createHashTool({ timeout: 10000 });

// Supports: sha256, sha1, md5
// Example: { text: "hello", algorithm: "sha256" } → "2cf24dba5fb0a30e..."
```

### createBase64Tool(options?)

Create a Base64 encoding/decoding tool with URL-safe variant support.

```typescript
const base64 = createBase64Tool({ timeout: 10000 });

// Example: { text: "hello", operation: "encode" } → "aGVsbG8="
// Example: { text: "aGVsbG8=", operation: "decode" } → "hello"
// URL-safe: { text: "hello", operation: "encode", urlSafe: true }
```

### getWasmPath(name)

Get the path to a pre-built WASM module.

```typescript
import { getWasmPath } from '@cogitator-ai/wasm-tools';

const calcPath = getWasmPath('calc'); // Path to calc.wasm
const jsonPath = getWasmPath('json'); // Path to json.wasm
```

### WasmToolManager

Manage WASM tools with hot-reload support.

```typescript
interface WasmToolManagerOptions {
  debounceMs?: number; // File change debounce delay (default: 100ms)
  useWasi?: boolean; // Enable WASI for all modules
}

interface WasmToolCallbacks {
  onLoad?: (name: string, path: string) => void;
  onReload?: (name: string, path: string) => void;
  onUnload?: (name: string, path: string) => void;
  onError?: (name: string, path: string, error: Error) => void;
}

class WasmToolManager {
  constructor(options?: WasmToolManagerOptions);

  // Watch a glob pattern for WASM files
  watch(pattern: string, callbacks?: WasmToolCallbacks): Promise<void>;

  // Load a single WASM module
  load(wasmPath: string): Promise<Tool>;

  // Get all loaded tools
  getTools(): Tool[];

  // Get a tool by module name
  getTool(name: string): Tool | undefined;

  // Get module metadata
  getModule(name: string): LoadedModule | undefined;
  getModules(): LoadedModule[];

  // Close watcher and all plugins
  close(): Promise<void>;
}
```

### Legacy Exports

For direct sandbox usage:

| Export             | Description                               |
| ------------------ | ----------------------------------------- |
| `calcToolConfig`   | Sandbox config for calculator WASM module |
| `calcToolSchema`   | Zod schema for calculator input           |
| `jsonToolConfig`   | Sandbox config for JSON processor         |
| `jsonToolSchema`   | Zod schema for JSON processor input       |
| `hashToolConfig`   | Sandbox config for hash WASM module       |
| `hashToolSchema`   | Zod schema for hash input                 |
| `base64ToolConfig` | Sandbox config for base64 WASM module     |
| `base64ToolSchema` | Zod schema for base64 input               |

## Building Custom WASM Modules

WASM modules use the Extism JS PDK:

```typescript
// my-tool.ts
export function run(): number {
  const input = JSON.parse(Host.inputString());

  // Your logic here
  const result = { processed: input.data };

  Host.outputString(JSON.stringify(result));
  return 0; // 0 = success
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
```

Build with:

```bash
esbuild my-tool.ts -o temp/my-tool.js --bundle --format=cjs --target=es2020
extism-js temp/my-tool.js -o dist/my-tool.wasm
```

## Security

WASM tools run in a secure Extism sandbox:

- ❌ No filesystem access (unless WASI enabled)
- ❌ No network access
- ✅ Memory limits enforced
- ✅ Timeout enforcement
- ✅ Isolated execution environment

## License

MIT
