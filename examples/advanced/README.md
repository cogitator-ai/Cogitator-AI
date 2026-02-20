# Advanced Examples

Advanced features — self-modifying agents, neuro-symbolic reasoning, and WASM-sandboxed tools.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

## Examples

| #   | File                   | Description                                                                    |
| --- | ---------------------- | ------------------------------------------------------------------------------ |
| 01  | `01-self-modifying.ts` | Self-modifying agent: gap analysis, tool generation, checkpoints, and rollback |
| 02  | `02-neuro-symbolic.ts` | Logic programming, constraint solving, and planning with formal verification   |
| 03  | `03-wasm-tools.ts`     | WASM-sandboxed tools for safe computation: calc, hash, regex, CSV, and more    |

## Running

```bash
npx tsx examples/advanced/01-self-modifying.ts
npx tsx examples/advanced/02-neuro-symbolic.ts
npx tsx examples/advanced/03-wasm-tools.ts
```
