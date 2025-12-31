/**
 * MCP Client
 *
 * Connects to external MCP servers and provides access to their tools,
 * resources, and prompts.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@cogitator-ai/types';
import { createStdioTransport, createHttpTransport } from './transports';
import type {
  MCPClientConfig,
  MCPResource,
  MCPResourceContent,
  MCPPrompt,
  MCPPromptMessage,
  MCPToolDefinition,
} from '../types';
import { mcpToCogitator } from '../adapter/tool-adapter';

/**
 * MCP Client for connecting to external MCP servers
 *
 * @example
 * ```typescript
 * // Connect to a filesystem MCP server
 * const client = await MCPClient.connect({
 *   transport: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@anthropic/mcp-server-filesystem', '/allowed/path'],
 * });
 *
 * // Get available tools as Cogitator tools
 * const tools = await client.getTools();
 *
 * // Use them with an agent
 * const agent = new Agent({
 *   tools: [...tools],
 *   ...
 * });
 *
 * // Don't forget to disconnect
 * await client.close();
 * ```
 */
export class MCPClient {
  private client: Client;
  private transport: Transport;
  private connected = false;
  private serverCapabilities: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  } = {};

  private constructor(client: Client, transport: Transport) {
    this.client = client;
    this.transport = transport;
  }

  /**
   * Connect to an MCP server
   */
  static async connect(config: MCPClientConfig): Promise<MCPClient> {
    const client = new Client({
      name: config.clientName ?? 'cogitator-mcp-client',
      version: config.clientVersion ?? '1.0.0',
    });

    const transport = MCPClient.createTransport(config);
    const mcpClient = new MCPClient(client, transport);

    await mcpClient.initialize(config.timeout);
    return mcpClient;
  }

  /**
   * Create transport based on configuration
   */
  private static createTransport(config: MCPClientConfig): Transport {
    switch (config.transport) {
      case 'stdio':
        if (!config.command) {
          throw new Error('Command is required for stdio transport');
        }
        return createStdioTransport({
          command: config.command,
          args: config.args,
          env: config.env,
        });

      case 'http':
      case 'sse':
        if (!config.url) {
          throw new Error('URL is required for HTTP transport');
        }
        return createHttpTransport({
          url: config.url,
        });

      default:
        throw new Error(`Unknown transport type: ${config.transport}`);
    }
  }

  /**
   * Initialize connection and capabilities
   */
  private async initialize(timeout?: number): Promise<void> {
    const timeoutPromise = timeout
      ? new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), timeout)
        )
      : null;

    const connectPromise = this.client.connect(this.transport);

    if (timeoutPromise) {
      await Promise.race([connectPromise, timeoutPromise]);
    } else {
      await connectPromise;
    }

    this.connected = true;

    const serverInfo = this.client.getServerCapabilities();
    this.serverCapabilities = {
      tools: !!serverInfo?.tools,
      resources: !!serverInfo?.resources,
      prompts: !!serverInfo?.prompts,
    };
  }

  /**
   * Check if connected to server
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get server capabilities
   */
  getCapabilities(): typeof this.serverCapabilities {
    return { ...this.serverCapabilities };
  }

  /**
   * List available tools from the MCP server
   */
  async listToolDefinitions(): Promise<MCPToolDefinition[]> {
    if (!this.serverCapabilities.tools) {
      return [];
    }

    const result = await this.client.listTools();

    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as MCPToolDefinition['inputSchema'],
    }));
  }

  /**
   * Get MCP tools as Cogitator Tool instances
   *
   * These tools can be directly used with Cogitator agents.
   */
  async getTools(): Promise<Tool[]> {
    const definitions = await this.listToolDefinitions();
    return definitions.map((def) => mcpToCogitator(def, this));
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client.callTool({
      name,
      arguments: args,
    });

    const content = result.content;
    if (content && Array.isArray(content) && content.length > 0) {
      const firstContent = content[0];
      if (firstContent.type === 'text') {
        try {
          return JSON.parse(firstContent.text);
        } catch {
          return firstContent.text;
        }
      }
      return firstContent;
    }

    return result;
  }

  /**
   * List available resources from the MCP server
   */
  async listResources(): Promise<MCPResource[]> {
    if (!this.serverCapabilities.resources) {
      return [];
    }

    const result = await this.client.listResources();

    return result.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
  }

  /**
   * Read a resource from the MCP server
   */
  async readResource(uri: string): Promise<MCPResourceContent> {
    const result = await this.client.readResource({ uri });

    if (result.contents && result.contents.length > 0) {
      const content = result.contents[0];
      return {
        uri: content.uri,
        mimeType: content.mimeType,
        text: 'text' in content ? content.text : undefined,
        blob: 'blob' in content ? content.blob : undefined,
      };
    }

    return { uri };
  }

  /**
   * List available prompts from the MCP server
   */
  async listPrompts(): Promise<MCPPrompt[]> {
    if (!this.serverCapabilities.prompts) {
      return [];
    }

    const result = await this.client.listPrompts();

    return result.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments?.map((arg) => ({
        name: arg.name,
        description: arg.description,
        required: arg.required,
      })),
    }));
  }

  /**
   * Get a prompt from the MCP server
   */
  async getPrompt(
    name: string,
    args?: Record<string, string>
  ): Promise<MCPPromptMessage[]> {
    const result = await this.client.getPrompt({
      name,
      arguments: args,
    });

    return result.messages.map((msg) => {
      const content = msg.content;
      return {
        role: msg.role,
        content: {
          type: content.type as 'text' | 'image' | 'resource',
          text: content.type === 'text' ? content.text : undefined,
          data: content.type === 'image' ? content.data : undefined,
          mimeType: content.type === 'image' ? content.mimeType : undefined,
          resource:
            content.type === 'resource'
              ? {
                  uri: content.resource.uri,
                  text: 'text' in content.resource ? content.resource.text : undefined,
                  blob: 'blob' in content.resource ? content.resource.blob : undefined,
                }
              : undefined,
        },
      };
    });
  }

  /**
   * Close the connection to the MCP server
   */
  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

/**
 * Helper function to connect to an MCP server and get tools in one step
 *
 * @example
 * ```typescript
 * const { tools, cleanup } = await connectMCPServer({
 *   transport: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@anthropic/mcp-server-filesystem', '/path'],
 * });
 *
 * const agent = new Agent({ tools });
 *
 * // When done
 * await cleanup();
 * ```
 */
export async function connectMCPServer(config: MCPClientConfig): Promise<{
  client: MCPClient;
  tools: Tool[];
  cleanup: () => Promise<void>;
}> {
  const client = await MCPClient.connect(config);
  const tools = await client.getTools();

  return {
    client,
    tools,
    cleanup: () => client.close(),
  };
}
