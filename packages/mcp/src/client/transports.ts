/**
 * MCP Transport Wrappers
 *
 * Provides factory functions for creating MCP transports.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

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
    args: config.args,
    env,
    cwd: config.cwd,
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
export function createHttpTransport(config: HttpTransportConfig): Transport {
  return new StreamableHTTPClientTransport(new URL(config.url));
}
