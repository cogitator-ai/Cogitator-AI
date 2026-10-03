---
'@cogitator-ai/mcp': minor
---

`serveAgents(cog, agents, config)` serves Cogitator agents as MCP tools in one call — stdio for Claude Desktop, Cursor and Claude Code, or HTTP with `auth` for remote, per-user use; `agentTools()` returns the same tools for your own `MCPServer`. Tools that need approval are asked from the person at the client through MCP elicitation (`MCPToolContext.elicit`); clients without it get a paused answer and an `<agent>_resume` tool. `MCPServer` gains `sessions: true` (a session per client over HTTP, which server-to-client requests need; a session belongs to the caller that started it).
