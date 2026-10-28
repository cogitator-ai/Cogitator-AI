/**
 * @cogitator-ai/mcp - MCP (Model Context Protocol) Integration
 *
 * This package provides full MCP support for Cogitator:
 * - MCPClient: Connect to external MCP servers and use their tools (protocol 2026-07-28 and 2025-11-25)
 * - MCPServer: Expose Cogitator tools as an MCP server
 * - Tool Adapter: Convert between Cogitator and MCP tool formats
 */

export {
  MCPClient,
  MCPToolError,
  MCPToolInterruptedError,
  connectMCPServer,
} from './client/mcp-client';
export { MCPTaskEndedError, InMemoryMCPClientTaskStore } from './client/tasks';
export { InMemoryMCPClientRoundStore } from './client/rounds';
export {
  createMCPOAuthProvider,
  InMemoryMCPOAuthStore,
  type MCPOAuthProvider,
  type MCPOAuthProviderOptions,
} from './client/oauth';
export { createStdioTransport, createHttpTransport, createSseTransport } from './client/transports';
export {
  experimental_mcpConnector,
  mcpClientConfigOf,
  type McpConnectorOptions,
} from './client/connector';
export type { StdioTransportConfig, HttpTransportConfig } from './client/transports';

export { MCPServer, serveMCPTools } from './server/mcp-server';
export { InMemoryMCPTaskStore } from './server/tasks';
export { serveAgents, agentTools } from './server/serve-agents';
export type {
  AgentHost,
  AgentToolAnswer,
  AgentToolsOptions,
  ServeAgentsConfig,
} from './server/serve-agents';

export {
  cogitatorToMCP,
  toolSchemaToMCP,
  mcpToCogitator,
  wrapMCPTools,
  normalizeMCPToolName,
  isDestructiveMCPTool,
  zodToJsonSchema,
  jsonSchemaToZod,
  jsonSchemaValueToZod,
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
  MCPElicitOption,
  MCPElicitMultiSelect,
  MCPTransportType,
  MCPClientTransportType,
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
  MCPObjectSchema,
  MCPToolAnnotations,
  MCPToolCallResult,
  MCPToolContent,
  MCPJsonSchema,
  MCPProtocolMode,
  MCPProtocolEra,
  MCPElicitUrlRequest,
  MCPElicitationHandler,
  MCPElicitationSource,
  MCPClientTaskOptions,
  MCPClientTaskRecord,
  MCPClientTaskStore,
  MCPAskedInput,
  MCPClientRoundRecord,
  MCPClientRoundStore,
  MCPClientRoundOptions,
  MCPOAuthConfig,
  MCPOAuthStore,
  MCPSubscription,
  MCPSubscriptionFilter,
  MCPSubscriptionHandlers,
  MCPServerDiscovery,
  MCPToolInput,
  MCPInputPending,
  MCPServerTaskOptions,
  MCPProtectedResourceConfig,
  MCPTaskStatus,
  MCPTaskRecord,
  MCPTaskInputRequest,
  MCPTaskStore,
  ToolAdapterOptions,
} from './types';
