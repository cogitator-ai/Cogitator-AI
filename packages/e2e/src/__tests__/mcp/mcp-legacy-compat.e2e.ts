import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer } from '@cogitator-ai/mcp';
import type { Tool } from '@cogitator-ai/types';

const LEGACY = fileURLToPath(new URL('./fixtures/legacy-server.mjs', import.meta.url));
const MODERN = fileURLToPath(new URL('./fixtures/modern-stdio-server.mjs', import.meta.url));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('a Cogitator client and a server of 2025-11-25', () => {
  it('falls back to initialize and calls its tools', async () => {
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: process.execPath,
      args: [LEGACY],
      timeout: 30_000,
    });
    cleanups.push(() => client.close());
    expect(client.era).toBe('legacy');
    expect(client.protocolVersion).toBe('2025-11-25');
    expect(await client.callTool('shout', { text: 'hi' })).toBe('HI');
  });

  it("answers the server's own elicitation request with the elicitation handler", async () => {
    const asked: string[] = [];
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: process.execPath,
      args: [LEGACY],
      timeout: 30_000,
      elicitation: async (request) => {
        asked.push(request.message);
        return { action: 'accept', content: { yes: true } };
      },
    });
    cleanups.push(() => client.close());
    expect(await client.callTool('confirm_delete', { path: '/tmp/x' })).toBe('deleted /tmp/x');
    expect(asked).toEqual(['Delete /tmp/x?']);
  });
});

describe('a client of 2025-11-25 and a Cogitator server', () => {
  it('reaches a stdio server with initialize and gets the structured result wrapped', async () => {
    const client = new Client({ name: 'old', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MODERN] }));
    cleanups.push(() => client.close());
    const result = await client.callTool({ name: 'scores', arguments: {} });
    expect(result.structuredContent).toEqual({ result: [7, 3, 9] });
  });

  it('asks approvals through elicitation requests over HTTP sessions', async () => {
    const archive = tool({
      name: 'archive_project',
      description: 'Archive a project',
      parameters: z.object({ project: z.string() }),
      requiresApproval: true,
      execute: async ({ project }) => `archived ${project}`,
    }) as Tool;
    const server = new MCPServer({
      name: 'compat',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      sessions: true,
    });
    server.registerTool(archive);
    await server.start();
    cleanups.push(() => server.stop());

    const asked: string[] = [];
    const client = new Client(
      { name: 'old', version: '1.0.0' },
      { capabilities: { elicitation: {} } }
    );
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return { action: 'accept', content: { approve: true } };
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.getPort()}/mcp`))
    );
    cleanups.push(() => client.close());

    const result = await client.callTool({ name: 'archive_project', arguments: { project: 'x' } });
    expect(result.content).toEqual([{ type: 'text', text: 'archived x' }]);
    expect(asked[0]).toContain('archive_project');
  });
});
