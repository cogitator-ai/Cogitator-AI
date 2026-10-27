import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { experimental_mcpConnector, mcpClientConfigOf } from '../client/connector';

const SERVER = join(__dirname, 'fixtures', 'ping-server.mjs');

describe('experimental_mcpConnector', () => {
  it('reads .mcp.json servers as client configs', () => {
    expect(
      mcpClientConfigOf('a', { command: 'node', args: ['s.js'], env: { A: '1' } })
    ).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['s.js'],
      env: { A: '1' },
    });
    expect(
      mcpClientConfigOf('b', { type: 'sse', url: 'https://mcp.example.com/sse' })
    ).toMatchObject({ transport: 'legacy-sse', url: 'https://mcp.example.com/sse' });
    expect(
      mcpClientConfigOf('c', { url: 'https://mcp.example.com/', headers: { A: 'b' } })
    ).toMatchObject({ transport: 'http', headers: { A: 'b' } });
    expect(() => mcpClientConfigOf('d', { args: [] })).toThrow(/needs a command or a url/);
  });

  it('connects a stdio server and names its tools mcp__<server>__<tool>', async () => {
    const connect = experimental_mcpConnector();
    const connection = await connect(
      [
        {
          name: 'plugin:demo:srv',
          config: { command: process.execPath, args: [SERVER], env: { DEMO_VALUE: 'from-env' } },
        },
      ],
      { agent: 'demo@inline', signal: new AbortController().signal }
    );
    try {
      const names = connection.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(['mcp__plugin_demo_srv__env', 'mcp__plugin_demo_srv__ping']);
      const ping = connection.tools.find((tool) => tool.name === 'mcp__plugin_demo_srv__ping');
      expect(ping?.mcp).toEqual({ server: 'plugin:demo:srv', tool: 'ping' });
      const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
      expect(await ping?.execute({ word: 'back' }, context)).toBe('pong back');
      const env = connection.tools.find((tool) => tool.name === 'mcp__plugin_demo_srv__env');
      expect(await env?.execute({ name: 'DEMO_VALUE' }, context)).toBe('from-env');
    } finally {
      await connection.close();
    }
  });

  it('connects a server of the older HTTP+SSE protocol for type sse, its headers on every request', async () => {
    const seen: string[] = [];
    const transports = new Map<string, SSEServerTransport>();
    const http = createServer((request, response: ServerResponse) => {
      seen.push(`${request.method} ${request.url?.split('?')[0]} ${request.headers.authorization}`);
      if (request.method === 'GET' && request.url === '/sse') {
        const transport = new SSEServerTransport('/messages', response);
        transports.set(transport.sessionId, transport);
        const server = new McpServer({ name: 'legacy', version: '1.0.0' });
        server.registerTool(
          'ping',
          { description: 'Answers pong', inputSchema: { word: z.string().optional() } },
          async ({ word }) => ({ content: [{ type: 'text', text: `pong ${word ?? ''}`.trim() }] })
        );
        void server.connect(transport);
        return;
      }
      const session = new URL(request.url ?? '/', 'http://local').searchParams.get('sessionId');
      const transport = session ? transports.get(session) : undefined;
      if (request.method === 'POST' && transport) {
        void transport.handlePostMessage(request, response);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/sse`;
    const connection = await experimental_mcpConnector()(
      [{ name: 'legacy', config: { type: 'sse', url, headers: { Authorization: 'Bearer t-1' } } }],
      { agent: 'demo@inline', signal: new AbortController().signal }
    );
    try {
      const ping = connection.tools.find((tool) => tool.name === 'mcp__legacy__ping');
      const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
      expect(await ping?.execute({ word: 'sse' }, context)).toBe('pong sse');
      expect(seen[0]).toBe('GET /sse Bearer t-1');
      expect(seen.slice(1).every((line) => line === 'POST /messages Bearer t-1')).toBe(true);
    } finally {
      await connection.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
