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
  MCPRetryConfig,
} from '../types';
import { mcpToCogitator } from '../adapter/tool-adapter';

const DEFAULT_RETRY_CONFIG: Required<MCPRetryConfig> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  retryOnConnectionLoss: true,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnectionError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('connection') ||
      msg.includes('disconnected') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('epipe') ||
      msg.includes('closed')
    );
  }
  return false;
}

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
  private reconnecting = false;
  private config: MCPClientConfig;
  private retryConfig: Required<MCPRetryConfig>;
  private serverCapabilities: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  } = {};

  private constructor(client: Client, transport: Transport, config: MCPClientConfig) {
    this.client = client;
    this.transport = transport;
    this.config = config;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry };
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
    const mcpClient = new MCPClient(client, transport, config);

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
    const connectPromise = this.client.connect(this.transport);

    if (timeout) {
      let timer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Connection timeout')), timeout);
      });

      try {
        await Promise.race([connectPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer!);
      }
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
   * Check if currently reconnecting
   */
  isReconnecting(): boolean {
    return this.reconnecting;
  }

  /**
   * Attempt to reconnect to the server
   */
  async reconnect(): Promise<void> {
    if (this.reconnecting) {
      throw new Error('Already reconnecting');
    }

    this.reconnecting = true;
    let lastError: Error | undefined;

    try {
      for (let attempt = 1; attempt <= this.retryConfig.maxRetries; attempt++) {
        this.config.onReconnecting?.(attempt);

        try {
          await this.client.close().catch(() => {});

          this.client = new Client({
            name: this.config.clientName ?? 'cogitator-mcp-client',
            version: this.config.clientVersion ?? '1.0.0',
          });
          this.transport = MCPClient.createTransport(this.config);

          await this.initialize(this.config.timeout);
          this.config.onReconnected?.();
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          if (attempt < this.retryConfig.maxRetries) {
            const delay = Math.min(
              this.retryConfig.initialDelay *
                Math.pow(this.retryConfig.backoffMultiplier, attempt - 1),
              this.retryConfig.maxDelay
            );
            await sleep(delay);
          }
        }
      }

      this.config.onReconnectFailed?.(lastError ?? new Error('Reconnection failed'));
      throw lastError;
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Execute an operation with retry logic
   */
  private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const shouldRetry = attempt < this.retryConfig.maxRetries;
        const isConnError = isConnectionError(error);

        if (
          isConnError &&
          this.retryConfig.retryOnConnectionLoss &&
          this.config.autoReconnect !== false
        ) {
          this.connected = false;

          if (shouldRetry) {
            try {
              await this.reconnect();
              continue;
            } catch {
              throw lastError;
            }
          }
        }

        if (shouldRetry && !isConnError) {
          const delay = Math.min(
            this.retryConfig.initialDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt),
            this.retryConfig.maxDelay
          );
          await sleep(delay);
          continue;
        }

        throw lastError;
      }
    }

    throw (
      lastError ?? new Error(`${operationName} failed after ${this.retryConfig.maxRetries} retries`)
    );
  }

  /**
   * List available tools from the MCP server
   */
  async listToolDefinitions(): Promise<MCPToolDefinition[]> {
    if (!this.serverCapabilities.tools) {
      return [];
    }

    return this.withRetry(async () => {
      const result = await this.client.listTools();

      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as MCPToolDefinition['inputSchema'],
      }));
    }, 'listToolDefinitions');
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
   * Call a tool on the MCP server with automatic retry on failure
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.withRetry(async () => {
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
    }, `callTool:${name}`);
  }

  /**
   * List available resources from the MCP server with automatic retry
   */
  async listResources(): Promise<MCPResource[]> {
    if (!this.serverCapabilities.resources) {
      return [];
    }

    return this.withRetry(async () => {
      const result = await this.client.listResources();

      return result.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    }, 'listResources');
  }

  /**
   * Read a resource from the MCP server with automatic retry
   */
  async readResource(uri: string): Promise<MCPResourceContent> {
    return this.withRetry(async () => {
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
    }, `readResource:${uri}`);
  }

  /**
   * List available prompts from the MCP server with automatic retry
   */
  async listPrompts(): Promise<MCPPrompt[]> {
    if (!this.serverCapabilities.prompts) {
      return [];
    }

    return this.withRetry(async () => {
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
    }, 'listPrompts');
  }

  /**
   * Get a prompt from the MCP server with automatic retry
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<MCPPromptMessage[]> {
    return this.withRetry(async () => {
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
    }, `getPrompt:${name}`);
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
