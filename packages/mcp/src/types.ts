/**
 * MCP Integration Types
 */

import type { IncomingMessage } from 'node:http';
import type { ToolContext } from '@cogitator-ai/types';

export type MCPTransportType = 'stdio' | 'http' | 'sse';

export interface MCPRetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;

  /** Initial delay in ms before first retry (default: 1000) */
  initialDelay?: number;

  /** Maximum delay in ms between retries (default: 30000) */
  maxDelay?: number;

  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;

  /** Whether to retry on connection loss (default: true) */
  retryOnConnectionLoss?: boolean;
}

export interface MCPClientConfig {
  /** Transport type */
  transport: MCPTransportType;

  /** For stdio transport: command to spawn */
  command?: string;

  /** For stdio transport: command arguments */
  args?: string[];

  /** For stdio transport: environment variables */
  env?: Record<string, string>;

  /** For stdio transport: working directory of the spawned command */
  cwd?: string;

  /** For HTTP transport: server URL */
  url?: string;

  /** For HTTP transport: custom headers sent with each request */
  headers?: Record<string, string>;

  /** Connection timeout in ms */
  timeout?: number;

  /** Client name for identification */
  clientName?: string;

  /** Client version */
  clientVersion?: string;

  /** Retry configuration for failed operations */
  retry?: MCPRetryConfig;

  /** Auto-reconnect on connection loss (default: true) */
  autoReconnect?: boolean;

  /** Callback when reconnection attempt starts */
  onReconnecting?: (attempt: number) => void;

  /** Callback when reconnected successfully */
  onReconnected?: () => void;

  /** Callback when reconnection fails permanently */
  onReconnectFailed?: (error: Error) => void;
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
    type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link';
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: { uri: string; mimeType?: string; text?: string; blob?: string };
  };
}

/** What a resource's `read` returns; `uri` defaults to the URI that was read. */
export type MCPResourceReadContent = Omit<MCPResourceContent, 'uri'> & { uri?: string };

export interface MCPResourceConfig {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** `caller` is who `auth` established for the request, on the HTTP transport */
  read: (
    params: Record<string, string>,
    caller?: MCPCaller
  ) => Promise<MCPResourceReadContent | MCPResourceReadContent[]>;
}

export interface MCPPromptArgumentConfig {
  name: string;
  description?: string;
  required?: boolean;
}

/** A message a prompt's `get` returns; string content is plain text. */
export interface MCPPromptReplyMessage {
  role: MCPPromptMessage['role'];
  content: string | MCPPromptMessage['content'];
}

export interface MCPPromptResult {
  messages: MCPPromptReplyMessage[];
  description?: string;
}

export interface MCPPromptConfig {
  name: string;
  title?: string;
  description?: string;
  arguments?: MCPPromptArgumentConfig[];
  /** `caller` is who `auth` established for the request, on the HTTP transport */
  get: (
    args: Record<string, string>,
    caller?: MCPCaller
  ) => Promise<MCPPromptResult> | MCPPromptResult;
}

/** A field of an elicitation form (MCP `requestedSchema` primitives) */
export type MCPElicitField =
  | { type: 'string'; title?: string; description?: string; enum?: string[] }
  | { type: 'number' | 'integer'; title?: string; description?: string }
  | { type: 'boolean'; title?: string; description?: string; default?: boolean };

export interface MCPElicitRequest {
  message: string;
  schema: { type: 'object'; properties: Record<string, MCPElicitField>; required?: string[] };
}

export type MCPElicitResult =
  { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' | 'cancel' };

/**
 * The context a tool gets when an MCP server runs it: the usual tool context,
 * plus `elicit` to ask the person at the client a question while the call waits.
 */
export interface MCPToolContext extends ToolContext {
  /** `undefined` (as a result) when the client cannot answer elicitation requests */
  elicit?: (request: MCPElicitRequest) => Promise<MCPElicitResult | undefined>;
}

/**
 * Who is calling an MCP server over HTTP, as its `auth` function established it.
 * `userId` reaches tools as `context.userId`.
 */
export interface MCPCaller {
  userId?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Establishes the caller of an HTTP request, typically from its
 * `Authorization` header. Return `undefined` (or throw) to answer 401.
 */
export type MCPAuthFunction = (
  request: IncomingMessage
) => MCPCaller | undefined | Promise<MCPCaller | undefined>;

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

  /** For HTTP transport: maximum request body size in bytes (default: 10 MB) */
  maxBodySize?: number;

  /** For HTTP transport: value of the Access-Control-Allow-Origin header (default: '*') */
  corsOrigin?: string;

  /**
   * For HTTP transport: establishes the caller of every request; requests it
   * returns `undefined` for are answered 401. Without it the server is open
   * to anyone who can reach it.
   */
  auth?: MCPAuthFunction;

  /**
   * For HTTP transport: keep a session per client (`mcp-session-id`) instead
   * of serving every request on its own. Needed for requests from the server
   * to the client, such as elicitation; each session belongs to the caller
   * that started it.
   */
  sessions?: boolean;

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
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: MCPResourceContent };

export interface MCPCallToolOptions {
  /** Abort signal that cancels the in-flight tool call */
  signal?: AbortSignal;

  /** Per-call request timeout in ms (defaults to the MCP SDK timeout) */
  timeout?: number;
}

export interface ToolAdapterOptions {
  /** Prefix to add to converted tool names */
  namePrefix?: string;

  /** Transform tool description */
  descriptionTransform?: (description: string) => string;
}
