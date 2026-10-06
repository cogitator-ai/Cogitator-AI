import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  Agent,
  AgentConfig,
  RunOptions,
  RunResult,
  Tool,
  ToolApprovalDecision,
} from '@cogitator-ai/types';
import { agentTools, serveAgents, type AgentHost } from '../server/serve-agents';
import type { MCPServer } from '../server/mcp-server';
import { MCPClient } from '../client/mcp-client';

const refundTool: Tool<{ amount: number }> = {
  name: 'refund',
  description: 'Refund money',
  parameters: z.object({ amount: z.number() }),
  requiresApproval: true,
  execute: async () => 'ok',
  toJSON: () => ({
    name: 'refund',
    description: 'Refund money',
    parameters: { type: 'object', properties: {} },
  }),
};

function fakeAgent(name: string, config: Partial<AgentConfig> = {}): Agent {
  const full: AgentConfig = { name, instructions: `You are ${name}. Be useful.`, ...config };
  return {
    id: `agent_${name}`,
    name,
    config: full,
    model: 'mock/m',
    instructions: full.instructions,
    tools: full.tools ?? [],
    clone: () => fakeAgent(name, config),
    serialize: () => {
      throw new Error('unused');
    },
  };
}

function result(partial: Partial<RunResult>): RunResult {
  return {
    output: '',
    runId: 'run_1',
    agentId: 'a',
    threadId: 't1',
    status: 'completed',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
    messages: [],
    trace: { traceId: 'tr', spans: [] },
    ...partial,
  };
}

const pending = {
  toolCallId: 'c1',
  toolName: 'refund',
  arguments: { amount: 500 },
  description: 'Refund money',
};

/** A host whose runs ask for one approval and complete or pause on the decision. */
function approvingHost() {
  const decisions: Array<ToolApprovalDecision | 'pause'> = [];
  const run = vi.fn(async (_agent: Agent, options: RunOptions) => {
    const decision = (await options.onApproval?.(pending)) ?? 'pause';
    decisions.push(decision);
    if (decision === 'pause') return result({ status: 'paused', pendingApprovals: [pending] });
    return result({ output: decision.approved ? 'refunded' : 'not refunded' });
  });
  const resume = vi.fn(async () => result({ output: 'refunded after resume' }));
  const host: AgentHost = { run, resume };
  return { host, run, resume, decisions };
}

let server: MCPServer | undefined;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await server?.stop();
  server = undefined;
});

async function serveHttp(
  host: AgentHost,
  agents: Agent[],
  auth?: Parameters<typeof serveAgents>[2]
) {
  server = await serveAgents(host, agents, {
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    ...auth,
  });
  return `http://127.0.0.1:${server.getPort()}/mcp`;
}

async function connectClient(url: string, headers?: Record<string, string>) {
  const client = await MCPClient.connect({ transport: 'http', url, ...(headers && { headers }) });
  cleanups.push(() => client.close());
  return client;
}

describe('serveAgents', () => {
  it('serves each agent as a tool and a resume tool for agents that need approvals', async () => {
    const host: AgentHost = { run: vi.fn(), resume: vi.fn() };
    const url = await serveHttp(host, [
      fakeAgent('Research Assistant', { description: 'Researches topics' }),
      fakeAgent('support', { tools: [refundTool] }),
    ]);
    const client = await connectClient(url);

    const tools = await client.listToolDefinitions();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'Research_Assistant',
      'support',
      'support_resume',
    ]);
    expect(tools.find((t) => t.name === 'Research_Assistant')?.description).toBe(
      'Researches topics'
    );
    expect(tools.find((t) => t.name === 'support')?.description).toBe(
      'Ask the support agent. You are support.'
    );
  });

  it('adds a resume tool only for agents with a tool that can ask for approval', () => {
    const host: AgentHost = { run: vi.fn(), resume: vi.fn() };
    const withApproval = (requiresApproval: Tool['requiresApproval']): Tool => ({
      ...refundTool,
      requiresApproval,
    });

    const names = agentTools(host, [
      fakeAgent('never', { tools: [withApproval(false)] }),
      fakeAgent('unset', { tools: [withApproval(undefined)] }),
      fakeAgent('always', { tools: [withApproval(true)] }),
      fakeAgent('sometimes', { tools: [withApproval(() => false)] }),
    ]).map((t) => t.name);

    expect(names).toEqual([
      'never',
      'unset',
      'always',
      'always_resume',
      'sometimes',
      'sometimes_resume',
    ]);
  });

  it('runs the agent for the authenticated caller and returns its answer', async () => {
    const run = vi.fn(async (_agent: Agent, options: RunOptions) =>
      result({ output: `answer to ${options.input}`, threadId: 'th-9' })
    );
    const url = await serveHttp({ run, resume: vi.fn() }, [fakeAgent('helper')], {
      auth: (request) =>
        request.headers.authorization === 'Bearer t-ann' ? { userId: 'ann' } : undefined,
    });
    const client = await connectClient(url, { Authorization: 'Bearer t-ann' });

    const answer = await client.callTool('helper', { task: 'plan a trip', threadId: 'th-9' });

    expect(answer).toEqual({
      status: 'completed',
      output: 'answer to plan a trip',
      threadId: 'th-9',
    });
    expect(run.mock.calls[0][1]).toMatchObject({
      input: 'plan a trip',
      threadId: 'th-9',
      userId: 'ann',
    });
  });

  it('runs its tool calls through the host when the host is a tool invoker', async () => {
    const { host } = approvingHost();
    const invokeTool = vi.fn<NonNullable<AgentHost['invokeTool']>>(async (tool, args, options) => ({
      callId: options?.toolCallId ?? 'call',
      name: tool.name,
      result: await tool.execute(args, {
        agentId: 'mcp-server',
        runId: 'r',
        signal: new AbortController().signal,
      }),
    }));
    const url = await serveHttp({ ...host, invokeTool }, [fakeAgent('support')]);
    const client = await connectClient(url);

    await client.callTool('support', { task: 'hello' });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'support' }),
      { task: 'hello' },
      expect.objectContaining({ agentId: 'mcp-server' })
    );
  });

  it('asks the user at the client through elicitation', async () => {
    const { host, decisions } = approvingHost();
    const url = await serveHttp(host, [fakeAgent('support', { tools: [refundTool] })]);
    const client = new Client(
      { name: 'desktop', version: '1.0.0' },
      { capabilities: { elicitation: {} } }
    );
    const asked: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return { action: 'accept', content: { approve: true } };
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    cleanups.push(() => client.close());

    const reply = await client.callTool({ name: 'support', arguments: { task: 'refund 500' } });

    expect(decisions).toEqual([{ approved: true }]);
    expect(asked[0]).toContain('refund');
    expect(JSON.stringify(reply.content)).toContain('refunded');
  });

  it('pauses for clients without elicitation and resumes with their decision', async () => {
    const { host, resume } = approvingHost();
    const url = await serveHttp(host, [fakeAgent('support', { tools: [refundTool] })]);
    const client = await connectClient(url);

    const paused = await client.callTool('support', { task: 'refund 500' });
    const done = await client.callTool('support_resume', {
      threadId: 't1',
      approved: false,
      reason: 'too much',
    });

    expect(paused).toMatchObject({ status: 'paused', threadId: 't1', pendingApprovals: [pending] });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'support' }),
      't1',
      expect.objectContaining({ defaultDecision: { approved: false, reason: 'too much' } })
    );
    expect(done).toMatchObject({ status: 'completed', output: 'refunded after resume' });
  });
});
