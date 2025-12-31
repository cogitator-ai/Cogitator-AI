/**
 * MCP Integration Types
 */

import type { Tool } from '@cogitator-ai/types';

export type MCPTransportType = 'stdio' | 'http' | 'sse';

export interface MCPClientConfig {
  /** Transport type */
  transport: MCPTransportType;

  /** For stdio transport: command to spawn */
  command?: string;

  /** For stdio transport: command arguments */
  args?: string[];

  /** For stdio transport: environment variables */
  env?: Record<string, string>;

  /** For HTTP transport: server URL */
  url?: string;

  /** Connection timeout in ms */
  timeout?: number;

  /** Client name for identification */
  clientName?: string;

  /** Client version */
  clientVersion?: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: { uri: string; text?: string; blob?: string };
  };
}

export interface MCPServerConfig {
  /** Server name */
  name: string;

  /** Server version */
  version: string;

  /** Transport type */
  transport: MCPTransportType;

  /** For HTTP transport: port to listen on */
  port?: number;

  /** For HTTP transport: host to bind to */
  host?: string;

  /** Enable logging */
  logging?: boolean;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPToolCallResult {
  content: MCPToolContent[];
  isError?: boolean;
}

export type MCPToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: MCPResourceContent };

export interface ToolAdapterOptions {
  /** Prefix to add to converted tool names */
  namePrefix?: string;

  /** Transform tool description */
  descriptionTransform?: (description: string) => string;
}

/**
 * Result of converting MCP tools to Cogitator tools
 */
export interface ConvertedTools {
  tools: Tool[];
  cleanup: () => Promise<void>;
}
