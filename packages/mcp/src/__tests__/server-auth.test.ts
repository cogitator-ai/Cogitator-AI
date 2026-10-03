import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolContext } from '@cogitator-ai/types';
import { MCPServer } from '../server/mcp-server';
import { MCPClient } from '../client/mcp-client';
import type { MCPAuthFunction } from '../types';

const tokens: Record<string, string> = { 'token-alice': 'alice', 'token-bob': 'bob' };
const orders: Record<string, string[]> = { alice: ['A-1'], bob: ['B-1', 'B-2'] };

const bearer: MCPAuthFunction = (request) => {
  const header = request.headers.authorization ?? '';
  const userId = tokens[header.replace(/^Bearer /, '')];
  return userId ? { userId, scopes: ['orders:read'] } : undefined;
};

const myOrders: Tool<Record<string, never>> = {
  name: 'my_orders',
  description: 'Orders of the calling user',
  parameters: z.object({}),
  execute: async (_args, context: ToolContext) => ({
    userId: context.userId,
    orders: orders[context.userId ?? ''] ?? [],
  }),
  toJSON: () => ({
    name: 'my_orders',
    description: 'Orders of the calling user',
    parameters: { type: 'object', properties: {} },
  }),
};

describe('MCPServer auth', () => {
  let server: MCPServer;
  let url: string;
  const clients: MCPClient[] = [];

  const connect = async (token?: string) => {
    const client = await MCPClient.connect({
      transport: 'http',
      url,
      ...(token && { headers: { Authorization: `Bearer ${token}` } }),
    });
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    server = new MCPServer({
      name: 'orders',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      auth: bearer,
    });
    server.registerTool(myOrders);
    server.registerResource({
      uri: 'orders://mine',
      name: 'mine',
      mimeType: 'application/json',
      read: async (_params, caller) => ({
        uri: 'orders://mine',
        text: JSON.stringify(orders[caller?.userId ?? ''] ?? []),
      }),
    });
    server.registerPrompt({
      name: 'greeting',
      get: (_args, caller) => ({
        messages: [{ role: 'user', content: `Hello, ${caller?.userId ?? 'stranger'}` }],
      }),
    });
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}/mcp`;
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await server.stop();
  });

  it('answers 401 to requests without a known token', async () => {
    const anonymous = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const forged = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer token-mallory',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
    expect(forged.status).toBe(401);
    await expect(connect('token-mallory')).rejects.toThrow();
  });

  it('runs tools as the user the token belongs to', async () => {
    const alice = await connect('token-alice');
    const bob = await connect('token-bob');

    const [aliceOrders, bobOrders] = await Promise.all([
      alice.callTool('my_orders', {}),
      bob.callTool('my_orders', {}),
    ]);

    expect(aliceOrders).toEqual({ userId: 'alice', orders: ['A-1'] });
    expect(bobOrders).toEqual({ userId: 'bob', orders: ['B-1', 'B-2'] });
  });

  it('hands the caller to resources and prompts', async () => {
    const bob = await connect('token-bob');

    const resource = await bob.readResource('orders://mine');
    const prompt = await bob.getPrompt('greeting');

    expect(JSON.parse(resource.text ?? '')).toEqual(['B-1', 'B-2']);
    expect(prompt[0].content).toEqual({ type: 'text', text: 'Hello, bob' });
  });

  it('answers 401 when the auth function throws', async () => {
    const strict = new MCPServer({
      name: 'strict',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      auth: () => {
        throw new Error('token store down');
      },
    });
    await strict.start();

    const response = await fetch(`http://127.0.0.1:${strict.getPort()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    await strict.stop();
  });
});
