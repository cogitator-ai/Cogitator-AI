import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { InterruptRequest, Tool } from '@cogitator-ai/types';
import { MCPClient } from '../client/mcp-client';
import { InMemoryMCPClientTaskStore, MCPTaskEndedError } from '../client/tasks';
import { MCPServer } from '../server/mcp-server';
import { InMemoryMCPTaskStore } from '../server/tasks';
import type { MCPServerConfig, MCPToolContext } from '../types';
import { ELICITATION, TASKS, rawRequest } from './support/raw-mcp';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function serve(tools: Tool[], config: Partial<MCPServerConfig> = {}): Promise<string> {
  const server = new MCPServer({
    name: 'tasks',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    tasks: { promoteAfterMs: 50, pollIntervalMs: 250 },
    ...config,
  });
  server.registerTools(tools);
  await server.start();
  cleanups.push(() => server.stop());
  return `http://127.0.0.1:${server.getPort()}/mcp`;
}

async function client(url: string, extra: Partial<Parameters<typeof MCPClient.connect>[0]> = {}) {
  const connected = await MCPClient.connect({ transport: 'http', url, ...extra });
  cleanups.push(() => connected.close());
  return connected;
}

function slowTool(ms: number, result: unknown = 'slow done') {
  const execute = vi.fn(async (_params: unknown, context: { signal: AbortSignal }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      context.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
    return result;
  });
  const slow = tool({
    name: 'slow',
    description: 'Takes a while',
    parameters: z.object({}),
    execute,
  }) as Tool;
  return { slow, execute };
}

async function pollUntil(
  url: string,
  taskId: string,
  done: (status: string) => boolean,
  headers: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const reply = await rawRequest(url, 'tasks/get', {
      capabilities: TASKS,
      params: { taskId },
      headers,
    });
    if (reply.result && done(String(reply.result.status))) return reply.result;
    await sleep(50);
  }
  throw new Error('The task did not get there');
}

describe('MCPServer tasks', () => {
  it('makes a long call a task for clients that take tasks, and answers it in tasks/get', async () => {
    const { slow } = slowTool(300, { rows: 2 });
    const url = await serve([slow]);
    const created = await rawRequest(url, 'tools/call', {
      capabilities: TASKS,
      params: { name: 'slow', arguments: {} },
    });
    expect(created.result).toMatchObject({
      resultType: 'task',
      status: 'working',
      ttlMs: 3600000,
      pollIntervalMs: 250,
    });
    const taskId = String(created.result?.taskId);
    expect(taskId.length).toBeGreaterThanOrEqual(22);

    const task = await pollUntil(url, taskId, (status) => status === 'completed');
    expect(task).toMatchObject({
      resultType: 'complete',
      taskId,
      status: 'completed',
      result: { content: [{ type: 'text', text: JSON.stringify({ rows: 2 }, null, 2) }] },
    });
  });

  it('answers clients without the extension synchronously', async () => {
    const { slow } = slowTool(150);
    const url = await serve([slow]);
    const reply = await rawRequest(url, 'tools/call', { params: { name: 'slow', arguments: {} } });
    expect(reply.result).toMatchObject({ resultType: 'complete' });
  });

  it('completes a task whose tool failed, with the error in its result', async () => {
    const broken = tool({
      name: 'broken',
      description: 'Fails late',
      parameters: z.object({}),
      execute: async () => {
        await sleep(150);
        throw new Error('disk full');
      },
    }) as Tool;
    const url = await serve([broken]);
    const created = await rawRequest(url, 'tools/call', {
      capabilities: TASKS,
      params: { name: 'broken', arguments: {} },
    });
    const task = await pollUntil(url, String(created.result?.taskId), (s) => s !== 'working');
    expect(task).toMatchObject({ status: 'completed', result: { isError: true } });
  });

  it("keeps a task to its caller: another one's tasks/get is refused as unknown", async () => {
    const { slow } = slowTool(200);
    const url = await serve([slow], {
      auth: (req) => ({ userId: String(req.headers['x-user'] ?? 'anon') }),
    });
    const created = await rawRequest(url, 'tools/call', {
      capabilities: TASKS,
      params: { name: 'slow', arguments: {} },
      headers: { 'x-user': 'alice' },
    });
    const taskId = String(created.result?.taskId);
    const stranger = await rawRequest(url, 'tasks/get', {
      capabilities: TASKS,
      params: { taskId },
      headers: { 'x-user': 'mallory' },
    });
    expect(stranger.error?.code).toBe(-32602);
    const owner = await rawRequest(url, 'tasks/get', {
      capabilities: TASKS,
      params: { taskId },
      headers: { 'x-user': 'alice' },
    });
    expect(owner.result?.taskId).toBe(taskId);
  });

  it('stops the run on tasks/cancel', async () => {
    const { slow, execute } = slowTool(5000);
    const url = await serve([slow]);
    const created = await rawRequest(url, 'tools/call', {
      capabilities: TASKS,
      params: { name: 'slow', arguments: {} },
    });
    const taskId = String(created.result?.taskId);
    const cancelled = await rawRequest(url, 'tasks/cancel', {
      capabilities: TASKS,
      params: { taskId },
    });
    expect(cancelled.result).toMatchObject({ resultType: 'complete' });
    const task = await pollUntil(url, taskId, (status) => status === 'cancelled');
    expect(task.status).toBe('cancelled');
    const signal = execute.mock.calls[0]?.[1].signal;
    expect(signal?.aborted).toBe(true);
  });

  it('asks the questions of a task in input_required and goes on with tasks/update', async () => {
    const ask = tool({
      name: 'ask',
      description: 'Asks late',
      parameters: z.object({}),
      execute: async (_params, context) => {
        await sleep(150);
        const reply = await (context as MCPToolContext).elicit!({
          message: 'Color?',
          schema: { type: 'object', properties: { c: { type: 'string' } } },
        });
        return reply;
      },
    }) as Tool;
    const url = await serve([ask]);
    const created = await rawRequest(url, 'tools/call', {
      capabilities: { ...TASKS, ...ELICITATION },
      params: { name: 'ask', arguments: {} },
    });
    const taskId = String(created.result?.taskId);
    const waiting = await pollUntil(url, taskId, (status) => status === 'input_required');
    const keys = Object.keys(waiting.inputRequests as object);
    expect(keys).toHaveLength(1);
    expect(waiting.inputRequests).toMatchObject({
      [keys[0]!]: { method: 'elicitation/create', params: { message: 'Color?' } },
    });

    await rawRequest(url, 'tasks/update', {
      capabilities: TASKS,
      params: {
        taskId,
        inputResponses: { [keys[0]!]: { action: 'accept', content: { c: 'red' } } },
      },
    });
    const done = await pollUntil(url, taskId, (status) => status === 'completed');
    expect(JSON.stringify(done.result)).toContain('red');
  });

  it('counts a question of a task nobody answers in time as dismissed', async () => {
    let reply: unknown;
    const ask = tool({
      name: 'ask',
      description: 'Asks late',
      parameters: z.object({}),
      execute: async (_params, context) => {
        await sleep(150);
        reply = await (context as MCPToolContext).elicit!({
          message: 'Color?',
          schema: { type: 'object', properties: {} },
        });
        return 'went on';
      },
    }) as Tool;
    const url = await serve([ask], { elicitationTimeoutMs: 300 });
    const created = await rawRequest(url, 'tools/call', {
      capabilities: { ...TASKS, ...ELICITATION },
      params: { name: 'ask', arguments: {} },
    });
    const task = await pollUntil(url, String(created.result?.taskId), (s) => s === 'completed');
    expect(reply).toEqual({ action: 'cancel' });
    expect(JSON.stringify(task.result)).toContain('went on');
  });

  it('stops the run of a task and forgets it once its TTL ends', async () => {
    const { slow, execute } = slowTool(5000);
    const url = await serve([slow], { tasks: { promoteAfterMs: 0, ttlMs: 300 } });
    const created = await rawRequest(url, 'tools/call', {
      capabilities: TASKS,
      params: { name: 'slow', arguments: {} },
    });
    await sleep(500);
    expect(execute.mock.calls[0]?.[1].signal.aborted).toBe(true);
    const gone = await rawRequest(url, 'tasks/get', {
      capabilities: TASKS,
      params: { taskId: String(created.result?.taskId) },
    });
    expect(gone.error?.code).toBe(-32602);
  });

  it('forgets a task once its TTL ends', async () => {
    const store = new InMemoryMCPTaskStore();
    await store.create({
      taskId: 't',
      status: 'working',
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ttlMs: 1000,
      pollIntervalMs: 1000,
      owner: '',
    });
    expect(await store.get('t')).toBeUndefined();
  });
});

describe('MCPClient with tasks', () => {
  it('polls a task to its result', async () => {
    const { slow } = slowTool(400, 'done in a task');
    const url = await serve([slow]);
    const connected = await client(url);
    const updates: unknown[] = [];
    expect(
      await connected.callTool('slow', {}, { update: (progress) => updates.push(progress) })
    ).toBe('done in a task');
  });

  it('cancels the task when the call aborts', async () => {
    const { slow, execute } = slowTool(5000);
    const url = await serve([slow]);
    const connected = await client(url);
    const controller = new AbortController();
    const pending = connected.callTool('slow', {}, { signal: controller.signal });
    await sleep(300);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    await vi.waitFor(() => expect(execute.mock.calls[0]?.[1].signal.aborted).toBe(true));
  });

  it('reports a cancelled task as MCPTaskEndedError', async () => {
    const { slow } = slowTool(5000);
    const url = await serve([slow]);
    const connected = await client(url);
    const store = new InMemoryMCPClientTaskStore();
    const watcher = await client(url, { tasks: { store } });
    const pending = watcher.callTool('slow', {}, { toolCallId: 'call-1' });
    await vi.waitFor(async () => expect(await store.get('call-1')).toBeDefined());
    const record = await store.get('call-1');
    await rawRequest(url, 'tasks/cancel', {
      capabilities: TASKS,
      params: { taskId: record!.taskId },
    });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MCPTaskEndedError);
    expect((error as MCPTaskEndedError).status).toBe('cancelled');
    expect(connected.isConnected()).toBe(true);
  });

  it("comes back to the task a run's call started, after the run paused on its question", async () => {
    const runs = vi.fn();
    const ask = tool({
      name: 'ask',
      description: 'Asks late',
      parameters: z.object({}),
      execute: async (_params, context) => {
        runs();
        await sleep(150);
        const reply = await (context as MCPToolContext).elicit!({
          message: 'Color?',
          schema: { type: 'object', properties: { c: { type: 'string' } } },
        });
        return `chose ${JSON.stringify(reply)}`;
      },
    }) as Tool;
    const url = await serve([ask]);
    const connected = await client(url);

    class Paused extends Error {}
    const asked: InterruptRequest<unknown>[] = [];
    const pausing = async <T>(request: InterruptRequest<T>): Promise<T> => {
      asked.push(request as InterruptRequest<unknown>);
      throw new Paused('paused');
    };
    await expect(
      connected.callTool('ask', {}, { toolCallId: 'tc-1', interrupt: pausing })
    ).rejects.toBeInstanceOf(Paused);
    expect(asked[0]?.message).toBe('Color?');

    const answering = async <T>(): Promise<T> => ({ c: 'blue' }) as T;
    const value = await connected.callTool('ask', {}, { toolCallId: 'tc-1', interrupt: answering });
    expect(value).toContain('blue');
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it('does not take tasks when told not to', async () => {
    const { slow } = slowTool(300, 'inline');
    const url = await serve([slow]);
    const connected = await client(url, { tasks: false });
    expect(await connected.callTool('slow', {})).toBe('inline');
  });
});
