# @cogitator-ai/wasm-tools

WASM-based tools for Cogitator agents. Secure, sandboxed tool execution using WebAssembly.

## Features

- **14 pre-built tools** - calculator, JSON, hash, Base64, slug, validation, diff, regex, CSV, Markdown, XML, datetime, compression, Ed25519 signing
- **Isolated execution** - every call runs in an Extism sandbox in a worker thread, without filesystem or network access
- **Fast startup** - no container to start; compiled modules are cached per file
- **Custom tool framework** - `defineWasmTool()` for your own WASM modules
- **Hot-reload support** - `WasmToolManager` reloads modules when their files change

## Installation

```bash
pnpm add @cogitator-ai/wasm-tools
```

`@extism/extism` (>= 2.0.0-rc13, the current `latest` on npm) is installed as a dependency; the pre-built plugins are compiled with `extism-js` and need its host functions and WASI.

Website docs: [WASM Tools](https://cogitator.app/docs/tools/wasm-tools), [Sandbox](https://cogitator.app/docs/deployment/sandbox).

## How Tools Execute

Every tool created here carries a `sandbox: { type: 'wasm', ... }` config and a real `execute()`:

- **Inside Cogitator**: when `@cogitator-ai/sandbox` is available, Cogitator runs the module through its WASM executor (plugin pooling, worker-thread timeouts). Otherwise it falls back to the tool's own `execute()`.
- **Directly**: `await tool.execute(params, context)` validates `params` with the tool's Zod schema, runs the module in an Extism worker thread, enforces `timeout` (the worker is terminated) and honours `context.signal`. Compiled modules are cached per file and recompiled when the file changes.

```typescript
const calc = createCalcTool();
await calc.execute({ expression: '(2 + 3) * 4' }, { agentId: 'a', runId: 'r', signal });
// { result: 20, expression: '(2 + 3) * 4' }
```

Plugin-level errors are returned as data (`{ ..., error: '...' }`) so the agent can react; timeouts, aborts and invalid parameters reject the promise.

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
  model: 'openai/gpt-6.1-sol',
  instructions: 'Use your tools for calculations and data transformations.',
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

const cog = new Cogitator({
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});
const result = await cog.run(agent, {
  input: 'Calculate the SHA-256 hash of "hello world"',
});
```

### Custom WASM Tools

Create custom tools that run in the WASM sandbox:

```typescript
import { defineWasmTool } from '@cogitator-ai/wasm-tools';
import { Agent } from '@cogitator-ai/core';
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
  model: 'openai/gpt-6.1-sol',
  instructions: 'Hash text on request.',
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
  model: 'openai/gpt-6.1-sol',
  instructions: 'Use the loaded tools.',
  tools: manager.getTools(),
});

// Tools automatically use the latest plugin version after reload
const cogitator = new Cogitator({
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});
await cogitator.run(agent, { input: 'Calculate 2 + 2' });

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
  timeout?: number; // Execution timeout in ms (default 5000), also set as tool.timeout
  wasi?: boolean; // Enable WASI (required for modules compiled with extism-js)
}
```

`parameters` may use Zod transforms: the parsed (output) value is what the module receives, while `toJSON()` exposes the input schema to the LLM.

### createCalcTool(options?)

Create a calculator tool for mathematical expressions.

```typescript
const calc = createCalcTool({ timeout: 10000 });

// Supports: +, -, *, /, %, unary +/-, parentheses, decimals (".5", "2.")
// Example: "2 + 2 * 3" → { result: 8, expression: "2 + 2 * 3" }
// Errors (division by zero, malformed numbers, non-finite results) → { result: null, error }
```

### createJsonTool(options?)

Create a JSON processor tool with JSONPath query support.

```typescript
const json = createJsonTool({ timeout: 10000 });

// { json: '{"a": {"b": 1}}', query: '$.a.b' } → { result: 1, type: 'number', found: true }
// { json, query: '$.items[*].id' } → { result: [1, 2], type: 'array', found: true }
```

Supported JSONPath subset: `$`, `.key`, `['key']`, `[n]` (negative indexes allowed), `[start:end:step]`, `*` / `[*]`, and recursive descent `..key` / `..*`. Wildcards, slices and recursive descent always return an array. Missing paths return `{ result: null, type: 'undefined', found: false }`; filters (`[?()]`) and unions are rejected with an error.

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
// URL-safe: { text: "hello", operation: "encode", urlSafe: true } → "aGVsbG8" (no padding)
```

Decoding accepts both alphabets, optional padding and whitespace, rejects invalid characters/lengths with an error, and replaces invalid UTF-8 sequences with U+FFFD.

### createSlugTool(options?)

Generate URL-safe slugs from text with Unicode transliteration.

```typescript
const slug = createSlugTool({ timeout: 10000 });

// Example: { text: "Hello World!" } → "hello-world"
// Example: { text: "Привет мир", separator: "_" } → "privet_mir"
// Example: { text: "Crème brûlée, a/b" } → "creme-brulee-a-b"
```

Any run of non-alphanumeric characters becomes one separator; apostrophes are dropped; accents are stripped after transliteration. `maxLength` must be a positive integer and cuts at a separator when possible.

### createValidationTool(options?)

Validate common formats: email, URL, UUID, IPv4, IPv6.

```typescript
const validation = createValidationTool({ timeout: 10000 });

// Example: { value: "test@example.com", type: "email" } → { valid: true, normalized: "test@example.com" }
// Example: { value: "2001:DB8:0:0:0:0:0:1", type: "ipv6" } → { valid: true, normalized: "2001:db8::1" }
```

- **email**: dot-atom local part (no leading/trailing/consecutive dots, ≤ 64 chars), valid hostname labels; only the domain is lower-cased.
- **url**: `http`, `https`, `ftp`, `ftps`; userinfo, ports ≤ 65535 and bracketed IPv6 hosts are supported; whitespace and control characters are rejected. Missing schemes default to `https://`.
- **ipv4**: dotted quad without leading zeros (`01.2.3.4` is rejected, matching Node's `net.isIPv4`).
- **ipv6**: full RFC 4291 syntax including `::` and embedded IPv4; normalized to the RFC 5952 canonical form. Zone IDs are rejected.

### createDiffTool(options?)

Compare texts using Myers diff algorithm.

```typescript
const diff = createDiffTool({ timeout: 10000 });

// { original: "a\nb\n", modified: "a\nc\n" } →
// { diff: "--- original\n+++ modified\n@@ -1,2 +1,2 @@\n a\n-b\n+c", additions: 1, deletions: 1, changes: [...] }
```

`format` is `unified` (default, standard hunks with `context` lines, default 3), `inline` or `json`. A trailing newline is not treated as an extra line.

### createRegexTool(options?)

Safe regex operations with ReDoS protection.

```typescript
const regex = createRegexTool({ timeout: 10000 });

// Example: { text: "hello world", pattern: "\\w+", operation: "matchAll" }
// Supports: match, matchAll, test, replace, split
```

Patterns with nested unbounded quantifiers (e.g. `(a+)+`, `(\w+\s?)+`) are rejected up front. Other catastrophic patterns (e.g. overlapping alternations like `(a|aa)+$`) are stopped by the execution timeout, which terminates the worker.

### createCsvTool(options?)

RFC 4180 compliant CSV parsing and generation.

```typescript
const csv = createCsvTool({ timeout: 10000 });

// Parse: { data: "a,b\n1,2", operation: "parse", headers: true } → headers ["a","b"], result [["1","2"]]
// Stringify: { data: [["a","b"],["1","2"]], operation: "stringify", headers: ["x","y"] }
```

Quotes only open a quoted field at the start of a field; unterminated quotes and characters after a closing quote are errors. A UTF-8 BOM is ignored. For `parse`, `headers` may also be an array of column names. Objects are JSON-encoded when stringifying.

### createMarkdownTool(options?)

Convert Markdown to HTML (GFM subset).

```typescript
const markdown = createMarkdownTool({ timeout: 10000 });

// Example: { markdown: "# Hello\n**bold**" }
// Returns: { html: "<h1>Hello</h1>\n<p><strong>bold</strong></p>" }
// Supports: headings, emphasis, strikethrough, links, images, autolinks, code spans/blocks,
// lists (ordered with start number), blockquotes, rules, GFM tables with alignment, backslash escapes
```

`options.sanitize` defaults to `true`: raw HTML is escaped and link/image URLs with schemes other than `http`, `https`, `mailto`, `tel` and `ftp` (e.g. `javascript:`, `data:`) are replaced with `#`. Code content and generated attribute values are always escaped. Intraword underscores (`snake_case`) are not treated as emphasis.

### createXmlTool(options?)

Parse XML to JSON with XPath-like queries.

```typescript
const xml = createXmlTool({ timeout: 10000 });

// Example: { xml: "<root><item>1</item></root>", query: "/root/item" }
// Supports: elements, attributes, CDATA, comments
```

Query syntax: absolute paths start at the root element (`/root/item`), relative paths start below it (`item`), `//name` searches descendants, `*` matches any element, `name[2]` selects the 2nd match (1-based), `/@attr` (or `@*`) returns attribute values and `/text()` returns text content. One match returns a value, several return an array, none returns `{ result: null, type: 'empty' }`. Malformed documents (unclosed or mismatched tags, multiple roots, unterminated attributes) are errors; DTD entities are never expanded.

### createDatetimeTool(options?)

Date/time operations with UTC and offset timezone support.

```typescript
const datetime = createDatetimeTool({ timeout: 10000 });

// Parse: { date: "2024-01-15", operation: "parse" }
// Format: { date: "2024-01-15T10:30:00Z", operation: "format", format: "YYYY-MM-DD" }
// Add: { date: "2024-01-15", operation: "add", amount: 7, unit: "days" }
// Diff: { date: "2024-01-01", operation: "diff", endDate: "2024-01-15", unit: "days" }
```

- Accepts ISO dates (`2024-01-15`, `2024-01-15 10:30`, fractional seconds, `Z`/`+04:00`/`+0400`/`+04`), Unix timestamps (10 digits = seconds, 11-13 = ms) and anything `Date.parse` understands. Impossible dates such as `2023-02-29` are rejected.
- Month/year arithmetic clamps to the end of the month (`2024-01-31` + 1 month = `2024-02-29`).
- Format tokens: `YYYY MM DD HH mm ss SSS Z`, every occurrence is replaced; wrap literal text in brackets (`[at]`).
- `diff` returns whole units, truncated toward zero, negative when `endDate` is earlier.

### createCompressionTool(options?)

Gzip compression and decompression (RFC 1952), interoperable with zlib.

```typescript
const compression = createCompressionTool({ timeout: 30000 });

// Compress: { data: "hello", operation: "compress", level: 6 } → { result: "H4sI...", originalSize, resultSize, ratio }
// Decompress: { data: "H4sIAAAA...", operation: "decompress" } → { result: "hello", ... }
```

Defaults: `compress` reads UTF-8 and returns base64; `decompress` reads base64 and returns UTF-8. Use `inputEncoding`/`outputEncoding: 'base64'` for binary data. `level` is an integer 0-9. Decompression verifies the gzip CRC32 and size and is capped at 64 MB of output.

### createSigningTool(options?)

Ed25519 digital signatures for message authentication.

```typescript
const signing = createSigningTool({ timeout: 10000 });

// Generate keypair: { operation: "generateKeypair", algorithm: "ed25519" }
// Sign: { operation: "sign", algorithm: "ed25519", message: "hello", privateKey: "..." }
// Verify: { operation: "verify", algorithm: "ed25519", message: "hello", publicKey: "...", signature: "..." }
```

WASM has no secure random source, so the tool generates a 32-byte seed on the host with `node:crypto` when `generateKeypair` is called without `seed`; the seed is the private key. Keys and signatures use `encoding: 'hex'` (default) or `'base64'`. Signatures are RFC 8032 Ed25519 and interoperate with `node:crypto`; non-canonical or off-curve public keys fail verification. Empty messages are allowed.

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
  timeout?: number; // Per-call timeout in ms (default: 30000)
}

interface WasmToolCallbacks {
  onLoad?: (name: string, path: string) => void;
  onReload?: (name: string, path: string) => void;
  onUnload?: (name: string, path: string) => void;
  onError?: (name: string, path: string, error: Error) => void;
}

declare class WasmToolManager {
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

Manager tools call the module's exported `run` function with the JSON-encoded parameters. Plugins run in Extism worker threads: when a call times out or its `context.signal` aborts, the call rejects and the plugin is replaced with a fresh instance so the tool keeps working.

### Legacy Exports

For direct sandbox usage (pre-built modules are also reachable as `@cogitator-ai/wasm-tools/wasm/<name>.wasm`):

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

Build with (an interface file `my-tool.d.ts` declaring `declare module 'main' { export function run(): I32; }` lists the exports):

```bash
esbuild my-tool.ts --outfile=temp/my-tool.js --bundle --format=cjs --target=es2020
extism-js temp/my-tool.js -i my-tool.d.ts -o dist/my-tool.wasm
```

Modules compiled with `extism-js` embed QuickJS and require WASI: pass `wasi: true` to `defineWasmTool` (or `useWasi: true` to `WasmToolManager`).

The package build (`pnpm build`) compiles `src/plugins/*.ts` with `extism-js` when it is installed and fails if any plugin fails to compile. Without `extism-js` it writes empty placeholder `.wasm` files; executing a tool then fails with a clear "placeholder build" error.

## Security

WASM tools run in a secure Extism sandbox:

- ❌ No filesystem access (no directories are pre-opened, even with WASI)
- ❌ No network access (no allowed hosts)
- ✅ Timeout enforcement (the worker thread is terminated)
- ✅ Abort support via `ToolContext.signal`
- ✅ Isolated linear memory per plugin instance

## License

MIT
