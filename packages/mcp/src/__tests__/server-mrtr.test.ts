import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import { MCPServer } from '../server/mcp-server';
import type { MCPServerConfig, MCPToolContext } from '../types';
import { ELICITATION, TASKS, rawRequest } from './support/raw-mcp';

const servers: MCPServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function serve(tools: Tool[], config: Partial<MCPServerConfig> = {}): Promise<string> {
  const server = new MCPServer({
    name: 'mrtr',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    ...config,
  });
  server.registerTools(tools);
  await server.start();
  servers.push(server);
  return `http://127.0.0.1:${server.getPort()}/mcp`;
}

function deleteTool() {
  const execute = vi.fn(async ({ path }: { path: string }) => `deleted ${path}`);
  const deleteFile = tool({
    name: 'delete_file',
    description: 'Delete a file',
    parameters: z.object({ path: z.string() }),
    requiresApproval: true,
    execute,
  }) as Tool;
  return { deleteFile, execute };
}

function call(
  url: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return rawRequest(url, 'tools/call', {
    capabilities: ELICITATION,
    params: { name: 'delete_file', arguments: args, ...extra },
    headers,
  });
}

const approve = { approval: { action: 'accept', content: { approve: true } } };

describe('MCPServer approvals as multi round-trip requests', () => {
  it('ends the round asking for approval, and runs the call once the retry approves it', async () => {
    const { deleteFile, execute } = deleteTool();
    const url = await serve([deleteFile]);

    const first = await call(url, { path: '/a' });
    expect(first.result).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        approval: {
          method: 'elicitation/create',
          params: { mode: 'form', message: expect.stringContaining('delete_file') },
        },
      },
    });
    expect(typeof first.result?.requestState).toBe('string');
    expect(execute).not.toHaveBeenCalled();

    const second = await call(
      url,
      { path: '/a' },
      {
        inputResponses: approve,
        requestState: first.result?.requestState,
      }
    );
    expect(second.result).toMatchObject({
      resultType: 'complete',
      content: [{ type: 'text', text: 'deleted /a' }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not run a call whose answer declines it', async () => {
    const { deleteFile, execute } = deleteTool();
    const url = await serve([deleteFile]);
    const first = await call(url, { path: '/a' });
    const second = await call(
      url,
      { path: '/a' },
      {
        inputResponses: { approval: { action: 'decline' } },
        requestState: first.result?.requestState,
      }
    );
    expect(second.result?.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks again for a state that was tampered with, for other arguments or another caller', async () => {
    const { deleteFile, execute } = deleteTool();
    const url = await serve([deleteFile], {
      auth: (req) => ({ userId: String(req.headers['x-user'] ?? 'anon') }),
    });
    const first = await call(url, { path: '/a' }, {}, { 'x-user': 'alice' });
    const state = String(first.result?.requestState);

    const tampered = await call(
      url,
      { path: '/a' },
      {
        inputResponses: approve,
        requestState: `${state.slice(0, -2)}xx`,
      },
      { 'x-user': 'alice' }
    );
    const otherArgs = await call(
      url,
      { path: '/etc' },
      {
        inputResponses: approve,
        requestState: state,
      },
      { 'x-user': 'alice' }
    );
    const otherCaller = await call(
      url,
      { path: '/a' },
      {
        inputResponses: approve,
        requestState: state,
      },
      { 'x-user': 'mallory' }
    );

    for (const reply of [tampered, otherArgs, otherCaller]) {
      expect(reply.result?.resultType).toBe('input_required');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks again once the state expired', async () => {
    const { deleteFile, execute } = deleteTool();
    const url = await serve([deleteFile], { elicitationTimeoutMs: 1000 });
    const first = await call(url, { path: '/a' });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const late = await call(
      url,
      { path: '/a' },
      {
        inputResponses: approve,
        requestState: first.result?.requestState,
      }
    );
    expect(late.result?.resultType).toBe('input_required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('takes a state signed with the same key by another server process', async () => {
    const key = 'k'.repeat(40);
    const first = deleteTool();
    const second = deleteTool();
    const urlA = await serve([first.deleteFile], { requestStateKey: key });
    const urlB = await serve([second.deleteFile], { requestStateKey: key });

    const asked = await call(urlA, { path: '/a' });
    const done = await call(
      urlB,
      { path: '/a' },
      {
        inputResponses: approve,
        requestState: asked.result?.requestState,
      }
    );
    expect(done.result?.content).toEqual([{ type: 'text', text: 'deleted /a' }]);
    expect(second.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a key shorter than 32 bytes', () => {
    expect(
      () => new MCPServer({ name: 's', version: '1', transport: 'stdio', requestStateKey: 'short' })
    ).toThrow(/at least 32 bytes/);
  });

  it('answers a client without elicitation that nobody could approve', async () => {
    const { deleteFile, execute } = deleteTool();
    const url = await serve([deleteFile]);
    const reply = await rawRequest(url, 'tools/call', {
      params: { name: 'delete_file', arguments: { path: '/a' } },
    });
    expect(reply.result?.isError).toBe(true);
    expect(JSON.stringify(reply.result?.content)).toContain('nobody could approve');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('context.elicit across rounds', () => {
  it('keeps the call waiting between rounds, so it runs once', async () => {
    const runs = vi.fn();
    const survey = tool({
      name: 'survey',
      description: 'Ask two questions',
      parameters: z.object({}),
      execute: async (_params, context) => {
        runs();
        const elicit = (context as MCPToolContext).elicit!;
        const first = await elicit({
          message: 'Name?',
          schema: { type: 'object', properties: { name: { type: 'string' } } },
        });
        const second = await elicit({
          message: 'Age?',
          schema: { type: 'object', properties: { age: { type: 'number' } } },
        });
        return { first, second };
      },
    }) as Tool;
    const url = await serve([survey]);
    const send = (extra: Record<string, unknown> = {}) =>
      rawRequest(url, 'tools/call', {
        capabilities: ELICITATION,
        params: { name: 'survey', arguments: {}, ...extra },
      });

    const one = await send();
    expect(one.result?.inputRequests).toEqual({
      'elicit:1': expect.objectContaining({
        params: expect.objectContaining({ message: 'Name?' }),
      }),
    });
    const repeat = await send({ requestState: one.result?.requestState });
    expect(Object.keys(repeat.result?.inputRequests as object)).toEqual(['elicit:1']);

    const two = await send({
      requestState: one.result?.requestState,
      inputResponses: { 'elicit:1': { action: 'accept', content: { name: 'Ann' } } },
    });
    expect(Object.keys(two.result?.inputRequests as object)).toEqual(['elicit:2']);
    const three = await send({
      requestState: two.result?.requestState,
      inputResponses: { 'elicit:2': { action: 'accept', content: { age: 7 } } },
    });
    expect(JSON.parse(String((three.result?.content as { text: string }[])[0]?.text))).toEqual({
      first: { action: 'accept', content: { name: 'Ann' } },
      second: { action: 'accept', content: { age: 7 } },
    });
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it('counts a question nobody answers within elicitationTimeoutMs as dismissed', async () => {
    let seen: unknown;
    const ask = tool({
      name: 'ask',
      description: 'Ask',
      parameters: z.object({}),
      execute: async (_params, context) => {
        seen = await (context as MCPToolContext).elicit!({
          message: 'Name?',
          schema: { type: 'object', properties: {} },
        });
        return 'done';
      },
    }) as Tool;
    const url = await serve([ask], { elicitationTimeoutMs: 50 });
    await rawRequest(url, 'tools/call', {
      capabilities: ELICITATION,
      params: { name: 'ask', arguments: {} },
    });
    await vi.waitFor(() => expect(seen).toEqual({ action: 'cancel' }));
  });
});

describe('context.input', () => {
  it('ends the round with questions and comes back with the answers and the kept state', async () => {
    const rounds: unknown[] = [];
    const pick = tool({
      name: 'pick',
      description: 'Pick a color',
      parameters: z.object({}),
      execute: async (_params, context) => {
        const input = (context as MCPToolContext).input!;
        rounds.push({ state: input.state, responses: input.responses });
        if (input.state === undefined) {
          return input.ask(
            {
              color: {
                message: 'Color?',
                schema: { type: 'object', properties: { c: { type: 'string' } } },
              },
            },
            { step: 1 }
          );
        }
        return `picked ${String((input.responses.color as { content?: { c?: string } }).content?.c)}`;
      },
    }) as Tool;
    const url = await serve([pick]);
    const first = await rawRequest(url, 'tools/call', {
      capabilities: ELICITATION,
      params: { name: 'pick', arguments: {} },
    });
    expect(Object.keys(first.result?.inputRequests as object)).toEqual(['color']);
    const second = await rawRequest(url, 'tools/call', {
      capabilities: ELICITATION,
      params: {
        name: 'pick',
        arguments: {},
        requestState: first.result?.requestState,
        inputResponses: { color: { action: 'accept', content: { c: 'red' } } },
      },
    });
    expect(second.result?.content).toEqual([{ type: 'text', text: 'picked red' }]);
    expect(rounds).toEqual([
      { state: undefined, responses: {} },
      { state: { step: 1 }, responses: { color: { action: 'accept', content: { c: 'red' } } } },
    ]);
  });
});

describe('tasks/* without the tasks extension', () => {
  it('answers -32021 naming the extension', async () => {
    const url = await serve([deleteTool().deleteFile]);
    const reply = await rawRequest(url, 'tasks/get', { params: { taskId: 'x' } });
    expect(reply.error?.code).toBe(-32021);
    expect(reply.error?.data).toEqual({
      requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    });
    const unknown = await rawRequest(url, 'tasks/get', {
      capabilities: TASKS,
      params: { taskId: 'x' },
    });
    expect(unknown.error?.code).toBe(-32602);
  });
});
