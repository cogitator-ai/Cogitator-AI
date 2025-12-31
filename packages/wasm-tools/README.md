# @cogitator/wasm-tools

WASM-based tools for Cogitator agents. Secure, sandboxed tool execution using WebAssembly.

## Installation

```bash
pnpm add @cogitator/wasm-tools
```

## Usage

### Built-in WASM Tools

```typescript
import { wasmCalculator, wasmJsonProcessor } from '@cogitator/wasm-tools';

// Calculator - safe math expression evaluation
const calc = wasmCalculator();
const result = await calc.execute({ expression: '2 + 2 * 3' });
// { result: 8 }

// JSON Processor - JSONPath queries
const json = wasmJsonProcessor();
const data = await json.execute({
  json: '{"users": [{"name": "Alice"}, {"name": "Bob"}]}',
  query: '$.users[*].name',
});
// { result: ["Alice", "Bob"] }
```

### Use with Cogitator

```typescript
import { Cogitator, Agent } from '@cogitator/core';
import { wasmCalculator, wasmJsonProcessor } from '@cogitator/wasm-tools';

const agent = new Agent({
  name: 'data-processor',
  tools: [wasmCalculator(), wasmJsonProcessor()],
});
```

### Custom WASM Tools

Build custom WASM tools using Extism PDK:

```typescript
// tool.ts
import { Input, Output } from '@extism/js-pdk';

export function run() {
  const input = JSON.parse(Input.string());
  const result = processData(input);
  Output.set(JSON.stringify(result));
}
```

Build with:

```bash
npx @anthropic/extism-js tool.ts -o tool.wasm
```

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
