# Integration Examples

Framework integrations — expose Cogitator agents as HTTP APIs, use with OpenAI SDK, or bridge with Vercel AI SDK.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

## Examples

| #   | File                    | Port | Description                                 |
| --- | ----------------------- | ---- | ------------------------------------------- |
| 01  | `01-express-server.ts`  | 3100 | Express REST API with CogitatorServer       |
| 02  | `02-fastify-server.ts`  | 3101 | Fastify plugin integration                  |
| 03  | `03-hono-server.ts`     | 3102 | Lightweight Hono server                     |
| 04  | `04-koa-server.ts`      | 3103 | Koa middleware integration                  |
| 05  | `05-nextjs-handler.ts`  | —    | Next.js App Router handler (reference file) |
| 06  | `06-openai-compat.ts`   | 8080 | OpenAI Assistants API compatible server     |
| 07  | `07-ai-sdk-adapter.ts`  | —    | Bidirectional Vercel AI SDK adapter         |
| 08  | `08-tetsu-server.ts`    | 3104 | Tetsu on Bun: users, own MCP server, agent  |
| 09  | `09-deno-server.ts`     | 3105 | Hono adapter on Deno                        |
| 10  | `10-cloudflare-worker/` | 8787 | Hono adapter on Cloudflare Workers          |

## Running

Server examples start an HTTP server you can test with curl:

```bash
npx tsx examples/integrations/01-express-server.ts
npx tsx examples/integrations/02-fastify-server.ts
npx tsx examples/integrations/03-hono-server.ts
npx tsx examples/integrations/04-koa-server.ts
npx tsx examples/integrations/06-openai-compat.ts
```

Example 05 is a reference file for Next.js projects — not directly runnable.

Example 07 demonstrates AI SDK adapter usage and runs as a script.

Example 08 runs on Bun, since Tetsu is a Bun framework:

```bash
bun examples/integrations/08-tetsu-server.ts
```

It starts an app with two users (`token-ada`, `token-grace`), its own MCP server for their tasks, and an agent that reads and adds tasks for whoever is signed in. API docs are at `http://localhost:3104/docs`.

Example 09 runs on Deno with network access and the API key only:

```bash
deno run --allow-net --allow-env=GOOGLE_API_KEY,PORT examples/integrations/09-deno-server.ts
```

Example 10 is a standalone Cloudflare Workers project that installs the published packages — see its [README](./10-cloudflare-worker/README.md).

## Testing with curl

Once a server is running:

```bash
# health check
curl http://localhost:3100/cogitator/health

# list agents
curl http://localhost:3100/cogitator/agents

# run an agent
curl -X POST http://localhost:3100/cogitator/agents/assistant/run \
  -H 'Content-Type: application/json' \
  -d '{"input": "What is 2+2?"}'
```

Adjust the port for each framework (3100–3103, 8080).
