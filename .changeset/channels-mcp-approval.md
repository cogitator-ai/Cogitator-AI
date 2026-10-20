---
'@cogitator-ai/channels': minor
---

`mcpServers.<name>.requiresApproval` in the assistant config decides which tools of an MCP server ask approval in chat before they run: `true` for every call, `false` for none. Without it the tools the server marks destructive ask, as `getTools()` of `@cogitator-ai/mcp` now does by default.
