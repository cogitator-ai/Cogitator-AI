import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MCPClient, serveAgents, InMemoryMCPClientTaskStore } from '@cogitator-ai/mcp';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { Tool, ToolCall } from '@cogitator-ai/types';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

async function serveSlowAgent(delayMs: number, approval: boolean) {
  const deploys = vi.fn(async ({ env }: { env: string }) => `deployed to ${env}`);
  const deploy = tool({
    name: 'deploy',
    description: 'Deploy the app',
    parameters: z.object({ env: z.string() }),
    requiresApproval: approval,
    execute: deploys,
  }) as Tool;
  const backend = new MockLLMBackend().setResponses([
    {
      toolCalls: [call('d1', 'deploy', { env: 'prod' })],
      finishReason: 'tool_calls',
      delay: delayMs,
    },
    { content: 'Deployed to prod.', finishReason: 'stop' },
  ]);
  const cog = new Cogitator({
    llm: { backends: { mock: backend }, retry: false },
    memory: { adapter: 'memory' },
  });
  cleanups.push(() => cog.close());
  const agent = new Agent({
    name: 'release',
    model: 'mock/scripted',
    instructions: 'Ship releases.',
    tools: [deploy],
  });
  const server = await serveAgents(cog, agent, {
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    tasks: { promoteAfterMs: 100, pollIntervalMs: 250 },
  });
  cleanups.push(() => server.stop());
  return { url: `http://127.0.0.1:${server.getPort()}/mcp`, deploys };
}

describe('long agent runs as MCP tasks', () => {
  it('runs a slow agent as a task the client polls, its approval asked in the task', async () => {
    const { url, deploys } = await serveSlowAgent(600, true);
    const asked: string[] = [];
    const store = new InMemoryMCPClientTaskStore();
    const client = await MCPClient.connect({
      transport: 'http',
      url,
      tasks: { store },
      elicitation: async (request) => {
        asked.push(request.message);
        return { action: 'accept', content: { approve: true } };
      },
    });
    cleanups.push(() => client.close());

    const pending = client.callTool('release', { task: 'Ship it' }, { toolCallId: 'tc-release' });
    await vi.waitFor(async () => expect(await store.get('tc-release')).toBeDefined());
    const answer = (await pending) as { status: string; output: string };

    expect(answer).toMatchObject({ status: 'completed', output: 'Deployed to prod.' });
    expect(asked[0]).toContain('deploy');
    expect(deploys).toHaveBeenCalledTimes(1);
    expect(await store.get('tc-release')).toBeUndefined();
  });

  it('cancels the task, and its run, when the call aborts', async () => {
    const { url, deploys } = await serveSlowAgent(5000, false);
    const client = await MCPClient.connect({ transport: 'http', url });
    cleanups.push(() => client.close());
    const controller = new AbortController();
    const pending = client.callTool('release', { task: 'Ship it' }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stopped by the user')), 400);
    await expect(pending).rejects.toThrow('stopped by the user');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deploys).not.toHaveBeenCalled();
  });
});
