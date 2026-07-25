/**
 * MCP Server
 *
 * Exposes Cogitator tools as an MCP server that can be used by
 * other MCP clients (e.g., Claude Desktop, other AI assistants).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Tool, ToolContext } from '@cogitator-ai/types';
import type {
  MCPServerConfig,
  MCPResourceConfig,
  MCPResourceContent,
  MCPPromptConfig,
} from '../types';
import { resultToMCPContent } from '../adapter/tool-adapter';
import { z } from 'zod';

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
  private server?: McpServer;
  private config: MCPServerConfig;
  private tools = new Map<string, Tool>();
  private resources = new Map<string, MCPResourceConfig>();
  private prompts = new Map<string, MCPPromptConfig>();
  private started = false;
  private httpServer?: import('node:http').Server;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  /**
   * Register a single Cogitator tool
   */
  registerTool(tool: Tool): void {
    if (this.started) {
      throw new Error('Cannot register tools after server has started');
    }

    this.tools.set(tool.name, tool);
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
   * Unregister a tool by name.
   * Only works before server.start() — tools registered on the underlying
   * MCP transport cannot be removed at runtime.
   */
  unregisterTool(name: string): boolean {
    if (this.started) {
      throw new Error('Cannot unregister tools after server has started');
    }
    return this.tools.delete(name);
  }

  /**
   * Get list of registered tool names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Register a single resource
   */
  registerResource(config: MCPResourceConfig): void {
    if (this.started) {
      throw new Error('Cannot register resources after server has started');
    }

    this.resources.set(config.uri, config);
  }

  /**
   * Register multiple resources
   */
  registerResources(configs: MCPResourceConfig[]): void {
    for (const config of configs) {
      this.registerResource(config);
    }
  }

  /**
   * Unregister a resource by URI.
   * Only works before server.start().
   */
  unregisterResource(uri: string): boolean {
    if (this.started) {
      throw new Error('Cannot unregister resources after server has started');
    }
    return this.resources.delete(uri);
  }

  /**
   * Get list of registered resource URIs
   */
  getRegisteredResources(): string[] {
    return Array.from(this.resources.keys());
  }

  /**
   * Register a single prompt
   */
  registerPrompt(config: MCPPromptConfig): void {
    if (this.started) {
      throw new Error('Cannot register prompts after server has started');
    }

    this.prompts.set(config.name, config);
  }

  /**
   * Register multiple prompts
   */
  registerPrompts(configs: MCPPromptConfig[]): void {
    for (const config of configs) {
      this.registerPrompt(config);
    }
  }

  /**
   * Unregister a prompt by name.
   * Only works before server.start().
   */
  unregisterPrompt(name: string): boolean {
    if (this.started) {
      throw new Error('Cannot unregister prompts after server has started');
    }
    return this.prompts.delete(name);
  }

  /**
   * Get list of registered prompt names
   */
  getRegisteredPrompts(): string[] {
    return Array.from(this.prompts.keys());
  }

  /**
   * Build a fresh SDK McpServer instance and register every tool, resource
   * and prompt from the local maps onto it.
   *
   * The maps are the single source of truth: registration with the SDK is
   * deferred until start() (stdio) or until each incoming request (HTTP), so
   * unregister* calls made before start() are fully honoured and concurrent
   * HTTP requests never share a single server/transport binding.
   */
  private buildServer(): McpServer {
    const server = new McpServer({
      name: this.config.name,
      version: this.config.version,
    });

    for (const tool of this.tools.values()) {
      this.registerMCPTool(server, tool);
    }
    for (const resource of this.resources.values()) {
      this.registerMCPResource(server, resource);
    }
    for (const prompt of this.prompts.values()) {
      this.registerMCPPrompt(server, prompt);
    }

    return server;
  }

  /**
   * Register a tool with the MCP server
   */
  private registerMCPTool(server: McpServer, tool: Tool): void {
    const inputShape = this.buildInputShape(tool);

    server.tool(
      tool.name,
      tool.description,
      inputShape,
      async (args, extra): Promise<MCPCallToolResult> => {
        return this.executeTool(tool, args as Record<string, unknown>, extra.signal);
      }
    );
  }

  /**
   * Build the Zod raw shape the SDK expects for tool input schemas.
   *
   * The SDK validates inputs with Zod, so it needs the actual Zod schemas
   * (a record of Zod types), not a converted JSON Schema. Passing JSON Schema
   * objects makes the SDK silently drop the schema and skip validation.
   */
  private buildInputShape(tool: Tool): Record<string, z.ZodTypeAny> {
    const params = tool.parameters;
    if (params instanceof z.ZodObject) {
      return params.shape as Record<string, z.ZodTypeAny>;
    }
    return {};
  }

  /**
   * Execute a tool and return MCP-formatted result
   */
  private async executeTool(
    tool: Tool,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<MCPCallToolResult> {
    const context: ToolContext = {
      agentId: 'mcp-server',
      runId: `mcp_${Date.now()}`,
      signal: signal ?? new AbortController().signal,
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
          };
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

      return { content };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (this.config.logging) {
        console.error(`[MCPServer] Tool ${tool.name} error:`, errorMessage);
      }

      return {
        content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  }

  /**
   * Register a resource with the MCP server
   */
  private registerMCPResource(server: McpServer, config: MCPResourceConfig): void {
    const isTemplate = config.uri.includes('{');

    const formatContents = (result: MCPResourceContent | MCPResourceContent[], uriHref: string) => {
      const contents = Array.isArray(result) ? result : [result];
      return contents.map((c: MCPResourceContent) => {
        const base: { uri: string; mimeType?: string } = {
          uri: c.uri || uriHref,
        };
        if (c.mimeType || config.mimeType) {
          base.mimeType = c.mimeType || config.mimeType;
        }
        if (c.blob) {
          return { ...base, blob: c.blob };
        }
        return { ...base, text: c.text || '' };
      });
    };

    if (isTemplate) {
      server.registerResource(
        config.name,
        new ResourceTemplate(config.uri, { list: undefined }),
        {
          description: config.description,
          mimeType: config.mimeType,
        },
        async (uri: URL, variables: Record<string, string | string[]>) => {
          try {
            const params: Record<string, string> = {};
            for (const [key, value] of Object.entries(variables)) {
              params[key] = Array.isArray(value) ? value[0] || '' : value;
            }
            const result = await config.read(params);
            return { contents: formatContents(result, uri.href) };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (this.config.logging) {
              console.error(`[MCPServer] Resource ${config.name} error:`, errorMessage);
            }
            return { contents: [{ uri: uri.href, text: `Error: ${errorMessage}` }] };
          }
        }
      );
    } else {
      server.registerResource(
        config.name,
        config.uri,
        {
          description: config.description,
          mimeType: config.mimeType,
        },
        async (uri: URL) => {
          try {
            const result = await config.read({});
            return { contents: formatContents(result, uri.href) };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (this.config.logging) {
              console.error(`[MCPServer] Resource ${config.name} error:`, errorMessage);
            }
            return { contents: [{ uri: uri.href, text: `Error: ${errorMessage}` }] };
          }
        }
      );
    }
  }

  /**
   * Register a prompt with the MCP server
   */
  private registerMCPPrompt(server: McpServer, config: MCPPromptConfig): void {
    const argsSchema: Record<string, z.ZodTypeAny> = {};

    for (const arg of config.arguments || []) {
      let schema: z.ZodTypeAny = z.string();
      if (arg.description) {
        schema = schema.describe(arg.description);
      }
      if (!arg.required) {
        schema = schema.optional();
      }
      argsSchema[arg.name] = schema;
    }

    server.registerPrompt(
      config.name,
      {
        title: config.title || config.name,
        description: config.description,
        argsSchema,
      },
      async (args) => {
        try {
          const result = await config.get(args as Record<string, string>);
          return {
            description: result.description,
            messages: result.messages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: {
                type: 'text' as const,
                text: typeof m.content === 'string' ? m.content : m.content.text || '',
              },
            })),
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (this.config.logging) {
            console.error(`[MCPServer] Prompt ${config.name} error:`, errorMessage);
          }
          return {
            messages: [
              {
                role: 'assistant' as const,
                content: { type: 'text' as const, text: `Error: ${errorMessage}` },
              },
            ],
          };
        }
      }
    );
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
      console.log(
        `[MCPServer] Registered tools: ${this.getRegisteredTools().join(', ') || '(none)'}`
      );
      console.log(
        `[MCPServer] Registered resources: ${this.getRegisteredResources().join(', ') || '(none)'}`
      );
      console.log(
        `[MCPServer] Registered prompts: ${this.getRegisteredPrompts().join(', ') || '(none)'}`
      );
    }

    switch (this.config.transport) {
      case 'stdio': {
        this.server = this.buildServer();
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
    const { StreamableHTTPServerTransport } =
      await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

    const port = this.config.port ?? 3000;
    const host = this.config.host ?? 'localhost';
    const maxBodySize = this.config.maxBodySize ?? 10 * 1024 * 1024;
    const corsOrigin = this.config.corsOrigin ?? '*';

    this.httpServer = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const server = this.buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });

      try {
        await server.connect(transport);

        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          let totalSize = 0;
          let tooLarge = false;
          for await (const chunk of req) {
            const buffer = chunk as Buffer;
            totalSize += buffer.length;
            if (totalSize > maxBodySize) {
              tooLarge = true;
              break;
            }
            chunks.push(buffer);
          }

          if (tooLarge) {
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            res.end('Payload Too Large');
            req.destroy();
            return;
          }

          let body: Record<string, unknown>;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request: invalid JSON');
            return;
          }

          await transport.handleRequest(req, res, body);
        } else if (req.method === 'GET' || req.method === 'DELETE') {
          await transport.handleRequest(req, res);
        } else {
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method Not Allowed');
        }
      } catch (error) {
        if (this.config.logging) {
          console.error(
            '[MCPServer] HTTP request error:',
            error instanceof Error ? error.message : String(error)
          );
        }
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => {
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

    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
      this.httpServer = undefined;
    }

    if (this.server) {
      await this.server.close();
      this.server = undefined;
    }
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
export async function serveMCPTools(tools: Tool[], config: MCPServerConfig): Promise<MCPServer> {
  const server = new MCPServer(config);
  server.registerTools(tools);
  await server.start();
  return server;
}
