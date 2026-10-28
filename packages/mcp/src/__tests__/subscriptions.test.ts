import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { MCPClient } from '../client/mcp-client';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function modernServer(): Promise<{ url: string; handler: McpHttpHandler }> {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'changing', version: '1.0.0' },
      { capabilities: { tools: { listChanged: true }, resources: { subscribe: true } } }
    );
    server.registerTool('first', { description: 'First', inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'first' }],
    }));
    server.registerResource('notes', 'notes://today', {}, async (uri) => ({
      contents: [{ uri: uri.href, text: 'notes' }],
    }));
    return server;
  });
  const serve = toNodeHandler(handler);
  const http: Server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await handler.close();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
  });
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, handler };
}

describe('MCPClient.subscribe', () => {
  it('opens a subscriptions/listen stream on protocol 2026-07-28', async () => {
    const { url, handler } = await modernServer();
    const client = await MCPClient.connect({ transport: 'http', url });
    cleanups.push(() => client.close());
    expect(client.era).toBe('modern');

    const onToolsChanged = vi.fn();
    const onResourceUpdated = vi.fn();
    const onPromptsChanged = vi.fn();
    const subscription = await client.subscribe(
      {
        toolsListChanged: true,
        promptsListChanged: true,
        resourceSubscriptions: ['notes://today'],
      },
      { onToolsChanged, onResourceUpdated, onPromptsChanged }
    );
    expect(subscription.filter).toMatchObject({
      toolsListChanged: true,
      resourceSubscriptions: ['notes://today'],
    });

    handler.notify.toolsChanged();
    handler.notify.resourceUpdated('notes://today');
    handler.notify.resourceUpdated('notes://other');
    await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onResourceUpdated).toHaveBeenCalledWith('notes://today'));
    expect(onResourceUpdated).toHaveBeenCalledTimes(1);

    await subscription.close();
    expect(await subscription.closed).toBe('local');
    handler.notify.toolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onToolsChanged).toHaveBeenCalledTimes(1);
  });

  it('hears the list changes a server of 2025-11-25 sends on its own', async () => {
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: process.execPath,
      args: [join(__dirname, 'fixtures', 'changing-server.mjs')],
    });
    cleanups.push(() => client.close());
    expect(client.era).toBe('legacy');
    expect((await client.listToolDefinitions()).map((tool) => tool.name)).toEqual(['first']);

    const onToolsChanged = vi.fn();
    const subscription = await client.subscribe({ toolsListChanged: true }, { onToolsChanged });
    expect(subscription.filter).toEqual({ toolsListChanged: true });

    await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalled(), { timeout: 3000 });
    expect((await client.listToolDefinitions()).map((tool) => tool.name).sort()).toEqual([
      'first',
      'second',
    ]);
    await subscription.close();
    expect(await subscription.closed).toBe('local');
  });
});
