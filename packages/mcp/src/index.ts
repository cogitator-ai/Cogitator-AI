/**
 * @cogitator-ai/mcp - MCP (Model Context Protocol) Integration
 *
 * This package provides full MCP support for Cogitator:
 * - MCPClient: Connect to external MCP servers and use their tools
 * - MCPServer: Expose Cogitator tools as an MCP server
 * - Tool Adapter: Convert between Cogitator and MCP tool formats
 */

export { MCPClient, connectMCPServer } from './client/mcp-client';
export { createStdioTransport, createHttpTransport } from './client/transports';

export { MCPServer } from './server/mcp-server';

export {
  cogitatorToMCP,
  mcpToCogitator,
  wrapMCPTools,
  zodToJsonSchema,
  jsonSchemaToZod,
} from './adapter/tool-adapter';

export type {
  MCPClientConfig,
  MCPRetryConfig,
  MCPServerConfig,
  MCPTransportType,
  MCPResource,
  MCPResourceContent,
  MCPResourceConfig,
  MCPPrompt,
  MCPPromptArgument,
  MCPPromptArgumentConfig,
  MCPPromptMessage,
  MCPPromptConfig,
  MCPPromptResult,
  MCPToolDefinition,
  MCPToolCallResult,
  MCPToolContent,
  ToolAdapterOptions,
  ConvertedTools,
} from './types';
