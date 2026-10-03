/**
 * MCP Server
 *
 * Exposes Cogitator tools as an MCP server that can be used by
 * other MCP clients (e.g., Claude Desktop, other AI assistants).
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport as StreamableHTTPServerTransportType } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Tool } from '@cogitator-ai/types';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  MCPElicitRequest,
  MCPElicitResult,
  MCPToolContext,
  MCPCaller,
  MCPServerConfig,
  MCPResourceConfig,
  MCPResourceContent,
  MCPPromptConfig,
  MCPPromptMessage,
  MCPToolContent,
} from '../types';
import { resultToMCPContent } from '../adapter/tool-adapter';
import { z } from 'zod';

type MCPServerContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text: string } }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; blob: string } };

interface MCPCallToolResult {
  [key: string]: unknown;
  content: MCPServerContent[];
  isError?: boolean;
}

type MCPPromptContent = MCPPromptMessage['content'];

type ToolHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toServerContent(item: MCPToolContent | MCPPromptContent): MCPServerContent {
  switch (item.type) {
    case 'text':
      return { type: 'text', text: item.text ?? '' };
    case 'image':
    case 'audio':
      if (typeof item.data === 'string' && typeof item.mimeType === 'string') {
        return { type: item.type, data: item.data, mimeType: item.mimeType };
      }
      break;
    case 'resource':
    case 'resource_link': {
      const resource = item.resource;
      if (resource && typeof resource.blob === 'string') {
        return {
          type: 'resource',
          resource: { uri: resource.uri, mimeType: resource.mimeType, blob: resource.blob },
        };
      }
      if (resource && typeof resource.text === 'string') {
        return {
          type: 'resource',
          resource: { uri: resource.uri, mimeType: resource.mimeType, text: resource.text },
        };
      }
      break;
    }
  }
  return { type: 'text', text: JSON.stringify(item) };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PERMISSIVE_INPUT_SCHEMA = z.looseObject({});

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
  private httpServer?: HttpServer;
  private readonly sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransportType;
      server: McpServer;
      caller: MCPCaller | undefined;
    }
  >();

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
  private buildServer(caller?: MCPCaller): McpServer {
    const server = new McpServer({
      name: this.config.name,
      version: this.config.version,
    });

    for (const tool of this.tools.values()) {
      this.registerMCPTool(server, tool, caller);
    }
    for (const resource of this.resources.values()) {
      this.registerMCPResource(server, resource, caller);
    }
    for (const prompt of this.prompts.values()) {
      this.registerMCPPrompt(server, prompt, caller);
    }

    return server;
  }

  /**
   * Register a tool with the MCP server
   */
  private registerMCPTool(server: McpServer, tool: Tool, caller?: MCPCaller): void {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: this.buildInputSchema(tool),
      },
      async (args: unknown, extra: ToolHandlerExtra): Promise<MCPCallToolResult> => {
        return this.executeTool(tool, args, extra, caller);
      }
    );
  }

  /**
   * Resolve the Zod schema the SDK uses to advertise and validate tool input.
   *
   * The full tool schema is handed to the SDK (not just its shape) so object
   * modifiers, refinements and transforms are honoured, and the SDK passes
   * already-parsed arguments to the handler. Tools without a schema accept
   * any object.
   */
  private buildInputSchema(tool: Tool): z.ZodType {
    const params: unknown = tool.parameters;
    return params instanceof z.ZodType ? params : PERMISSIVE_INPUT_SCHEMA;
  }

  /**
   * Execute a tool with SDK-validated arguments and return an MCP-formatted result
   */
  private async executeTool(
    tool: Tool,
    args: unknown,
    extra: ToolHandlerExtra,
    caller?: MCPCaller
  ): Promise<MCPCallToolResult> {
    const context: MCPToolContext = {
      agentId: 'mcp-server',
      runId: `mcp_${randomUUID()}`,
      signal: extra.signal,
      ...(caller?.userId !== undefined && { userId: caller.userId }),
      ...(this.canElicit() && { elicit: (request) => this.elicit(extra, request) }),
    };

    try {
      const result = await tool.execute(args ?? {}, context);
      return { content: resultToMCPContent(result).map(toServerContent) };
    } catch (error) {
      const errorMessage = errorMessageOf(error);
      this.log('error', `Tool ${tool.name} error: ${errorMessage}`);

      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  }

  /**
   * Write a diagnostic line to stderr when logging is enabled.
   *
   * stdout is reserved for JSON-RPC frames on the stdio transport, so every
   * log line goes to stderr regardless of level.
   */
  private log(level: 'info' | 'error', message: string): void {
    if (!this.config.logging) {
      return;
    }
    const prefix = level === 'error' ? '[MCPServer] ERROR' : '[MCPServer]';
    console.error(`${prefix} ${message}`);
  }

  /**
   * Register a resource with the MCP server
   */
  private registerMCPResource(
    server: McpServer,
    config: MCPResourceConfig,
    caller?: MCPCaller
  ): void {
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
        if (typeof c.blob === 'string') {
          return { ...base, blob: c.blob };
        }
        return { ...base, text: c.text ?? '' };
      });
    };

    const readResource = async (params: Record<string, string>) => {
      try {
        return await config.read(params, caller);
      } catch (error) {
        this.log('error', `Resource ${config.name} error: ${errorMessageOf(error)}`);
        throw error;
      }
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
          const params: Record<string, string> = {};
          for (const [key, value] of Object.entries(variables)) {
            params[key] = Array.isArray(value) ? value.join(',') : value;
          }
          return { contents: formatContents(await readResource(params), uri.href) };
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
          return { contents: formatContents(await readResource({}), uri.href) };
        }
      );
    }
  }

  /**
   * Register a prompt with the MCP server
   */
  private registerMCPPrompt(server: McpServer, config: MCPPromptConfig, caller?: MCPCaller): void {
    const render = async (args: Record<string, string>) => {
      let result: Awaited<ReturnType<MCPPromptConfig['get']>>;
      try {
        result = await config.get(args, caller);
      } catch (error) {
        this.log('error', `Prompt ${config.name} error: ${errorMessageOf(error)}`);
        throw error;
      }
      return {
        description: result.description,
        messages: result.messages.map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? { type: 'text' as const, text: m.content }
              : toServerContent(m.content),
        })),
      };
    };

    const metadata = { title: config.title || config.name, description: config.description };
    const promptArgs = config.arguments ?? [];

    if (promptArgs.length === 0) {
      server.registerPrompt(config.name, metadata, async () => render({}));
      return;
    }

    const argsSchema: Record<string, z.ZodType<string | undefined>> = {};
    for (const arg of promptArgs) {
      const base = arg.description ? z.string().describe(arg.description) : z.string();
      argsSchema[arg.name] = arg.required ? base : base.optional();
    }

    server.registerPrompt(config.name, { ...metadata, argsSchema }, async (args) => {
      const stringArgs: Record<string, string> = {};
      for (const [key, value] of Object.entries(args ?? {})) {
        if (typeof value === 'string') {
          stringArgs[key] = value;
        }
      }
      return render(stringArgs);
    });
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Server already started');
    }

    this.log('info', `Starting ${this.config.name} v${this.config.version}`);
    this.log('info', `Registered tools: ${this.getRegisteredTools().join(', ') || '(none)'}`);
    this.log(
      'info',
      `Registered resources: ${this.getRegisteredResources().join(', ') || '(none)'}`
    );
    this.log('info', `Registered prompts: ${this.getRegisteredPrompts().join(', ') || '(none)'}`);

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
    this.log('info', `Server started on ${this.config.transport} transport`);
  }

  /** Elicitation needs the client's reply to reach this server: stdio, or HTTP with sessions. */
  private canElicit(): boolean {
    return this.config.transport === 'stdio' || this.config.sessions === true;
  }

  /**
   * Ask the client's user through MCP elicitation, tied to the tool call so it
   * works on stateless HTTP too. `undefined` when the client cannot answer.
   */
  private async elicit(
    extra: ToolHandlerExtra,
    request: MCPElicitRequest
  ): Promise<MCPElicitResult | undefined> {
    try {
      const result = await extra.sendRequest(
        {
          method: 'elicitation/create',
          params: { mode: 'form', message: request.message, requestedSchema: request.schema },
        },
        ElicitResultSchema
      );
      return result.action === 'accept'
        ? { action: 'accept', content: result.content ?? {} }
        : { action: result.action };
    } catch (error) {
      this.log('info', `Elicitation unavailable: ${errorMessageOf(error)}`);
      return undefined;
    }
  }

  /**
   * The caller of an HTTP request per `config.auth`: `undefined` when the
   * server has no `auth`, `null` when the request is refused.
   */
  private async authenticate(req: IncomingMessage): Promise<MCPCaller | undefined | null> {
    if (!this.config.auth) return undefined;
    try {
      return (await this.config.auth(req)) ?? null;
    } catch (error) {
      this.log('error', `Auth error: ${errorMessageOf(error)}`);
      return null;
    }
  }

  /**
   * A request in session mode: a request without a session id starts a
   * session (an `initialize`), the others go to their session's transport.
   * A session belongs to the caller that started it.
   */
  private async handleSessionRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    caller: MCPCaller | undefined,
    Transport: typeof StreamableHTTPServerTransportType
  ): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        writeJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      if (session.caller?.userId !== caller?.userId) {
        writeJsonRpcError(res, 403, -32001, 'The session belongs to another caller');
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    const server = this.buildServer(caller);
    const transport: StreamableHTTPServerTransportType = new Transport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server, caller });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
      server.close().catch(() => {});
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const caller = await this.authenticate(req);
      if (caller === null) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized' },
            id: null,
          })
        );
        return;
      }

      try {
        if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method Not Allowed');
          return;
        }
        const body = req.method === 'POST' ? await readJsonBody(req, res, maxBodySize) : undefined;
        if (body === null) return;

        if (this.config.sessions) {
          await this.handleSessionRequest(req, res, body, caller, StreamableHTTPServerTransport);
          return;
        }

        const server = this.buildServer(caller);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        this.log('error', `HTTP request error: ${errorMessageOf(error)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    });

    const httpServer = this.httpServer;
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.httpServer = undefined;
      throw error;
    }

    this.log('info', `HTTP server listening on http://${host}:${this.getPort() ?? port}/mcp`);
  }

  /**
   * Port the HTTP transport is listening on (useful with `port: 0`).
   * Returns undefined for stdio or before the server has started.
   */
  getPort(): number | undefined {
    const address = this.httpServer?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.all(sessions.map(({ transport }) => transport.close().catch(() => {})));
      const httpServer = this.httpServer;
      if (httpServer) {
        this.httpServer = undefined;
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
          httpServer.closeAllConnections();
        });
      }
    } finally {
      const server = this.server;
      this.server = undefined;
      this.started = false;
      if (server) {
        await server.close();
      }
    }

    this.log('info', 'Server stopped');
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

/** The JSON body of a POST, or `null` when the request was answered (too large, invalid JSON). */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodySize: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    totalSize += buffer.length;
    if (totalSize > maxBodySize) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Payload Too Large');
      req.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } catch {
    writeJsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
    return null;
  }
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
