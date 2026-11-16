import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool, ToolSchema } from '@cogitator-ai/types';
import { MCPServer } from '../server/mcp-server';
import type { MCPRequestInfo, MCPServerConfig, MCPToolContext } from '../types';
import { rawRequest } from './support/raw-mcp';

const servers: MCPServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

interface Seen {
  args: Record<string, unknown>;
  request: MCPRequestInfo | undefined;
}

function whoami(seen: Seen[]): Tool {
  const tool: Tool<Record<string, unknown>, string> = {
    name: 'whoami',
    description: 'Says what the server knows of the caller',
    parameters: z.looseObject({ note: z.string().optional() }),
    execute: async (args, context) => {
      seen.push({ args, request: (context as MCPToolContext).request });
      return 'seen';
    },
    toJSON: (): ToolSchema => ({
      name: 'whoami',
      description: 'Says what the server knows of the caller',
      parameters: { type: 'object', properties: { note: { type: 'string' } } },
    }),
  };
  return tool as Tool;
}

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

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'desktop', title: 'Desktop', version: '3.2.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return client;
}

describe('MCPServer instructions', () => {
  it('reach a client in the handshake', async () => {
    const url = await serve(whoami([]), {
      sessions: true,
      instructions: 'End your turn after delegate.',
    });
    const client = await connect(url);

    expect(client.getInstructions()).toBe('End your turn after delegate.');
  });

  it('reach a client of the 2026-07-28 revision in server/discover', async () => {
    const url = await serve(whoami([]), { instructions: 'End your turn after delegate.' });

    const reply = await rawRequest(url, 'server/discover');

    expect(reply.result?.instructions).toBe('End your turn after delegate.');
  });

  it('are left out when the server has none', async () => {
    const url = await serve(whoami([]), { sessions: true });
    const client = await connect(url);

    expect(client.getInstructions()).toBeUndefined();
    expect((await rawRequest(url, 'server/discover')).result).not.toHaveProperty('instructions');
  });
});

describe('MCPServer request info', () => {
  it('hands a tool what the client sent next to the arguments, and who the client is', async () => {
    const seen: Seen[] = [];
    const url = await serve(whoami(seen), { sessions: true });
    const client = await connect(url);

    await client.callTool({
      name: 'whoami',
      arguments: { note: 'hi' },
      _meta: { threadId: 'thread-1', 'x-codex-turn-metadata': { turn_id: 'turn-7' } },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].request?.meta).toMatchObject({
      threadId: 'thread-1',
      'x-codex-turn-metadata': { turn_id: 'turn-7' },
    });
    expect(seen[0].request?.client).toEqual({
      name: 'desktop',
      title: 'Desktop',
      version: '3.2.1',
    });
  });

  it('names the client of every request on the 2026-07-28 revision, without the protocol keys', async () => {
    const seen: Seen[] = [];
    const url = await serve(whoami(seen));

    const reply = await rawRequest(url, 'tools/call', {
      params: { name: 'whoami', arguments: {} },
      meta: { 'claudecode/toolUseId': 'toolu_1' },
    });

    expect(reply.error).toBeUndefined();
    expect(seen[0].request?.client).toEqual({ name: 'raw', version: '1.0.0' });
    expect(seen[0].request?.meta).toEqual({ 'claudecode/toolUseId': 'toolu_1' });
  });

  it('knows no client when a request outside a session names none', async () => {
    const seen: Seen[] = [];
    const url = await serve(whoami(seen));
    const client = await connect(url);

    await client.callTool({ name: 'whoami', arguments: {} });

    expect(seen[0].request?.client).toBeUndefined();
    expect(seen[0].request?.meta).toBeUndefined();
  });

  it('keeps arguments outside the schema of a tool that takes them', async () => {
    const seen: Seen[] = [];
    const url = await serve(whoami(seen), { sessions: true });
    const client = await connect(url);

    await client.callTool({
      name: 'whoami',
      arguments: { note: 'hi', _bridge: { session: 'session-9' } },
    });

    expect(seen[0].args).toEqual({ note: 'hi', _bridge: { session: 'session-9' } });
  });
});
