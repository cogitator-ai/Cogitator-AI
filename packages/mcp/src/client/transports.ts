/**
 * MCP Transport Wrappers
 *
 * Provides factory functions for creating MCP transports.
 */

import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export interface StdioTransportConfig {
  /** Command to execute */
  command: string;

  /** Command arguments */
  args?: string[];

  /** Environment variables */
  env?: Record<string, string>;

  /** Working directory */
  cwd?: string;
}

export interface HttpTransportConfig {
  /** Server URL */
  url: string;

  /** Custom headers */
  headers?: Record<string, string>;

  /** OAuth for a server that asks for it */
  authProvider?: OAuthClientProvider;
}

/**
 * Create a stdio transport for connecting to a local MCP server process
 *
 * @example
 * ```typescript
 * const transport = createStdioTransport({
 *   command: 'npx',
 *   args: ['-y', '@anthropic/mcp-server-filesystem', '/path/to/allowed/dir'],
 * });
 * ```
 */
export function createStdioTransport(config: StdioTransportConfig): Transport {
  let env: Record<string, string> | undefined;
  if (config.env) {
    env = { ...config.env };
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !(key in env)) {
        env[key] = value;
      }
    }
  }

  return new StdioClientTransport({
    command: config.command,
    ...(config.args && { args: config.args }),
    ...(env && { env }),
    ...(config.cwd && { cwd: config.cwd }),
  });
}

/**
 * Create an HTTP transport for connecting to a remote MCP server
 *
 * @example
 * ```typescript
 * const transport = createHttpTransport({
 *   url: 'http://localhost:3000/mcp',
 * });
 * ```
 */
export function createHttpTransport(config: HttpTransportConfig): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers && { requestInit: { headers: config.headers } }),
    ...(config.authProvider && { authProvider: config.authProvider }),
  });
}

/**
 * Create an SSE transport for a server of the older HTTP+SSE protocol: a GET opens the event
 * stream, messages go in POSTs to the endpoint the server names. `headers` go with both
 *
 * @example
 * ```typescript
 * const transport = createSseTransport({ url: 'http://localhost:3000/sse' });
 * ```
 */
export function createSseTransport(config: HttpTransportConfig): SSEClientTransport {
  return new SSEClientTransport(new URL(config.url), {
    ...(config.headers && { requestInit: { headers: config.headers } }),
    ...(config.authProvider && { authProvider: config.authProvider }),
  });
}
