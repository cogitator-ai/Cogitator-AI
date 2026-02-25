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
import { resultToMCPContent, zodToJsonSchema } from '../adapter/tool-adapter';
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
  private server: McpServer;
  private config: MCPServerConfig;
  private tools = new Map<string, Tool>();
  private resources = new Map<string, MCPResourceConfig>();
  private prompts = new Map<string, MCPPromptConfig>();
  private started = false;
  private httpServer?: import('node:http').Server;

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
    this.registerMCPResource(config);
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
    this.registerMCPPrompt(config);
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
  private async executeTool(tool: Tool, args: Record<string, unknown>): Promise<MCPCallToolResult> {
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
  private registerMCPResource(config: MCPResourceConfig): void {
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
      this.server.registerResource(
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
      this.server.registerResource(
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
  private registerMCPPrompt(config: MCPPromptConfig): void {
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

    this.server.registerPrompt(
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

    this.httpServer = createServer(async (req, res) => {
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
export async function serveMCPTools(tools: Tool[], config: MCPServerConfig): Promise<MCPServer> {
  const server = new MCPServer(config);
  server.registerTools(tools);
  await server.start();
  return server;
}
