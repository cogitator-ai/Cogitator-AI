/**
 * @cogitator/mcp - MCP (Model Context Protocol) Integration
 *
 * This package provides full MCP support for Cogitator:
 * - MCPClient: Connect to external MCP servers and use their tools
 * - MCPServer: Expose Cogitator tools as an MCP server
 * - Tool Adapter: Convert between Cogitator and MCP tool formats
 */

export { MCPClient } from './client/mcp-client';
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
  MCPServerConfig,
  MCPTransportType,
  MCPResource,
  MCPResourceContent,
  MCPPrompt,
  MCPPromptArgument,
  MCPPromptMessage,
  MCPToolDefinition,
  MCPToolCallResult,
  MCPToolContent,
  ToolAdapterOptions,
  ConvertedTools,
} from './types';
