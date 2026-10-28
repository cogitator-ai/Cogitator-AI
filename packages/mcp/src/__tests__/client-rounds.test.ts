import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type {
  Agent,
  AgentConfig,
  InterruptRequest,
  RunOptions,
  RunResult,
  Tool,
  ToolApprovalRequest,
} from '@cogitator-ai/types';
import { MCPClient } from '../client/mcp-client';
import { InMemoryMCPClientRoundStore } from '../client/rounds';
import { MCPServer } from '../server/mcp-server';
import { serveAgents, type AgentHost } from '../server/serve-agents';
import type { MCPClientConfig, MCPToolContext } from '../types';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class Paused extends Error {}

/**
 * The interrupt of one run of a tool call, the way a Cogitator run answers it: the n-th question
 * of the call reads the n-th answer given so far, and one without an answer pauses the run
 */
function runOf(answers: unknown[], asked: InterruptRequest<unknown>[] = []) {
  let next = 0;
  return async <T>(request: InterruptRequest<T>): Promise<T> => {
    asked.push(request as InterruptRequest<unknown>);
    if (next < answers.length) return answers[next++] as T;
    throw new Paused('paused');
  };
}

async function serveTools(tools: Tool[]): Promise<string> {
  const server = new MCPServer({
    name: 'rounds',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    tasks: false,
  });
  server.registerTools(tools);
  await server.start();
  cleanups.push(() => server.stop());
  return `http://127.0.0.1:${server.getPort()}/mcp`;
}

async function connect(url: string, config: Partial<MCPClientConfig> = {}) {
  const client = await MCPClient.connect({ transport: 'http', url, ...config });
  cleanups.push(() => client.close());
  return client;
}

function surveyTool() {
  const effects = vi.fn();
  const runs = vi.fn();
  const survey = tool({
    name: 'survey',
    description: 'Books a room, then asks two questions',
    parameters: z.object({ room: z.string() }),
    execute: async ({ room }, context) => {
      runs();
      effects(`booked ${room}`);
      const elicit = (context as MCPToolContext).elicit!;
      const first = await elicit({
        message: 'Name?',
        schema: { type: 'object', properties: { name: { type: 'string' } } },
      });
      const second = await elicit({
        message: 'Guests?',
        schema: { type: 'object', properties: { guests: { type: 'number' } } },
      });
      return `${room}: ${JSON.stringify(first)} ${JSON.stringify(second)}`;
    },
  }) as Tool;
  return { survey, effects, runs };
}

describe('a call whose run pauses on a server question', () => {
  it('answers the round the server asked in when the run resumes, without calling anew', async () => {
    const { survey, effects, runs } = surveyTool();
    const url = await serveTools([survey]);
    const client = await connect(url);
    const call = (interrupt: ReturnType<typeof runOf>) =>
      client.callTool('survey', { room: 'blue' }, { toolCallId: 'tc-1', interrupt });

    const asked: InterruptRequest<unknown>[] = [];
    await expect(call(runOf([], asked))).rejects.toBeInstanceOf(Paused);
    await expect(call(runOf([{ name: 'Ann' }], asked))).rejects.toBeInstanceOf(Paused);
    const value = await call(runOf([{ name: 'Ann' }, { guests: 3 }], asked));

    expect(value).toContain('"name":"Ann"');
    expect(value).toContain('"guests":3');
    expect(runs).toHaveBeenCalledTimes(1);
    expect(effects).toHaveBeenCalledTimes(1);
    expect(asked.map((request) => request.message)).toEqual([
      'Name?',
      'Name?',
      'Guests?',
      'Name?',
      'Guests?',
    ]);
  });

  it('lets the run interrupt through unchanged, even when its question mentions a connection', async () => {
    const { survey } = surveyTool();
    const url = await serveTools([survey]);
    const client = await connect(url);
    class ToolInterruptSignal extends Error {
      constructor(readonly interrupt: { message: string }) {
        super(`Tool "survey" waits for an answer: ${interrupt.message}`);
        this.name = 'ToolInterruptSignal';
      }
    }
    const signal = new ToolInterruptSignal({
      message: 'Should the closed connection be reopened?',
    });
    const reconnect = vi.spyOn(client, 'reconnect');
    await expect(
      client.callTool(
        'survey',
        { room: 'blue' },
        {
          toolCallId: 'tc-signal',
          interrupt: async () => {
            throw signal;
          },
        }
      )
    ).rejects.toBe(signal);
    expect(reconnect).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(true);
  });

  it('calls anew for other arguments, and once the kept round expired', async () => {
    const { survey, runs } = surveyTool();
    const url = await serveTools([survey]);
    const store = new InMemoryMCPClientRoundStore();
    const client = await connect(url, { rounds: { store, ttlMs: 200 } });

    await expect(
      client.callTool('survey', { room: 'blue' }, { toolCallId: 'tc-2', interrupt: runOf([]) })
    ).rejects.toBeInstanceOf(Paused);
    expect(await store.get('tc-2')).toMatchObject({ tool: 'survey', round: [{ key: 'elicit:1' }] });
    await expect(
      client.callTool('survey', { room: 'red' }, { toolCallId: 'tc-2', interrupt: runOf([]) })
    ).rejects.toBeInstanceOf(Paused);
    expect(runs).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await store.get('tc-2')).toBeUndefined();
  });

  it('forgets the round once the call ends', async () => {
    const { survey } = surveyTool();
    const url = await serveTools([survey]);
    const store = new InMemoryMCPClientRoundStore();
    const client = await connect(url, { rounds: { store } });
    await client.callTool(
      'survey',
      { room: 'x' },
      {
        toolCallId: 'tc-3',
        interrupt: runOf([{ name: 'A' }, { guests: 1 }]),
      }
    );
    expect(await store.get('tc-3')).toBeUndefined();
  });
});

describe('an agent served over MCP whose approval pauses the calling run', () => {
  it('resumes the served run with the decision instead of starting another', async () => {
    const pending: ToolApprovalRequest = {
      toolCallId: 'c1',
      toolName: 'refund',
      arguments: { amount: 5 },
      description: 'Refund money',
    };
    const run = vi.fn(async (_agent: Agent, options: RunOptions) => {
      await options.onApproval?.(pending);
      return result({ status: 'paused', pendingApprovals: [pending] });
    });
    const resume = vi.fn(async () => result({ output: 'refunded' }));
    const host: AgentHost = { run, resume };
    const server = await serveAgents(host, [fakeAgent('support')], {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      tasks: false,
    });
    cleanups.push(() => server.stop());
    const client = await connect(`http://127.0.0.1:${server.getPort()}/mcp`);
    const call = (interrupt: ReturnType<typeof runOf>) =>
      client.callTool('support', { task: 'refund 5' }, { toolCallId: 'agent-call', interrupt });

    await expect(call(runOf([]))).rejects.toBeInstanceOf(Paused);
    const answer = await call(runOf([{ approve: true }]));

    expect(answer).toMatchObject({ status: 'completed', output: 'refunded' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

function fakeAgent(name: string): Agent {
  const config: AgentConfig = { name, instructions: `You are ${name}.` };
  return {
    id: `agent_${name}`,
    name,
    config,
    model: 'mock/m',
    instructions: config.instructions,
    tools: [],
    clone: () => fakeAgent(name),
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
