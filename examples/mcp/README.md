# MCP Examples

[Model Context Protocol](https://modelcontextprotocol.io/) integration — connect to external MCP servers, discover their tools, and use them through Cogitator agents.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

You need an MCP server to connect to. The examples use the official filesystem server as a test target:

```bash
npx @modelcontextprotocol/server-filesystem /tmp
```

No need to run it manually — the example spawns it automatically via stdio transport.

## Examples

| #   | File               | Description                                              |
| --- | ------------------ | -------------------------------------------------------- |
| 01  | `01-mcp-client.ts` | Connect to MCP server, discover tools, use with an agent |

## Running

```bash
npx tsx examples/mcp/01-mcp-client.ts
```
