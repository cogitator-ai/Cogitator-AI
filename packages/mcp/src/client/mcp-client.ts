/**
 * MCP Client
 *
 * Connects to external MCP servers and provides access to their tools,
 * resources, and prompts.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@cogitator-ai/types';
import { createStdioTransport, createHttpTransport } from './transports';
import type {
  MCPClientConfig,
  MCPResource,
  MCPResourceContent,
  MCPPrompt,
  MCPPromptMessage,
  MCPToolDefinition,
  MCPToolContent,
  MCPRetryConfig,
  MCPCallToolOptions,
} from '../types';
import { mcpToCogitator, mcpContentToResult } from '../adapter/tool-adapter';

const DEFAULT_RETRY_CONFIG: Required<MCPRetryConfig> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  retryOnConnectionLoss: true,
};

const CONNECTION_CLOSED_CODE: number = ErrorCode.ConnectionClosed;
const REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Error raised when an MCP server reports a tool failure (`isError: true`).
 * Tool failures are deterministic results, so they are never retried.
 */
export class MCPToolError extends Error {
  readonly toolName: string;
  readonly content: MCPToolContent[];

  constructor(toolName: string, content: MCPToolContent[]) {
    const text = content
      .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    super(text || `MCP tool "${toolName}" failed`);
    this.name = 'MCPToolError';
    this.toolName = toolName;
    this.content = content;
  }
}

function isConnectionError(error: unknown): boolean {
  if (error instanceof McpError) {
    return error.code === CONNECTION_CLOSED_CODE;
  }
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

function isRetryableError(error: unknown): boolean {
  if (error instanceof MCPToolError) {
    return false;
  }
  if (error instanceof McpError) {
    return error.code === CONNECTION_CLOSED_CODE || error.code === REQUEST_TIMEOUT_CODE;
  }
  return true;
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
  private closed = false;
  private reconnectPromise: Promise<void> | null = null;
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
          cwd: config.cwd,
        });

      case 'http':
      case 'sse':
        if (!config.url) {
          throw new Error('URL is required for HTTP transport');
        }
        return createHttpTransport({
          url: config.url,
          headers: config.headers,
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (timeout) {
        await Promise.race([
          connectPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Connection timeout')), timeout);
          }),
        ]);
      } else {
        await connectPromise;
      }
    } catch (error) {
      await this.client.close().catch(() => {});
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
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
    return this.reconnectPromise !== null;
  }

  /**
   * Attempt to reconnect to the server.
   *
   * Concurrent callers share the same in-flight reconnection, so parallel
   * operations that all observe a dropped connection wait for one reconnect
   * instead of failing.
   */
  reconnect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('MCP client has been closed'));
    }
    if (!this.reconnectPromise) {
      this.reconnectPromise = this.performReconnect().finally(() => {
        this.reconnectPromise = null;
      });
    }
    return this.reconnectPromise;
  }

  private async performReconnect(): Promise<void> {
    let lastError: Error | undefined;
    this.connected = false;

    const maxAttempts = Math.max(1, this.retryConfig.maxRetries);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.closed) {
        throw new Error('MCP client has been closed');
      }
      this.config.onReconnecting?.(attempt);

      try {
        await this.client.close().catch(() => {});

        this.client = new Client({
          name: this.config.clientName ?? 'cogitator-mcp-client',
          version: this.config.clientVersion ?? '1.0.0',
        });
        this.transport = MCPClient.createTransport(this.config);

        await this.initialize(this.config.timeout);
        if (this.closed) {
          this.connected = false;
          await this.client.close().catch(() => {});
          throw new Error('MCP client has been closed');
        }
        this.config.onReconnected?.();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (this.closed) {
          throw lastError;
        }

        if (attempt < maxAttempts) {
          const delay = Math.min(
            this.retryConfig.initialDelay *
              Math.pow(this.retryConfig.backoffMultiplier, attempt - 1),
            this.retryConfig.maxDelay
          );
          await sleep(delay);
        }
      }
    }

    const failure = lastError ?? new Error('Reconnection failed');
    this.config.onReconnectFailed?.(failure);
    throw failure;
  }

  /**
   * Execute an operation with retry logic
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      if (this.closed) {
        throw new Error(`${operationName} failed: MCP client has been closed`);
      }
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (signal?.aborted || this.closed || !isRetryableError(error)) {
          throw lastError;
        }

        const shouldRetry = attempt < this.retryConfig.maxRetries;
        const isConnError = isConnectionError(error);

        if (isConnError) {
          this.connected = false;
        }

        if (
          isConnError &&
          this.retryConfig.retryOnConnectionLoss &&
          this.config.autoReconnect !== false
        ) {
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
          if (signal?.aborted) {
            throw lastError;
          }
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
      const tools: MCPToolDefinition[] = [];
      let cursor: string | undefined;

      do {
        const result = await this.client.listTools(cursor ? { cursor } : {});
        for (const tool of result.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema as MCPToolDefinition['inputSchema'],
          });
        }
        cursor = result.nextCursor;
      } while (cursor);

      return tools;
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
  /**
   * Call a tool on the MCP server with automatic retry on transient failures.
   *
   * Returns `structuredContent` when the server provides it, otherwise the
   * text/JSON value(s) of the content blocks. Throws {@link MCPToolError}
   * when the server reports `isError: true`; such failures are not retried.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: MCPCallToolOptions
  ): Promise<unknown> {
    return this.withRetry(
      async () => {
        const result = await this.client.callTool({ name, arguments: args }, undefined, {
          signal: options?.signal,
          timeout: options?.timeout,
        });

        const content = (Array.isArray(result.content) ? result.content : []) as MCPToolContent[];

        if (result.isError) {
          throw new MCPToolError(name, content);
        }

        if (result.structuredContent !== undefined) {
          return result.structuredContent;
        }

        if (content.length > 0) {
          return mcpContentToResult(content);
        }

        if ('toolResult' in result) {
          return result.toolResult;
        }

        return null;
      },
      `callTool:${name}`,
      options?.signal
    );
  }

  /**
   * List available resources from the MCP server with automatic retry
   */
  async listResources(): Promise<MCPResource[]> {
    if (!this.serverCapabilities.resources) {
      return [];
    }

    return this.withRetry(async () => {
      const resources: MCPResource[] = [];
      let cursor: string | undefined;

      do {
        const result = await this.client.listResources(cursor ? { cursor } : {});
        for (const resource of result.resources) {
          resources.push({
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType,
          });
        }
        cursor = result.nextCursor;
      } while (cursor);

      return resources;
    }, 'listResources');
  }

  /**
   * Read a resource from the MCP server with automatic retry.
   * Returns the first content entry; use {@link readResourceContents} for all of them.
   */
  async readResource(uri: string): Promise<MCPResourceContent> {
    const contents = await this.readResourceContents(uri);
    return contents[0] ?? { uri };
  }

  /**
   * Read every content entry of a resource (e.g. multi-part or templated resources)
   */
  async readResourceContents(uri: string): Promise<MCPResourceContent[]> {
    return this.withRetry(async () => {
      const result = await this.client.readResource({ uri });
      return (result.contents ?? []).map((content) => ({
        uri: content.uri,
        mimeType: content.mimeType,
        text: 'text' in content ? content.text : undefined,
        blob: 'blob' in content ? content.blob : undefined,
      }));
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
      const prompts: MCPPrompt[] = [];
      let cursor: string | undefined;

      do {
        const result = await this.client.listPrompts(cursor ? { cursor } : {});
        for (const prompt of result.prompts) {
          prompts.push({
            name: prompt.name,
            description: prompt.description,
            arguments: prompt.arguments?.map((arg) => ({
              name: arg.name,
              description: arg.description,
              required: arg.required,
            })),
          });
        }
        cursor = result.nextCursor;
      } while (cursor);

      return prompts;
    }, 'listPrompts');
  }

  /**
   * Get a prompt from the MCP server with automatic retry
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<MCPPromptMessage[]> {
    return this.withRetry(async () => {
      const result = await this.client.getPrompt({
        name,
        arguments: args ?? {},
      });

      return result.messages.map((msg) => {
        const content = msg.content;
        return {
          role: msg.role,
          content: toPromptContent(content),
        };
      });
    }, `getPrompt:${name}`);
  }

  /**
   * Close the connection to the MCP server
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.client.close();
    } finally {
      this.connected = false;
    }
  }
}

type SDKPromptContent = Awaited<ReturnType<Client['getPrompt']>>['messages'][number]['content'];

function toPromptContent(content: SDKPromptContent): MCPPromptMessage['content'] {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'image':
    case 'audio':
      return { type: content.type, data: content.data, mimeType: content.mimeType };
    case 'resource':
      return {
        type: 'resource',
        resource: {
          uri: content.resource.uri,
          mimeType: content.resource.mimeType,
          text: 'text' in content.resource ? content.resource.text : undefined,
          blob: 'blob' in content.resource ? content.resource.blob : undefined,
        },
      };
    case 'resource_link':
      return {
        type: 'resource_link',
        mimeType: content.mimeType,
        resource: { uri: content.uri, mimeType: content.mimeType },
      };
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
