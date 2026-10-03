---
'@cogitator-ai/mcp': minor
---

`MCPServer` authenticates HTTP callers. The new `auth(request)` option returns the caller (`{ userId, scopes, metadata }`) or `undefined` to answer 401; the caller's `userId` reaches tools as `context.userId`, and resource `read` and prompt `get` handlers receive the caller as a second argument. `Authorization` is allowed in CORS requests. With an MCP client per user, connected with that user's token, one agent acts for each user on your own MCP server — see `examples/mcp/03-per-user-mcp.ts`.
