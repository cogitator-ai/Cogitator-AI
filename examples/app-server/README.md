# App-server Examples

The typed JSON-RPC app-server of `@cogitator-ai/app-server`: threads, turns, steering and approvals over NDJSON, with the client generated from the protocol's schemas.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY, or use Ollama with --spawn
```

## Examples

| #   | File           | Description                                                                            |
| --- | -------------- | -------------------------------------------------------------------------------------- |
| 01  | `01-client.ts` | The generated client against a host in the process, or `cogitator app-server` on stdio |

## Running

```bash
npx tsx examples/app-server/01-client.ts
COGITATOR_MODEL=ollama/qwen3:8b COGITATOR_CLI=packages/cli/dist/index.js \
  npx tsx examples/app-server/01-client.ts --spawn
```
