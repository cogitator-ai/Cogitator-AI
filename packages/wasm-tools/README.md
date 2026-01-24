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
  createSlugTool,
  createValidationTool,
  createDiffTool,
  createRegexTool,
  createCsvTool,
  createMarkdownTool,
  createXmlTool,
  createDatetimeTool,
  createCompressionTool,
  createSigningTool,
} from '@cogitator-ai/wasm-tools';
import { Cogitator, Agent } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'utility-assistant',
  model: 'gpt-4o',
  tools: [
    createCalcTool(),
    createJsonTool(),
    createHashTool(),
    createBase64Tool(),
    createSlugTool(),
    createValidationTool(),
    createDiffTool(),
    createRegexTool(),
    createCsvTool(),
    createMarkdownTool(),
    createXmlTool(),
    createDatetimeTool(),
    createCompressionTool(),
    createSigningTool(),
  ],
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

### createSlugTool(options?)

Generate URL-safe slugs from text with Unicode transliteration.

```typescript
const slug = createSlugTool({ timeout: 10000 });

// Example: { text: "Hello World!" } → "hello-world"
// Example: { text: "Привет мир", separator: "_" } → "privet_mir"
```

### createValidationTool(options?)

Validate common formats: email, URL, UUID, IPv4, IPv6.

```typescript
const validation = createValidationTool({ timeout: 10000 });

// Example: { value: "test@example.com", type: "email" } → { valid: true }
// Example: { value: "192.168.1.1", type: "ipv4" } → { valid: true }
```

### createDiffTool(options?)

Compare texts using Myers diff algorithm.

```typescript
const diff = createDiffTool({ timeout: 10000 });

// Example: { original: "hello", modified: "hallo" }
// Returns unified diff with additions/deletions count
```

### createRegexTool(options?)

Safe regex operations with ReDoS protection.

```typescript
const regex = createRegexTool({ timeout: 10000 });

// Example: { text: "hello world", pattern: "\\w+", operation: "matchAll" }
// Supports: match, matchAll, test, replace, split
```

### createCsvTool(options?)

RFC 4180 compliant CSV parsing and generation.

```typescript
const csv = createCsvTool({ timeout: 10000 });

// Parse: { data: "a,b\n1,2", operation: "parse" }
// Stringify: { data: [["a","b"],["1","2"]], operation: "stringify" }
```

### createMarkdownTool(options?)

Convert Markdown to HTML (GFM subset).

```typescript
const markdown = createMarkdownTool({ timeout: 10000 });

// Example: { markdown: "# Hello\n**bold**" }
// Returns: { html: "<h1>Hello</h1>\n<p><strong>bold</strong></p>" }
// Supports: headers, bold, italic, links, code, lists, tables
```

### createXmlTool(options?)

Parse XML to JSON with XPath-like queries.

```typescript
const xml = createXmlTool({ timeout: 10000 });

// Example: { xml: "<root><item>1</item></root>", query: "/root/item" }
// Supports: elements, attributes, CDATA, comments
```

### createDatetimeTool(options?)

Date/time operations with UTC and offset timezone support.

```typescript
const datetime = createDatetimeTool({ timeout: 10000 });

// Parse: { date: "2024-01-15", operation: "parse" }
// Format: { date: "2024-01-15T10:30:00Z", operation: "format", format: "YYYY-MM-DD" }
// Add: { date: "2024-01-15", operation: "add", amount: 7, unit: "days" }
// Diff: { date: "2024-01-01", operation: "diff", endDate: "2024-01-15", unit: "days" }
```

### createCompressionTool(options?)

Gzip/deflate/zlib compression and decompression.

```typescript
const compression = createCompressionTool({ timeout: 30000 });

// Compress: { data: "hello", algorithm: "gzip", operation: "compress" }
// Decompress: { data: "H4sIAAAA...", algorithm: "gzip", operation: "decompress" }
// Returns base64-encoded compressed data with size info
```

### createSigningTool(options?)

Ed25519 digital signatures for message authentication.

```typescript
const signing = createSigningTool({ timeout: 10000 });

// Generate keypair: { operation: "generateKeypair", algorithm: "ed25519" }
// Sign: { operation: "sign", algorithm: "ed25519", message: "hello", privateKey: "..." }
// Verify: { operation: "verify", algorithm: "ed25519", message: "hello", publicKey: "...", signature: "..." }
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
