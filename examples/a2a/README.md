# A2A Protocol Examples

Agent-to-Agent protocol — expose agents as HTTP services and connect to them from other agents.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

## Examples

| #   | File               | Description                                           |
| --- | ------------------ | ----------------------------------------------------- |
| 01  | `01-a2a-server.ts` | Expose an agent as an A2A service on port 3100        |
| 02  | `02-a2a-client.ts` | Discover agent, send messages, bridge as a local tool |

## Running

Start the server in one terminal:

```bash
npx tsx examples/a2a/01-a2a-server.ts
```

Then run the client in another:

```bash
npx tsx examples/a2a/02-a2a-client.ts
```
