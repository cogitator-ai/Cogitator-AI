import { describe, it, expect, vi } from 'vitest';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import type { AgentRunResult, CogitatorLike } from '../types';
import { collect, expectResponse, userMessage } from './helpers';

type RunOptions = Parameters<CogitatorLike['run']>[1];

function mockAgent(timeout?: number): Agent {
  const config: AgentConfig = {
    name: 'helper',
    model: 'test',
    instructions: 'test',
    ...(timeout !== undefined && { timeout }),
  };
  return {
    id: 'agent_helper',
    name: 'helper',
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

function runResult(): AgentRunResult {
  return {
    output: 'ok',
    runId: 'run',
    agentId: 'agent',
    threadId: 'thread',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
  };
}

function setup(agentTimeout?: number, maxRunTimeoutMs?: number) {
  const run = vi.fn(async (_agent: unknown, _options: RunOptions) => runResult());
  const server = new A2AServer({
    agents: { helper: mockAgent(agentTimeout) },
    cogitator: { run },
    ...(maxRunTimeoutMs !== undefined && { maxRunTimeoutMs }),
  });
  const send = async (timeout: number) =>
    expectResponse(
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('hi'), configuration: { timeout } },
        id: 1,
      })
    );
  const stream = (timeout: number) =>
    collect(
      server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('hi'), configuration: { timeout } },
        id: 1,
      })
    );
  return { run, server, send, stream };
}

describe('a client timeout never lifts the operator run timeout', () => {
  it.each([0, -1, 1.5])('refuses timeout %s on message/send and message/stream', async (bad) => {
    const { run, send, stream } = setup(30_000);

    const sent = await send(bad);
    const streamed = await stream(bad);

    expect(sent.error?.code).toBe(-32602);
    expect(streamed).toHaveLength(1);
    expect(streamed[0].error?.code).toBe(-32602);
    expect(run).not.toHaveBeenCalled();
  });

  it('caps a longer client timeout at the agent timeout, on both paths', async () => {
    const { run, send, stream } = setup(30_000);

    await send(600_000);
    await stream(600_000);

    expect(run.mock.calls.map(([, options]) => options.timeout)).toEqual([30_000, 30_000]);
  });

  it('caps the client timeout at maxRunTimeoutMs for an agent without one', async () => {
    const byDefault = setup();
    await byDefault.send(10 * 24 * 60 * 60 * 1000);
    expect(byDefault.run.mock.calls[0][1].timeout).toBe(120_000);

    const configured = setup(undefined, 300_000);
    await configured.send(10 * 24 * 60 * 60 * 1000);
    expect(configured.run.mock.calls[0][1].timeout).toBe(300_000);
  });

  it('lets a client shorten a run', async () => {
    const { run, send } = setup(30_000);
    await send(5_000);
    expect(run.mock.calls[0][1].timeout).toBe(5_000);
  });

  it('leaves the timeout to the agent when the client sets none', async () => {
    const { run, server } = setup(30_000);
    await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'message/send',
      params: { message: userMessage('hi') },
      id: 1,
    });
    expect(run.mock.calls[0][1].timeout).toBeUndefined();
  });

  it('refuses a maxRunTimeoutMs no timer can hold', () => {
    for (const maxRunTimeoutMs of [0, -5, 2.5, 3e9]) {
      expect(
        () =>
          new A2AServer({
            agents: { helper: mockAgent() },
            cogitator: { run: async () => runResult() },
            maxRunTimeoutMs,
          })
      ).toThrow(/maxRunTimeoutMs/);
    }
  });
});
