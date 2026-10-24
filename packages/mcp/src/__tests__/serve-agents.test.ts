import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type {
  Agent,
  AgentConfig,
  ResumeOptions,
  RunCheckpoint,
  RunInterrupt,
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

const confirmQuestion: RunInterrupt = {
  id: 'q1#0',
  kind: 'input',
  reason: 'confirm_plan',
  message: 'Go ahead with the move?',
  responseSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean', title: 'OK' } },
    required: ['ok'],
  },
  toolCallId: 'q1',
  toolName: 'confirm_plan',
};

const checkpoint = { version: 1, runId: 'run_1', threadId: 't1' } as RunCheckpoint;

/** A host whose runs pause on `questions`, one per run, and complete with the answers. */
function askingHost(...questions: RunInterrupt[]) {
  const waiting = [...questions];
  const pausedOn = () =>
    result({ status: 'paused', pendingApprovals: [], interrupts: [waiting[0]], checkpoint });
  const run = vi.fn(async () => pausedOn());
  const resume = vi.fn(
    async (_agent: Agent, _target: RunCheckpoint | string, options?: ResumeOptions) => {
      waiting.shift();
      if (waiting.length > 0) return pausedOn();
      return result({ output: `answered ${JSON.stringify(options?.responses)}` });
    }
  );
  const host: AgentHost = { run, resume };
  return { host, run, resume };
}

/** A host whose run pauses on `question` and whose resumes refuse the answers `refusals` times. */
function refusingHost(
  question: RunInterrupt,
  refusals: number,
  code = ErrorCode.INTERRUPT_ANSWER_INVALID
) {
  let left = refusals;
  const run = vi.fn(async () =>
    result({ status: 'paused', pendingApprovals: [], interrupts: [question], checkpoint })
  );
  const resume = vi.fn(
    async (_agent: Agent, _target: RunCheckpoint | string, options?: ResumeOptions) => {
      if (left > 0) {
        left--;
        throw new CogitatorError({
          message: `The answer to interrupt "${question.id}" does not match its schema: too short`,
          code,
          details: { interruptId: question.id },
        });
      }
      return result({ output: `answered ${JSON.stringify(options?.responses)}` });
    }
  );
  const host: AgentHost = { run, resume };
  return { host, run, resume };
}

async function elicitingClient(
  url: string,
  answers: Array<Record<string, string | number | boolean | string[]> | 'decline'>
) {
  const client = new Client(
    { name: 'desktop', version: '1.0.0' },
    { capabilities: { elicitation: {} } }
  );
  const asked: Array<{ message: string; requestedSchema: unknown }> = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asked.push({
      message: request.params.message,
      requestedSchema: 'requestedSchema' in request.params ? request.params.requestedSchema : null,
    });
    const next = answers.shift();
    return next === undefined || next === 'decline'
      ? { action: 'decline' }
      : { action: 'accept', content: next };
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  cleanups.push(() => client.close());
  return { client, asked };
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

  it('asks the questions of its tools through elicitation and resumes with the answers', async () => {
    const pick: RunInterrupt = {
      id: 'q2#0',
      kind: 'input',
      reason: 'pick_day',
      message: 'Which day?',
      responseSchema: { type: 'string', enum: ['mon', 'tue'] },
    };
    const { host, resume } = askingHost(confirmQuestion, pick);
    const url = await serveHttp(host, [fakeAgent('planner')]);
    const { client, asked } = await elicitingClient(url, [{ ok: true }, { answer: 'tue' }]);

    const reply = await client.callTool({ name: 'planner', arguments: { task: 'plan the move' } });

    expect(asked).toEqual([
      {
        message: 'Go ahead with the move?',
        requestedSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean', title: 'OK' } },
          required: ['ok'],
        },
      },
      {
        message: 'Which day?',
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'string', enum: ['mon', 'tue'] } },
          required: ['answer'],
        },
      },
    ]);
    expect(resume.mock.calls.map((call) => [call[1], call[2]?.responses])).toEqual([
      [checkpoint, { 'q1#0': { ok: true } }],
      [checkpoint, { 'q2#0': 'tue' }],
    ]);
    expect(reply.isError).toBeFalsy();
    expect(JSON.stringify(reply.content)).toContain('answered');
  });

  it('fails with the question when the client has no elicitation, never resuming', async () => {
    const { host, resume } = askingHost(confirmQuestion);
    const url = await serveHttp(host, [fakeAgent('planner')]);
    const client = await connectClient(url);

    await expect(client.callTool('planner', { task: 'plan the move' })).rejects.toThrow(
      'paused to ask confirm_plan ("Go ahead with the move?"), but this MCP client cannot answer elicitation requests'
    );
    expect(resume).not.toHaveBeenCalled();
  });

  it('fails with the question when the user declines to answer it', async () => {
    const { host, resume } = askingHost(confirmQuestion);
    const url = await serveHttp(host, [fakeAgent('planner')]);
    const { client } = await elicitingClient(url, ['decline']);

    const reply = await client.callTool({ name: 'planner', arguments: { task: 'plan the move' } });

    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply.content)).toContain('the user declined to answer');
    expect(resume).not.toHaveBeenCalled();
  });

  it('fails with the question when its schema is no flat form', async () => {
    const nested: RunInterrupt = {
      ...confirmQuestion,
      responseSchema: {
        type: 'object',
        properties: { stops: { type: 'array', items: { type: 'string' } } },
      },
    };
    const { host } = askingHost(nested);
    const url = await serveHttp(host, [fakeAgent('planner')]);
    const { client, asked } = await elicitingClient(url, [{ stops: 'a' }]);

    const reply = await client.callTool({ name: 'planner', arguments: { task: 'plan the move' } });

    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply.content)).toContain('not a flat form');
    expect(asked).toEqual([]);
  });

  it('carries the constraints of a question schema into the elicitation form', async () => {
    const booking: RunInterrupt = {
      ...confirmQuestion,
      id: 'q3#0',
      message: 'Book it?',
      responseSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email', minLength: 3, maxLength: 80, title: 'Email' },
          host: { type: 'string', format: 'hostname', pattern: '^[a-z.]+$' },
          seats: { type: 'integer', minimum: 1, maximum: 6, default: 2, description: 'Seats' },
          size: {
            type: 'string',
            oneOf: [
              { const: 's', title: 'Small' },
              { const: 'l', title: 'Large' },
            ],
          },
          day: { anyOf: [{ const: 'mon' }, { const: 'tue' }] },
          extras: {
            type: 'array',
            items: { type: 'string', enum: ['wifi', 'meal'] },
            minItems: 1,
            maxItems: 2,
          },
        },
        required: ['email', 'seats'],
      },
    };
    const { host } = askingHost(booking);
    const url = await serveHttp(host, [fakeAgent('planner')]);
    const { client, asked } = await elicitingClient(url, [
      { email: 'a@b.co', seats: 2, extras: ['wifi'] },
    ]);

    const reply = await client.callTool({ name: 'planner', arguments: { task: 'book' } });

    expect(reply.isError).toBeFalsy();
    expect(asked[0].requestedSchema).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string', title: 'Email', minLength: 3, maxLength: 80, format: 'email' },
        host: { type: 'string' },
        seats: { type: 'integer', description: 'Seats', minimum: 1, maximum: 6, default: 2 },
        size: {
          type: 'string',
          oneOf: [
            { const: 's', title: 'Small' },
            { const: 'l', title: 'Large' },
          ],
        },
        day: { type: 'string', enum: ['mon', 'tue'] },
        extras: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { type: 'string', enum: ['wifi', 'meal'] },
        },
      },
      required: ['email', 'seats'],
    });
  });

  it('asks again with why when the run refuses an answer, then resumes with the new one', async () => {
    const { host, resume } = refusingHost(confirmQuestion, 1);
    const url = await serveHttp(host, [fakeAgent('planner')]);
    const { client, asked } = await elicitingClient(url, [{ ok: false }, { ok: true }]);

    const reply = await client.callTool({ name: 'planner', arguments: { task: 'plan the move' } });

    expect(reply.isError).toBeFalsy();
    expect(asked.map((entry) => entry.message)).toEqual([
      'Go ahead with the move?',
      'That answer was refused: The answer to interrupt "q1#0" does not match its schema: too short\n\nGo ahead with the move?',
    ]);
    expect(resume.mock.calls.map((call) => call[2]?.responses)).toEqual([
      { 'q1#0': { ok: false } },
      { 'q1#0': { ok: true } },
    ]);
  });

  it('fails naming the question once its answers were refused three times', async () => {
    const { host, resume } = refusingHost(confirmQuestion, 10);
    const url = await serveHttp(host, [fakeAgent('planner')]);
    const { client, asked } = await elicitingClient(url, [
      { ok: false },
      { ok: false },
      { ok: false },
      { ok: true },
    ]);

    const reply = await client.callTool({ name: 'planner', arguments: { task: 'plan the move' } });

    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply.content)).toContain(
      'asked confirm_plan (\\"Go ahead with the move?\\") 3 times and refused every answer'
    );
    expect(asked).toHaveLength(3);
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it('does not ask again for a resume error other than a refused answer', async () => {
    const { host, resume } = refusingHost(confirmQuestion, 1, ErrorCode.VALIDATION_ERROR);
    const url = await serveHttp(host, [fakeAgent('planner')]);
    const { client, asked } = await elicitingClient(url, [{ ok: true }, { ok: true }]);

    const reply = await client.callTool({ name: 'planner', arguments: { task: 'plan the move' } });

    expect(reply.isError).toBe(true);
    expect(asked).toHaveLength(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('counts an elicitation nobody answers within elicitationTimeoutMs as dismissed', async () => {
    const { host, resume } = askingHost(confirmQuestion);
    const url = await serveHttp(host, [fakeAgent('planner')], { elicitationTimeoutMs: 1 });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new Client(
      { name: 'desktop', version: '1.0.0' },
      { capabilities: { elicitation: {} } }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => {
      await held;
      return { action: 'decline' };
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    cleanups.push(async () => {
      release();
      await client.close();
    });

    const reply = await client.callTool({ name: 'planner', arguments: { task: 'plan the move' } });

    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply.content)).toContain(
      'the user dismissed the question without answering'
    );
    expect(resume).not.toHaveBeenCalled();
  });
});
