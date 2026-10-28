import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import { MCPClient } from '../client/mcp-client';
import { encodeHeaderValue, mcpParamHeaders } from '../client/param-headers';
import { MCPServer } from '../server/mcp-server';
import type { MCPServerConfig } from '../types';
import { rawRequest } from './support/raw-mcp';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const regional = tool({
  name: 'run_query',
  description: 'Runs a query in a region',
  parameters: z.object({
    region: z.string().meta({ 'x-mcp-header': 'Region' }),
    query: z.string(),
  }),
  execute: async ({ region, query }) => `${query} in ${region}`,
}) as Tool;

async function serve(config: Partial<MCPServerConfig> = {}): Promise<string> {
  const server = new MCPServer({
    name: 'headers',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    ...config,
  });
  server.registerTool(regional);
  await server.start();
  cleanups.push(() => server.stop());
  return `http://127.0.0.1:${server.getPort()}/mcp`;
}

describe('Mcp-Param headers', () => {
  it('encodes values the way the protocol says', () => {
    expect(encodeHeaderValue('us-west1')).toBe('us-west1');
    expect(encodeHeaderValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=');
    expect(encodeHeaderValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=');
    expect(encodeHeaderValue('line1\nline2')).toBe('=?base64?bGluZTEKbGluZTI=?=');
    expect(encodeHeaderValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
  });

  it('mirrors annotated arguments, nested ones included, and leaves out missing ones', () => {
    const schema = {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        limit: { type: 'integer', 'x-mcp-header': 'Limit' },
        flag: { type: 'boolean', 'x-mcp-header': 'Flag' },
        target: {
          type: 'object',
          properties: { zone: { type: 'string', 'x-mcp-header': 'Zone' } },
        },
        absent: { type: 'string', 'x-mcp-header': 'Absent' },
      },
    };
    expect(
      mcpParamHeaders(schema, { region: 'eu', limit: 42, flag: false, target: { zone: 'b' } })
    ).toEqual({
      'Mcp-Param-Region': 'eu',
      'Mcp-Param-Limit': '42',
      'Mcp-Param-Flag': 'false',
      'Mcp-Param-Zone': 'b',
    });
  });

  it('sends them on calls past the SDK client, which the server checks against the body', async () => {
    const url = await serve({ tasks: { promoteAfterMs: 1000 } });
    const client = await MCPClient.connect({ transport: 'http', url });
    cleanups.push(() => client.close());
    const [definition] = await client.listToolDefinitions();
    expect(definition?.inputSchema.properties.region).toMatchObject({ 'x-mcp-header': 'Region' });
    expect(await client.callTool('run_query', { region: 'eu-1', query: 'select 1' })).toBe(
      'select 1 in eu-1'
    );
    const bare = await rawRequest(url, 'tools/call', {
      params: { name: 'run_query', arguments: { region: 'eu-1', query: 'select 1' } },
    });
    expect(bare.error?.code).toBe(-32020);
  });
});

describe('CORS and origins', () => {
  it("allows the MCP headers and a preflight's Mcp-Param headers", async () => {
    const url = await serve();
    const response = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, mcp-param-region, x-other',
      },
    });
    expect(response.status).toBe(204);
    const allowed = response.headers.get('access-control-allow-headers') ?? '';
    for (const name of ['MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name', 'mcp-param-region']) {
      expect(allowed).toContain(name);
    }
    expect(allowed).not.toContain('x-other');
  });

  it('takes only loopback origins by default on a loopback host, and requests without Origin', async () => {
    const url = await serve();
    const post = (origin?: string) =>
      fetch(url, {
        method: 'OPTIONS',
        headers: { ...(origin && { Origin: origin }) },
      });
    expect((await post('http://evil.test')).status).toBe(403);
    expect((await post('http://127.0.0.1:3000')).status).toBe(204);
    expect((await post('http://localhost:8080')).status).toBe(204);
    expect((await post()).status).toBe(204);
  });

  it('refuses an origin that is not allowed with 403', async () => {
    const url = await serve({ allowedOrigins: ['http://app.test'] });
    const denied = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'http://evil.test', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(denied.status).toBe(403);
    const allowed = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'http://app.test' },
    });
    expect(allowed.status).toBe(204);
  });
});

describe('who owns tasks and rounds', () => {
  it('refuses a caller auth lets in without a userId and without a credential', async () => {
    const url = await serve({ auth: () => ({ scopes: ['read'] }) });
    const bare = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(bare.status).toBe(401);
    expect(await bare.text()).toContain('no userId');
  });

  it('tells callers without a userId apart by their credential', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Takes a while',
      parameters: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'done';
      },
    }) as Tool;
    const server = new MCPServer({
      name: 'owners',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      tasks: { promoteAfterMs: 0 },
      auth: () => ({ scopes: ['read'] }),
    });
    server.registerTool(slow);
    await server.start();
    cleanups.push(() => server.stop());
    const url = `http://127.0.0.1:${server.getPort()}/mcp`;
    const tasks = { extensions: { 'io.modelcontextprotocol/tasks': {} } };

    const created = await rawRequest(url, 'tools/call', {
      capabilities: tasks,
      params: { name: 'slow', arguments: {} },
      headers: { Authorization: 'Bearer token-a' },
    });
    const taskId = String(created.result?.taskId);
    const other = await rawRequest(url, 'tasks/get', {
      capabilities: tasks,
      params: { taskId },
      headers: { Authorization: 'Bearer token-b' },
    });
    expect(other.error?.code).toBe(-32602);
    const same = await rawRequest(url, 'tasks/get', {
      capabilities: tasks,
      params: { taskId },
      headers: { Authorization: 'Bearer token-a' },
    });
    expect(same.result?.taskId).toBe(taskId);
  });
});
