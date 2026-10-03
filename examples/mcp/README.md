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

| #   | File                        | Description                                                                             |
| --- | --------------------------- | --------------------------------------------------------------------------------------- |
| 01  | `01-mcp-client.ts`          | Connect to MCP server, discover tools, use with an agent                                |
| 02  | `02-mcp-server.ts`          | Expose Cogitator tools over HTTP, call them from an MCP client and an agent             |
| 03  | `03-per-user-mcp.ts`        | An agent on your own MCP server: bearer tokens, tools acting per user, thread isolation |
| 04  | `04-agent-as-mcp-server.ts` | Serve a Cogitator agent as an MCP tool in one line (Claude Desktop, Cursor, any client) |

## Running

```bash
npx tsx examples/mcp/01-mcp-client.ts
npx tsx examples/mcp/02-mcp-server.ts
npx tsx examples/mcp/03-per-user-mcp.ts
npx tsx examples/mcp/04-agent-as-mcp-server.ts
```
