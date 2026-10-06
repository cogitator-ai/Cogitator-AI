import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolInvoker, ToolSchema } from '@cogitator-ai/types';
import { MCPServer } from '../server/mcp-server';
import type { MCPServerConfig } from '../types';

function makeTool(overrides: Partial<Tool<{ command: string }, string>>): Tool {
  const tool: Tool<{ command: string }, string> = {
    name: 'exec',
    description: 'Run a shell command',
    parameters: z.object({ command: z.string() }),
    execute: async ({ command }) => `ran ${command}`,
    toJSON: (): ToolSchema => ({
      name: 'exec',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    }),
    ...overrides,
  };
  return tool as Tool;
}

const servers: MCPServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function serve(tool: Tool, config: Partial<MCPServerConfig> = {}): Promise<string> {
  const server = new MCPServer({
    name: 'tools',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    ...config,
  });
  server.registerTool(tool);
  await server.start();
  servers.push(server);
  return `http://127.0.0.1:${server.getPort()}/mcp`;
}

async function connect(url: string, answer?: { approve: boolean; reason?: string }) {
  const client = new Client(
    { name: 'desktop', version: '1.0.0' },
    { capabilities: answer ? { elicitation: {} } : {} }
  );
  const asked: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return { action: 'accept', content: answer };
    });
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return { client, asked };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return JSON.stringify(result.content);
}

describe('MCPServer tool calls', () => {
  it('refuse a tool that needs approval when the client cannot be asked', async () => {
    const execute = vi.fn(async () => 'ran');
    const url = await serve(makeTool({ requiresApproval: true, execute }));
    const { client } = await connect(url);

    const result = await client.callTool({ name: 'exec', arguments: { command: 'rm -rf /' } });

    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("needs the user's approval");
    expect(textOf(result)).toContain('elicitation');
  });

  it('ask the user through elicitation and run the call once approved', async () => {
    const execute = vi.fn(async ({ command }: { command: string }) => `ran ${command}`);
    const url = await serve(makeTool({ requiresApproval: true, execute }), { sessions: true });
    const { client, asked } = await connect(url, { approve: true });

    const result = await client.callTool({ name: 'exec', arguments: { command: 'ls' } });

    expect(asked[0]).toContain('exec');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('ran ls');
  });

  it('decline the call with the reason the user gives', async () => {
    const execute = vi.fn(async () => 'ran');
    const url = await serve(makeTool({ requiresApproval: true, execute }), { sessions: true });
    const { client } = await connect(url, { approve: false, reason: 'not on prod' });

    const result = await client.callTool({ name: 'exec', arguments: { command: 'ls' } });

    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not on prod');
  });

  it('keep the tool timeout', async () => {
    const url = await serve(
      makeTool({
        timeout: 30,
        execute: () => new Promise((resolve) => setTimeout(() => resolve('late'), 2_000)),
      })
    );
    const { client } = await connect(url);

    const result = await client.callTool({ name: 'exec', arguments: { command: 'sleep' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('timed out after 30ms');
  });

  it('run every call through the given tool invoker, with its sandbox', async () => {
    const execute = vi.fn(async () => 'ran on the host');
    const invokeTool = vi.fn<ToolInvoker['invokeTool']>(async (tool, _args, options) => ({
      callId: options?.toolCallId ?? 'call',
      name: tool.name,
      result: 'ran in the sandbox',
    }));
    const url = await serve(makeTool({ sandbox: { type: 'docker', image: 'alpine' }, execute }), {
      toolInvoker: { invokeTool },
    });
    const { client } = await connect(url);

    const result = await client.callTool({ name: 'exec', arguments: { command: 'ls' } });

    expect(execute).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'exec', sandbox: { type: 'docker', image: 'alpine' } }),
      { command: 'ls' },
      expect.objectContaining({ agentId: 'mcp-server' })
    );
    expect(textOf(result)).toContain('ran in the sandbox');
  });
});
