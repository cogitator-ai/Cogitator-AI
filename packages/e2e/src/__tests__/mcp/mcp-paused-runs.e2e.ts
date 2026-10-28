import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, serveAgents, type MCPToolContext } from '@cogitator-ai/mcp';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { Tool, ToolCall } from '@cogitator-ai/types';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

function scriptedCogitator(responses: Parameters<MockLLMBackend['setResponses']>[0]) {
  const backend = new MockLLMBackend().setResponses(responses);
  const cog = new Cogitator({
    llm: { backends: { mock: backend }, retry: false },
    memory: { adapter: 'memory' },
  });
  cleanups.push(() => cog.close());
  return { cog, backend };
}

describe('a run that pauses on an MCP server question and resumes', () => {
  it('answers the round the server waits in: the tool runs once on the server', async () => {
    const bookings = vi.fn();
    const book = tool({
      name: 'book_room',
      description: 'Book a room, asking for the guest name',
      parameters: z.object({ room: z.string() }),
      execute: async ({ room }, context) => {
        bookings(room);
        const reply = await (context as MCPToolContext).elicit?.({
          message: 'Guest name?',
          schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        });
        return reply?.action === 'accept'
          ? `booked ${room} for ${String(reply.content.name)}`
          : 'not booked';
      },
    }) as Tool;
    const server = new MCPServer({
      name: 'hotel',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
    });
    server.registerTool(book);
    await server.start();
    cleanups.push(() => server.stop());
    const client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${server.getPort()}/mcp`,
    });
    cleanups.push(() => client.close());

    const { cog, backend } = scriptedCogitator([
      { toolCalls: [call('c1', 'book_room', { room: '12' })], finishReason: 'tool_calls' },
      { content: 'Booked.', finishReason: 'stop' },
    ]);
    const agent = new Agent({
      name: 'concierge',
      model: 'mock/scripted',
      instructions: 'Book rooms.',
      tools: await client.getTools(),
    });

    const paused = await cog.run(agent, { input: 'Book room 12' });
    expect(paused.status).toBe('paused');
    const question = paused.interrupts?.[0];
    expect(question?.message).toBe('Guest name?');

    const done = await cog.resume(agent, paused.checkpoint!, {
      responses: { [question!.id]: { name: 'Ann' } },
    });
    expect(done.status).toBe('completed');
    const toolMessage = backend.getLastCall()?.messages.find((message) => message.role === 'tool');
    expect(String(toolMessage?.content)).toContain('booked 12 for Ann');
    expect(bookings).toHaveBeenCalledTimes(1);
  });

  it("resumes the served agent's run with the approval instead of starting another", async () => {
    const refunds = vi.fn(async ({ amount }: { amount: number }) => `refunded ${amount}`);
    const refund = tool({
      name: 'refund',
      description: 'Refund money',
      parameters: z.object({ amount: z.number() }),
      requiresApproval: true,
      execute: refunds,
    }) as Tool;
    const inner = scriptedCogitator([
      { toolCalls: [call('r1', 'refund', { amount: 30 })], finishReason: 'tool_calls' },
      { content: 'Refunded 30.', finishReason: 'stop' },
    ]);
    const support = new Agent({
      name: 'support',
      model: 'mock/scripted',
      instructions: 'Help customers.',
      tools: [refund],
    });
    const server = await serveAgents(inner.cog, support, {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      tasks: false,
    });
    cleanups.push(() => server.stop());
    const client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${server.getPort()}/mcp`,
    });
    cleanups.push(() => client.close());

    const outer = scriptedCogitator([
      {
        toolCalls: [call('o1', 'support', { task: 'Refund 30 to Bo' })],
        finishReason: 'tool_calls',
      },
      { content: 'Support refunded it.', finishReason: 'stop' },
    ]);
    const front = new Agent({
      name: 'front_desk',
      model: 'mock/scripted',
      instructions: 'Route requests.',
      tools: (await client.getTools()).filter((t) => t.name === 'support'),
    });

    const paused = await outer.cog.run(front, { input: 'Bo wants 30 back' });
    expect(paused.status).toBe('paused');
    const question = paused.interrupts?.[0];
    expect(question?.reason).toBe('mcp_elicitation');
    expect(question?.message).toContain('refund');

    const done = await outer.cog.resume(front, paused.checkpoint!, {
      responses: { [question!.id]: { approve: true } },
    });
    expect(done.status).toBe('completed');
    expect(refunds).toHaveBeenCalledTimes(1);
    expect(inner.backend.getCallCount()).toBe(2);
  });
});
