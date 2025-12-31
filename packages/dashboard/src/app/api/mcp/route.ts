import { NextResponse } from 'next/server';
import {
  MCPClient,
  MCPServer,
} from '@cogitator-ai/mcp';
import type { MCPClientConfig, MCPServerConfig } from '@cogitator-ai/mcp';
import { getAvailableTools, getCogitator } from '@/lib/cogitator';
import { withAuth } from '@/lib/auth/middleware';

const activeClients = new Map<string, MCPClient>();

let mcpServer: MCPServer | null = null;

export const GET = withAuth(async (request) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action');

    switch (action) {
      case 'clients': {
        const clients = Array.from(activeClients.entries()).map(([id, client]) => ({
          id,
          connected: client.isConnected(),
        }));
        return NextResponse.json({ clients });
      }

      case 'tools': {
        const clientId = searchParams.get('clientId');
        if (!clientId) {
          return NextResponse.json({ error: 'clientId required' }, { status: 400 });
        }
        const client = activeClients.get(clientId);
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 });
        }
        const tools = await client.getTools();
        return NextResponse.json({
          clientId,
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.toJSON().parameters,
          })),
        });
      }

      case 'resources': {
        const clientId = searchParams.get('clientId');
        if (!clientId) {
          return NextResponse.json({ error: 'clientId required' }, { status: 400 });
        }
        const client = activeClients.get(clientId);
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 });
        }
        const resources = await client.listResources();
        return NextResponse.json({ clientId, resources });
      }

      case 'prompts': {
        const clientId = searchParams.get('clientId');
        if (!clientId) {
          return NextResponse.json({ error: 'clientId required' }, { status: 400 });
        }
        const client = activeClients.get(clientId);
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 });
        }
        const prompts = await client.listPrompts();
        return NextResponse.json({ clientId, prompts });
      }

      case 'server-status': {
        return NextResponse.json({
          running: mcpServer !== null,
          toolCount: getAvailableTools().length,
        });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[api/mcp] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'MCP operation failed' },
      { status: 500 }
    );
  }
});

export const POST = withAuth(async (request) => {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'connect': {
        const { config, clientId } = body;

        if (!config || !clientId) {
          return NextResponse.json(
            { error: 'config and clientId required' },
            { status: 400 }
          );
        }

        if (activeClients.has(clientId)) {
          return NextResponse.json({ error: 'Client already exists' }, { status: 409 });
        }

        const mcpConfig: MCPClientConfig = {
          transport: config.transport || 'stdio',
          command: config.command,
          args: config.args || [],
          url: config.url,
          env: config.env || {},
          timeout: config.timeout || 30000,
          clientName: `cogitator-dashboard-${clientId}`,
        };

        console.log('[mcp] Connecting to MCP server:', mcpConfig);
        const client = await MCPClient.connect(mcpConfig);
        activeClients.set(clientId, client);

        const tools = await client.getTools();
        const capabilities = {
          tools: tools.length > 0,
          resources: false,
          prompts: false,
        };

        try {
          const resources = await client.listResources();
          capabilities.resources = resources.length > 0;
        } catch {}

        try {
          const prompts = await client.listPrompts();
          capabilities.prompts = prompts.length > 0;
        } catch {}

        return NextResponse.json({
          clientId,
          connected: true,
          capabilities,
          toolCount: tools.length,
        });
      }

      case 'disconnect': {
        const { clientId } = body;
        if (!clientId) {
          return NextResponse.json({ error: 'clientId required' }, { status: 400 });
        }

        const client = activeClients.get(clientId);
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 });
        }

        await client.close();
        activeClients.delete(clientId);

        return NextResponse.json({ success: true, clientId });
      }

      case 'call-tool': {
        const { clientId, toolName, args } = body;

        if (!clientId || !toolName) {
          return NextResponse.json(
            { error: 'clientId and toolName required' },
            { status: 400 }
          );
        }

        const client = activeClients.get(clientId);
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 });
        }

        const result = await client.callTool(toolName, args || {});
        return NextResponse.json({ result });
      }

      case 'read-resource': {
        const { clientId, uri } = body;

        if (!clientId || !uri) {
          return NextResponse.json(
            { error: 'clientId and uri required' },
            { status: 400 }
          );
        }

        const client = activeClients.get(clientId);
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 });
        }

        const content = await client.readResource(uri);
        return NextResponse.json({ content });
      }

      case 'get-prompt': {
        const { clientId, promptName, args } = body;

        if (!clientId || !promptName) {
          return NextResponse.json(
            { error: 'clientId and promptName required' },
            { status: 400 }
          );
        }

        const client = activeClients.get(clientId);
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 });
        }

        const messages = await client.getPrompt(promptName, args || {});
        return NextResponse.json({ messages });
      }

      case 'import-tools': {
        const { clientId } = body;

        if (!clientId) {
          return NextResponse.json({ error: 'clientId required' }, { status: 400 });
        }

        const client = activeClients.get(clientId);
        if (!client) {
          return NextResponse.json({ error: 'Client not found' }, { status: 404 });
        }

        const mcpTools = await client.getTools();
        const cogitator = await getCogitator();

        for (const tool of mcpTools) {
          cogitator.tools.register(tool);
        }

        return NextResponse.json({
          imported: mcpTools.length,
          tools: mcpTools.map(t => t.name),
        });
      }

      case 'start-server': {
        if (mcpServer) {
          return NextResponse.json({ error: 'Server already running' }, { status: 409 });
        }

        await getCogitator();
        const tools = getAvailableTools();

        const serverConfig: MCPServerConfig = {
          name: 'cogitator-mcp-server',
          version: '1.0.0',
          transport: 'stdio',
        };

        mcpServer = new MCPServer(serverConfig);

        mcpServer.registerTools(tools as Parameters<typeof mcpServer.registerTools>[0]);

        return NextResponse.json({
          started: true,
          toolCount: tools.length,
        });
      }

      case 'stop-server': {
        if (!mcpServer) {
          return NextResponse.json({ error: 'Server not running' }, { status: 400 });
        }

        await mcpServer.stop();
        mcpServer = null;

        return NextResponse.json({ stopped: true });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[api/mcp] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'MCP operation failed' },
      { status: 500 }
    );
  }
});

export const DELETE = withAuth(async () => {
  try {
    for (const [id, client] of activeClients) {
      try {
        await client.close();
      } catch (error) {
        console.warn(`[mcp] Failed to close client ${id}:`, error);
      }
    }
    activeClients.clear();

    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = null;
    }

    return NextResponse.json({ success: true, message: 'All MCP connections closed' });
  } catch (error) {
    console.error('[api/mcp] Cleanup error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cleanup failed' },
      { status: 500 }
    );
  }
});
