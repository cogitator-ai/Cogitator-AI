/**
 * The MCP server alone, without the MCP client: what a process that only serves tools imports.
 * The package root exports the same names.
 *
 * @example
 * ```ts
 * import { MCPServer } from '@cogitator-ai/mcp/server';
 *
 * const server = new MCPServer({ name: 'my-tools', version: '1.0.0', transport: 'stdio' });
 * server.registerTools(tools);
 * await server.start();
 * ```
 */
export { MCPServer, serveMCPTools } from './mcp-server';
export { InMemoryMCPTaskStore } from './tasks';
export type {
  MCPServerConfig,
  MCPCaller,
  MCPAuthFunction,
  MCPToolContext,
  MCPRequestInfo,
  MCPClientInfo,
  MCPResourceConfig,
  MCPPromptConfig,
  MCPServerTaskOptions,
  MCPProtectedResourceConfig,
  MCPTaskStore,
} from '../types';
