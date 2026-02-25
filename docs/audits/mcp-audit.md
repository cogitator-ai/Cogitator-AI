# Audit: @cogitator-ai/mcp

Started: 2026-02-25

## Status

Complete
Last updated: 2026-02-25

## Completed Steps

### 1. Build ✅

No issues. Build passes cleanly.

### 2. Lint ✅

No lint errors in mcp package.

### 3. Remove comments ✅

No comments to remove.

### 4. Full source review ✅

Found and fixed 6 issues:

- **index.ts**: `toolSchemaToMCP`, `mcpContentToResult`, `resultToMCPContent`, `serveMCPTools`, `StdioTransportConfig`, `HttpTransportConfig` — missing exports. Added.
- **transports.ts:73-75**: `createHttpTransport` ignored `headers` config. Fixed to pass via `requestInit`.
- **mcp-client.ts:144-156**: Timeout timer never cleared on successful connect (race condition). Fixed with try/finally + clearTimeout.
- **mcp-server.ts unregister methods**: `unregisterTool`/`unregisterResource`/`unregisterPrompt` only removed from internal Map but not from underlying McpServer (which doesn't support unregistration). Added guard to throw after `start()` to prevent misleading behavior.
- **package.json**: `@types/node` was in `dependencies` instead of `devDependencies`. Moved.

### 5. Exports check ✅

All public API items exported. Fixed missing exports in step 4 (toolSchemaToMCP, mcpContentToResult, resultToMCPContent, serveMCPTools, StdioTransportConfig, HttpTransportConfig).

### 6. Dependencies check ✅

- `@cogitator-ai/types`: used in types.ts, mcp-server.ts, tool-adapter.ts ✅
- `@modelcontextprotocol/sdk`: used in mcp-client.ts, transports.ts, mcp-server.ts ✅
- `zod`: used in mcp-server.ts, tool-adapter.ts ✅
- `@types/node` moved to devDependencies ✅
- No unused deps, no missing deps.

### 7. Unit tests exist ✅

4 test files cover all source modules (added transports.test.ts).

### 8. Unit tests pass ✅

88 tests pass across 4 test files.

### 9. E2E tests exist ✅

1 e2e test file with 4 tests, all pass. Covers tool adapter round-trip conversion.

### 10. Test coverage gaps ✅

Added 28 new tests (60 → 88 total):

- New `transports.test.ts` (7 tests): env merging, headers passthrough, cwd
- `server.test.ts` (+3 tests): unregister-after-start for tools/resources/prompts
- `tool-adapter.test.ts` (+14 tests): toolSchemaToMCP, jsonSchemaToZod edge cases (boolean, null, regex, url, single enum, mixed enum, empty object, unknown type, array without items, descriptions, non-object schema)
- `client.test.ts` (+4 tests): sse transport alias, unknown transport, close idempotency, isReconnecting

### 11. Package README ✅

Comprehensive README with full API docs, examples, and type references. Updated unregister method docs to note "only before start()".

### 12. Root README ✅

Package listed in packages table, examples table, and npm packages list.

### 13. Docs site ✅

`packages/dashboard/content/docs/integrations/mcp.mdx` exists with comprehensive content covering MCPClient, MCPServer, Tool Adapter, and Claude Desktop integration.

### 14. Examples ✅

`examples/mcp/01-mcp-client.ts` exists — demonstrates full MCP client workflow.

### 15. CLAUDE.md ✅

Package listed in Architecture section: `├── mcp/ # @cogitator-ai/mcp - Model Context Protocol client`

## Insights & Notes

- MCP SDK v1.25 uses `StreamableHTTPClientTransport` which accepts `requestInit` for custom headers, not raw headers param
- `McpServer` from the SDK doesn't support unregistering tools/resources/prompts at runtime — registration is one-way
- Stateless HTTP mode (sessionIdGenerator: undefined) is the correct pattern for per-request transport creation on the server side
- Package is well-structured with clean separation: client/, server/, adapter/ subdirectories
