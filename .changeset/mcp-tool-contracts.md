---
'@cogitator-ai/mcp': minor
---

MCP tool calls are no longer sent again after a timeout or a lost connection unless the tool is read-only or idempotent: the server may still be running the first call, so `callTool` throws `MCPToolInterruptedError` instead of deploying twice. Tool definitions keep their `annotations`, and tools from `getTools()` / `wrapMCPTools()` retry only when the server marks them `readOnlyHint` or `idempotentHint` (`callTool` takes `idempotent: true` for your own calls). Tool names are normalized to what every LLM provider accepts, with collisions kept apart by a hash (`normalizeMCPToolName`), so a server with `admin.list_users` no longer breaks every request. Input schemas keep their `$defs` and resolve `$ref`, recursive ones included, instead of showing the model `{}`. Images, audio and binary resources come through as `toolContent()` media in both directions instead of base64 text.
