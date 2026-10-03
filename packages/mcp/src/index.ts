/**
 * @cogitator-ai/mcp - MCP (Model Context Protocol) Integration
 *
 * This package provides full MCP support for Cogitator:
 * - MCPClient: Connect to external MCP servers and use their tools
 * - MCPServer: Expose Cogitator tools as an MCP server
 * - Tool Adapter: Convert between Cogitator and MCP tool formats
 */

export { MCPClient, MCPToolError, connectMCPServer } from './client/mcp-client';
export { createStdioTransport, createHttpTransport } from './client/transports';
export type { StdioTransportConfig, HttpTransportConfig } from './client/transports';

export { MCPServer, serveMCPTools } from './server/mcp-server';
export { serveAgents, agentTools } from './server/serve-agents';
export type { AgentHost, AgentToolAnswer, ServeAgentsConfig } from './server/serve-agents';

export {
  cogitatorToMCP,
  toolSchemaToMCP,
  mcpToCogitator,
  wrapMCPTools,
  zodToJsonSchema,
  jsonSchemaToZod,
  resultToMCPContent,
  mcpContentToResult,
} from './adapter/tool-adapter';

export type {
  MCPClientConfig,
  MCPCallToolOptions,
  MCPRetryConfig,
  MCPServerConfig,
  MCPCaller,
  MCPAuthFunction,
  MCPToolContext,
  MCPElicitRequest,
  MCPElicitResult,
  MCPElicitField,
  MCPTransportType,
  MCPResource,
  MCPResourceContent,
  MCPResourceReadContent,
  MCPResourceConfig,
  MCPPrompt,
  MCPPromptArgument,
  MCPPromptArgumentConfig,
  MCPPromptMessage,
  MCPPromptReplyMessage,
  MCPPromptConfig,
  MCPPromptResult,
  MCPToolDefinition,
  MCPToolCallResult,
  MCPToolContent,
  ToolAdapterOptions,
} from './types';
