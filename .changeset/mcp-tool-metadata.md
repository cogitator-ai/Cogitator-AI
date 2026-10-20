---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/mcp': minor
---

Tools carry a `title`, an `outputSchema` and MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and they cross MCP in both directions. `getTools()` / `wrapMCPTools()` keep the server's title (or the title of its annotations), its hints and its output schema, as a zod schema of the result. `MCPServer` and `cogitatorToMCP()` advertise a tool's title, hints and object output schema, and the server sends the result of such a tool as `structuredContent`, with its JSON as text for clients that read only `content`. A result the output schema rejects comes back as a tool error that says why. An output schema whose root is not an object is not advertised, since MCP takes only object output schemas. Nothing checks the output schema in a run.

A tool the server marks destructive (`destructiveHint: true` without `readOnlyHint: true`) now needs approval: a Cogitator run pauses before it runs, and `invokeTool` asks `onApproval`. The new `requiresApproval` adapter option takes `true` (every tool), `false` (none) or a function of the MCP definition, and `isDestructiveMCPTool()` is the default check. A tool without the hint is not taken as destructive, although MCP's own default for a missing hint is `true`.

`withParsedArguments(tool)` from core keeps a tool's approval, sandbox, timeout and result limit with a pass-through schema, for running through `invokeTool` a call whose arguments were already parsed with the tool's own schema. `MCPServer` uses it.

**Migration:** agents whose MCP servers mark tools destructive now pause for approval before calling them. Approve them in your approval flow (`onApproval`, `cogitator.resume()`, the channels approvals), or pass `{ requiresApproval: false }` to `getTools()` / `wrapMCPTools()` for a server you trust (`requiresApproval: false` under `mcpServers.<name>` in a channels assistant config). Code that builds `MCPToolDefinition` objects by hand is unaffected, the new `title` and `outputSchema` fields are optional.
