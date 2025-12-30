/**
 * MCP Server
 *
 * Exposes Cogitator tools as an MCP server that can be used by
 * other MCP clients (e.g., Claude Desktop, other AI assistants).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Tool, ToolContext } from '@cogitator/types';
import type { MCPServerConfig } from '../types';
import { resultToMCPContent, zodToJsonSchema } from '../adapter/tool-adapter';

interface MCPCallToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * MCP Server for exposing Cogitator tools
 *
 * @example
 * ```typescript
 * // Create server with tools
 * const server = new MCPServer({
 *   name: 'my-cogitator-server',
 *   version: '1.0.0',
 *   transport: 'stdio',
 * });
 *
 * // Register tools
 * server.registerTool(calculatorTool);
 * server.registerTool(fileReadTool);
 * server.registerTools([searchTool, weatherTool]);
 *
 * // Start serving
 * await server.start();
 * ```
 */
export class MCPServer {
  private server: McpServer;
  private config: MCPServerConfig;
  private tools = new Map<string, Tool>();
  private started = false;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.server = new McpServer({
      name: config.name,
      version: config.version,
    });
  }

  /**
   * Register a single Cogitator tool
   */
  registerTool(tool: Tool): void {
    if (this.started) {
      throw new Error('Cannot register tools after server has started');
    }

    this.tools.set(tool.name, tool);
    this.registerMCPTool(tool);
  }

  /**
   * Register multiple Cogitator tools
   */
  registerTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Unregister a tool by name
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get list of registered tool names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Register a tool with the MCP server
   */
  private registerMCPTool(tool: Tool): void {
    const inputSchema = this.buildInputSchema(tool);

    this.server.tool(
      tool.name,
      tool.description,
      inputSchema,
      async (args): Promise<MCPCallToolResult> => {
        return this.executeTool(tool, args as Record<string, unknown>);
      }
    );
  }

  /**
   * Build the input schema for MCP tool registration
   */
  private buildInputSchema(tool: Tool): Record<string, unknown> {
    if (tool.parameters) {
      const jsonSchema = zodToJsonSchema(tool.parameters);
      return jsonSchema.properties ?? {};
    }

    const schema = tool.toJSON();
    return schema.parameters.properties;
  }

  /**
   * Execute a tool and return MCP-formatted result
   */
  private async executeTool(
    tool: Tool,
    args: Record<string, unknown>
  ): Promise<MCPCallToolResult> {
    const context: ToolContext = {
      agentId: 'mcp-server',
      runId: `mcp_${Date.now()}`,
      signal: new AbortController().signal,
    };

    try {
      let validatedArgs = args;
      if (tool.parameters) {
        const parseResult = tool.parameters.safeParse(args);
        if (!parseResult.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Validation error: ${parseResult.error.message}`,
              },
            ],
            isError: true,
          } as MCPCallToolResult;
        }
        validatedArgs = parseResult.data as Record<string, unknown>;
      }

      const result = await tool.execute(validatedArgs, context);

      const rawContent = resultToMCPContent(result);

      const content: { type: 'text'; text: string }[] = rawContent.map((item) => {
        if (item.type === 'text') {
          return { type: 'text' as const, text: item.text };
        }
        return { type: 'text' as const, text: JSON.stringify(item) };
      });

      return { content } as MCPCallToolResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (this.config.logging) {
        console.error(`[MCPServer] Tool ${tool.name} error:`, errorMessage);
      }

      return {
        content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
        isError: true,
      } as MCPCallToolResult;
    }
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Server already started');
    }

    if (this.config.logging) {
      console.log(`[MCPServer] Starting ${this.config.name} v${this.config.version}`);
      console.log(`[MCPServer] Registered tools: ${this.getRegisteredTools().join(', ')}`);
    }

    switch (this.config.transport) {
      case 'stdio': {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        break;
      }

      case 'http':
      case 'sse': {
        await this.startHttpServer();
        break;
      }

      default:
        throw new Error(`Unknown transport: ${this.config.transport}`);
    }

    this.started = true;

    if (this.config.logging) {
      console.log(`[MCPServer] Server started on ${this.config.transport} transport`);
    }
  }

  /**
   * Start HTTP server for MCP
   */
  private async startHttpServer(): Promise<void> {
    const { createServer } = await import('node:http');
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );

    const port = this.config.port ?? 3000;
    const host = this.config.host ?? 'localhost';

    const httpServer = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await this.server.connect(transport);
      await transport.handleRequest(req, res, body);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(port, host, () => {
        if (this.config.logging) {
          console.log(`[MCPServer] HTTP server listening on http://${host}:${port}/mcp`);
        }
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.server.close();
    this.started = false;

    if (this.config.logging) {
      console.log('[MCPServer] Server stopped');
    }
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.started;
  }
}

/**
 * Create and start an MCP server with the given tools
 *
 * @example
 * ```typescript
 * await serveMCPTools([calculator, datetime], {
 *   name: 'my-tools',
 *   version: '1.0.0',
 *   transport: 'stdio',
 * });
 * ```
 */
export async function serveMCPTools(
  tools: Tool[],
  config: MCPServerConfig
): Promise<MCPServer> {
  const server = new MCPServer(config);
  server.registerTools(tools);
  await server.start();
  return server;
}
