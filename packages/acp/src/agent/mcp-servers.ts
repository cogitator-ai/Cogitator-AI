import type { McpServer } from '@agentclientprotocol/sdk';
import { experimental_mcpConnector } from '@cogitator-ai/mcp';
import type { SubagentMcpConnection, SubagentMcpConnector } from '@cogitator-ai/types';

/**
 * The MCP servers of `session/new` in the shape of a `.mcp.json`, which the MCP connector of
 * `@cogitator-ai/mcp` reads: a command with its arguments and environment, or a URL with its
 * headers (`sse` for the older HTTP+SSE transport)
 */
export function mcpServerConfigs(
  servers: readonly McpServer[],
  cwd: string
): { name: string; config: Record<string, unknown> }[] {
  return servers.map((server) => {
    if ('command' in server) {
      return {
        name: server.name,
        config: {
          type: 'stdio',
          command: server.command,
          args: [...server.args],
          env: Object.fromEntries(server.env.map((variable) => [variable.name, variable.value])),
          cwd,
        },
      };
    }
    return {
      name: server.name,
      config: {
        type: server.type,
        url: server.url,
        headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      },
    };
  });
}

/**
 * Connects the MCP servers an editor gave a session with our `MCPClient`, their tools named
 * `mcp__<server>__<tool>` so permission rules name them. Resolves with no tools and nothing to
 * close for none
 */
export async function connectMcpServers(
  servers: readonly McpServer[],
  options: { cwd: string; agent: string; signal: AbortSignal; connector?: SubagentMcpConnector }
): Promise<SubagentMcpConnection> {
  if (servers.length === 0) return { tools: [], close: async () => undefined };
  const connect = options.connector ?? experimental_mcpConnector({ clientName: 'cogitator-acp' });
  return connect(mcpServerConfigs(servers, options.cwd), {
    agent: options.agent,
    signal: options.signal,
  });
}
