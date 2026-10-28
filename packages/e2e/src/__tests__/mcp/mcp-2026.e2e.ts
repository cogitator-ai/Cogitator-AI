import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, serveAgents } from '@cogitator-ai/mcp';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { Tool, ToolCall } from '@cogitator-ai/types';

const MODERN = fileURLToPath(new URL('./fixtures/modern-stdio-server.mjs', import.meta.url));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

async function stdioClient(config: Partial<Parameters<typeof MCPClient.connect>[0]> = {}) {
  const client = await MCPClient.connect({
    transport: 'stdio',
    command: process.execPath,
    args: [MODERN],
    timeout: 30_000,
    ...config,
  });
  cleanups.push(() => client.close());
  return client;
}

describe('MCP 2026-07-28 between a Cogitator client and a Cogitator server', () => {
  it('speaks the new revision over stdio and carries a structured result of any shape', async () => {
    const client = await stdioClient();
    expect(client.era).toBe('modern');
    expect(client.discover()).toMatchObject({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'e2e-modern-stdio' },
    });
    const definitions = await client.listToolDefinitions();
    expect(definitions.find((d) => d.name === 'scores')?.outputSchema).toMatchObject({
      type: 'array',
    });
    expect(await client.callTool('scores', {})).toEqual([7, 3, 9]);
  });

  it('asks an approval through the elicitation handler as a multi round-trip request', async () => {
    const asked: string[] = [];
    const client = await stdioClient({
      elicitation: async (request) => {
        asked.push(request.message);
        return { action: 'accept', content: { approve: true } };
      },
    });
    expect(await client.callTool('archive_project', { project: 'atlas' })).toBe('archived atlas');
    expect(asked[0]).toContain('archive_project');
  });

  it("pauses an agent's run on a server's question and goes on once the run resumes with the answer", async () => {
    const client = await stdioClient();
    const tools = await client.getTools();
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('c1', 'paint_wall', {})], finishReason: 'tool_calls' },
      { content: 'The wall is green now.', finishReason: 'stop' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    cleanups.push(() => cog.close());
    const agent = new Agent({
      name: 'decorator',
      model: 'mock/scripted',
      instructions: 'Decorate.',
      tools,
    });

    const paused = await cog.run(agent, { input: 'Paint the wall' });
    expect(paused.status).toBe('paused');
    const question = paused.interrupts?.[0];
    expect(question).toMatchObject({
      reason: 'mcp_elicitation',
      message: 'Which color?',
      details: { server: 'e2e-modern-stdio', tool: 'paint_wall', mode: 'form' },
    });

    const done = await cog.resume(agent, paused.checkpoint!, {
      responses: { [question!.id]: { color: 'green' } },
    });
    expect(done.status).toBe('completed');
    const toolMessages = backend
      .getLastCall()
      ?.messages.filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
    expect(toolMessages?.[0]).toContain('painted green');
  });
});

describe('serveAgents on 2026-07-28', () => {
  it("asks an agent's approval with the round and resumes the run with the decision", async () => {
    const refunds = vi.fn(async ({ amount }: { amount: number }) => `refunded ${amount}`);
    const refund = tool({
      name: 'refund',
      description: 'Refund money',
      parameters: z.object({ amount: z.number() }),
      requiresApproval: true,
      execute: refunds,
    }) as Tool;
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('r1', 'refund', { amount: 40 })], finishReason: 'tool_calls' },
      { content: 'Refunded 40.', finishReason: 'stop' },
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      memory: { adapter: 'memory' },
    });
    cleanups.push(() => cog.close());
    const support = new Agent({
      name: 'support',
      model: 'mock/scripted',
      instructions: 'Help customers.',
      tools: [refund],
    });
    const server: MCPServer = await serveAgents(cog, support, {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      tasks: false,
    });
    cleanups.push(() => server.stop());

    const asked: string[] = [];
    const client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${server.getPort()}/mcp`,
      elicitation: async (request) => {
        asked.push(request.message);
        return { action: 'accept', content: { approve: true } };
      },
    });
    cleanups.push(() => client.close());
    expect(client.era).toBe('modern');

    const answer = (await client.callTool('support', { task: 'Refund 40 to Ann' })) as {
      status: string;
      output: string;
    };
    expect(answer).toMatchObject({ status: 'completed', output: 'Refunded 40.' });
    expect(asked[0]).toContain('refund');
    expect(refunds).toHaveBeenCalledTimes(1);
  });
});
