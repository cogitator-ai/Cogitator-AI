/**
 * Connecting MCP servers given as `.mcp.json` writes them: the servers of plugins and the inline
 * servers of subagents
 */

import { z } from 'zod';
import type { SubagentMcpConnection, SubagentMcpConnector, Tool } from '@cogitator-ai/types';
import { MCPClient } from './mcp-client';
import type { MCPClientConfig } from '../types';

const StdioSchema = z.looseObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const RemoteSchema = z.looseObject({
  type: z.enum(['http', 'sse', 'streamable-http']).optional(),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** Options of {@link experimental_mcpConnector} */
export interface McpConnectorOptions {
  /** Milliseconds a server may take to connect (default 30 000) */
  timeout?: number;
  /** The name the client gives itself to servers (default `cogitator`) */
  clientName?: string;
}

/** The client config of one `.mcp.json` server */
export function mcpClientConfigOf(
  name: string,
  config: Readonly<Record<string, unknown>>,
  options: McpConnectorOptions = {}
): MCPClientConfig {
  const base = {
    clientName: options.clientName ?? 'cogitator',
    timeout: options.timeout ?? 30_000,
  };
  if (typeof config.url === 'string') {
    const remote = RemoteSchema.safeParse(config);
    if (!remote.success) {
      throw new TypeError(
        `The MCP server ${name} has no valid url: ${z.prettifyError(remote.error)}`
      );
    }
    return {
      ...base,
      transport: remote.data.type === 'sse' ? 'sse' : 'http',
      url: remote.data.url,
      ...(remote.data.headers && { headers: remote.data.headers }),
    };
  }
  const stdio = StdioSchema.safeParse(config);
  if (!stdio.success) {
    throw new TypeError(
      `The MCP server ${name} needs a command or a url: ${z.prettifyError(stdio.error)}`
    );
  }
  return {
    ...base,
    transport: 'stdio',
    command: stdio.data.command,
    ...(stdio.data.args && { args: stdio.data.args }),
    ...(stdio.data.env && { env: stdio.data.env }),
    ...(stdio.data.cwd && { cwd: stdio.data.cwd }),
  };
}

/** The part of a server name an `mcp__<server>__<tool>` name holds */
function namePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Experimental. Connects MCP servers given as `.mcp.json` writes them (`command`, `args`, `env` for
 * stdio, `url` and `headers` for HTTP and SSE), for `experimental_plugins.mcp` and
 * `subagents.mcp`. Each server's tools are named `mcp__<server>__<tool>` (so a plugin server
 * `plugin:deploy:api` gives `mcp__plugin_deploy_api__<tool>`, as in Claude Code) and carry their
 * server in `mcp`, so permission rules and hook matchers name them. A server that fails to connect
 * closes the ones connected before it and fails the call
 *
 * @example
 * ```ts
 * const cog = new Cogitator({
 *   experimental_plugins: { dirs: ['./plugins/deploy'], mcp: experimental_mcpConnector() },
 * });
 * ```
 */
export function experimental_mcpConnector(options: McpConnectorOptions = {}): SubagentMcpConnector {
  return async (servers, context) => {
    const clients: MCPClient[] = [];
    const tools: Tool[] = [];
    const close = async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    };
    try {
      for (const server of servers) {
        context.signal.throwIfAborted();
        const client = await MCPClient.connect(
          mcpClientConfigOf(server.name, server.config, options)
        );
        clients.push(client);
        tools.push(
          ...(await client.getTools({
            namePrefix: `mcp__${namePart(server.name)}__`,
            server: server.name,
          }))
        );
      }
    } catch (error) {
      await close();
      throw error;
    }
    const connection: SubagentMcpConnection = { tools, close };
    return connection;
  };
}
