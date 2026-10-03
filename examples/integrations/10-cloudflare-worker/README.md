# Cogitator on Cloudflare Workers

The Hono adapter as a Worker: `POST /agents/assistant/run` and `POST /agents/assistant/stream` (SSE).

```bash
npm install
echo "GOOGLE_API_KEY=..." > .dev.vars
npm run dev
```

```bash
curl -X POST http://localhost:8787/agents/assistant/run \
  -H 'Content-Type: application/json' -d '{"input": "What is 123 * 456?"}'
```

Deploy with `npx wrangler secret put GOOGLE_API_KEY` and `npm run deploy`.

Threads live in the isolate's memory, which Workers recycle at will. For conversations that last, use the Postgres memory adapter — and create the `Cogitator` per request, because Workers do not let one request use a connection another request opened:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const cogitator = new Cogitator({
      llm: { providers: { google: { apiKey: env.GOOGLE_API_KEY } } },
      memory: { adapter: 'postgres', postgres: { connectionString: env.DATABASE_URL } },
    });
    const response = await cogitatorApp({ cogitator, agents: { assistant } }).fetch(
      request,
      env,
      ctx
    );
    ctx.waitUntil(
      response
        .clone()
        .arrayBuffer()
        .then(() => cogitator.close())
    );
    return response;
  },
};
```

The `exec` and file system tools, device tools and the Docker sandbox need a Node.js server — see [Edge Runtimes](https://cogitator.app/docs/deployment/edge).
