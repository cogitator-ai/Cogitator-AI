import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  ChatStreamChunk,
  RunMiddleware,
  ToolInputAbandoned,
  ToolInputAvailable,
} from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { StepGate } from '../cogitator/tool-locks';
import { streamChatRequest } from '../cogitator/streaming';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';
import {
  abortReason,
  answer,
  callTools,
  deferred,
  scriptedBackend,
  type ScriptedTurn,
} from './helpers/scripted-backend';

function setup(turns: ScriptedTurn[]) {
  const scripted = scriptedBackend(turns);
  const cog = new Cogitator({
    llm: { backends: { mock: scripted.backend } },
    memory: { adapter: 'memory' },
  });
  return { cog, ...scripted };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const agentWith = (tools: ReturnType<typeof tool>[], extra: Partial<Agent['config']> = {}) =>
  new Agent({ name: 'worker', model: 'mock/m', instructions: 'Work.', tools, ...extra });

const start = (toolCallId: string, toolName: string): ChatStreamChunk => ({
  id: 's',
  delta: { toolInput: [{ type: 'start', toolCallId, toolName }] },
});
const piece = (toolCallId: string, delta: string): ChatStreamChunk => ({
  id: 's',
  delta: { toolInput: [{ type: 'delta', toolCallId, delta }] },
});
const end = (toolCallId: string): ChatStreamChunk => ({
  id: 's',
  delta: { toolInput: [{ type: 'end', toolCallId }] },
});

describe('locks held by a call', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stay held until a tool that timed out really stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log: string[] = [];
    const gate = deferred();
    const write = tool({
      name: 'write',
      description: 'Writes',
      parameters: z.object({ id: z.string() }),
      timeout: 1000,
      lockKeys: () => ['file:/shared'],
      execute: async ({ id }) => {
        log.push(`start ${id}`);
        if (id === 'slow') await gate.promise;
        log.push(`end ${id}`);
        return id;
      },
    });
    const cog = new Cogitator();
    const slow = cog.invokeTool(write, { id: 'slow' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await slow).toMatchObject({ errorCode: ErrorCode.TOOL_TIMEOUT });

    const next = cog.invokeTool(write, { id: 'next' });
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start slow']);
    gate.resolve();
    expect(await next).toMatchObject({ result: 'next' });
    expect(log).toEqual(['start slow', 'end slow', 'start next', 'end next']);
    await cog.close();
  });

  it('are taken again without waiting by a call run inside the call that holds them', async () => {
    const cog = new Cogitator();
    const inner = tool({
      name: 'inner',
      description: 'Writes the file too',
      parameters: z.object({}),
      lockKeys: () => ['file:/y'],
      execute: async () => 'inner done',
    });
    const outer = tool({
      name: 'outer',
      description: 'Writes the file and asks inner',
      parameters: z.object({}),
      lockKeys: () => ['file:/y'],
      execute: async () => (await cog.invokeTool(inner, {})).result,
    });
    expect(await cog.invokeTool(outer, {})).toMatchObject({ result: 'inner done' });
    await cog.close();
  });

  describe('of workspace files', () => {
    let root: string;
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('name a file the same by a path relative to the root or absolute inside it', async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'ws-lock-')));
      const workspace = new LocalWorkspace({ root });
      const edit = workspaceTools(workspace).find((item) => item.name === 'edit_file')!;
      const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
      const relative = await edit.lockKeys!({ path: 'a.txt' }, context);
      const absolute = await edit.lockKeys!({ path: join(root, 'a.txt') }, context);
      expect(absolute).toEqual(relative);
      expect(relative).toEqual([`file:${join(root, 'a.txt')}`]);
    });
  });
});

describe('StepGate', () => {
  it('lets shares run together and a call that must be alone wait for them, and the ones after it wait', async () => {
    const gate = new StepGate();
    const order: string[] = [];
    const first = await gate.share();
    const alone = gate.exclusive().then((leave) => {
      order.push('alone');
      return leave;
    });
    const after = gate.share().then((leave) => {
      order.push('after');
      return leave;
    });
    await settle();
    expect(order).toEqual([]);
    first();
    (await alone)();
    (await after)();
    expect(order).toEqual(['alone', 'after']);
  });
});

describe('a middleware that changes the arguments of a safe call', () => {
  it('makes the call run alone when its new arguments are not safe', async () => {
    const log: string[] = [];
    const gates = new Map(['a', 'b', 'c'].map((id) => [id, deferred()]));
    const files = tool({
      name: 'files',
      description: 'Reads or writes',
      parameters: z.object({ id: z.string(), mode: z.enum(['read', 'write']) }),
      isConcurrencySafe: ({ mode }) => mode === 'read',
      execute: async ({ id, mode }) => {
        log.push(`start ${id} ${mode}`);
        await gates.get(id)!.promise;
        log.push(`end ${id}`);
        return id;
      },
    });
    const toWrite: RunMiddleware = {
      name: 'to-write',
      wrapToolCall: (call, next) =>
        call.toolCall.id === 'c2'
          ? next({
              ...call,
              toolCall: { ...call.toolCall, arguments: { id: 'b', mode: 'write' } },
            })
          : next(call),
    };
    const { cog } = setup([
      callTools([
        { id: 'c1', name: 'files', arguments: { id: 'a', mode: 'read' } },
        { id: 'c2', name: 'files', arguments: { id: 'b', mode: 'read' } },
        { id: 'c3', name: 'files', arguments: { id: 'c', mode: 'read' } },
      ]),
      answer('Done.'),
    ]);
    const run = cog.run(agentWith([files], { middleware: [toWrite] }), {
      input: 'Go',
      parallelToolCalls: true,
    });
    await settle();
    expect(log).toEqual(['start a read']);
    gates.get('a')!.resolve();
    await settle();
    expect(log).toEqual(['start a read', 'end a', 'start b write']);
    gates.get('b')!.resolve();
    await settle();
    expect(log.at(-1)).toBe('start c read');
    gates.get('c')!.resolve();
    await run;
    await cog.close();
  });
});

describe('a resumed run', () => {
  it('runs its tools the way the paused run did unless told otherwise', async () => {
    const log: string[] = [];
    const gates = new Map(['a', 'b'].map((id) => [id, deferred()]));
    const ask = tool({
      name: 'ask',
      description: 'Asks',
      parameters: z.object({}),
      execute: async (_params, context) =>
        context.interrupt!({ reason: 'confirm', message: 'Sure?' }),
    });
    const slow = tool({
      name: 'slow',
      description: 'Slow',
      parameters: z.object({ id: z.string() }),
      isConcurrencySafe: true,
      execute: async ({ id }) => {
        log.push(`start ${id}`);
        await gates.get(id)!.promise;
        return id;
      },
    });
    const agent = agentWith([ask, slow]);
    const { cog } = setup([
      callTools([
        { id: 'q', name: 'ask', arguments: {} },
        { id: 's1', name: 'slow', arguments: { id: 'a' } },
        { id: 's2', name: 'slow', arguments: { id: 'b' } },
      ]),
      answer('Done.'),
    ]);
    const paused = await cog.run(agent, {
      input: 'Go',
      parallelToolCalls: true,
      maxParallelToolCalls: 4,
      timeouts: { toolMs: 60_000 },
    });
    expect(paused.checkpoint?.toolExecution).toEqual({
      parallelToolCalls: true,
      maxParallelToolCalls: 4,
      timeouts: { toolMs: 60_000 },
    });

    const resumed = cog.resume(agent, paused.checkpoint!, { responses: { 'q#0': 'yes' } });
    await settle();
    expect(log).toEqual(['start a', 'start b']);
    gates.get('a')!.resolve();
    gates.get('b')!.resolve();
    expect((await resumed).status).toBe('completed');
    await cog.close();
  });
});

describe('tool calls the model began and that never run', () => {
  const listen = () => {
    const abandoned: ToolInputAbandoned[] = [];
    const available: ToolInputAvailable[] = [];
    return {
      abandoned,
      available,
      options: {
        stream: true,
        onToolInputAvailable: (event: ToolInputAvailable) => available.push(event),
        onToolInputAbandoned: (event: ToolInputAbandoned) => abandoned.push(event),
      },
    };
  };
  const write = tool({
    name: 'write',
    description: 'Writes',
    parameters: z.object({ path: z.string() }),
    execute: async () => 'written',
  });

  it('are abandoned as incomplete when the turn is cut at the token limit', async () => {
    const hooks: ToolInputAbandoned[] = [];
    const hooked = tool({
      name: 'write',
      description: 'Writes',
      parameters: z.object({ path: z.string() }),
      onInputAbandoned: (event) => hooks.push(event),
      execute: async () => 'written',
    });
    const { cog } = setup([
      {
        chunks: [
          start('a', 'write'),
          piece('a', '{"path":"a"}'),
          end('a'),
          start('b', 'write'),
          piece('b', '{"pa'),
          { id: 's', delta: {}, finishReason: 'length' },
        ],
      },
    ]);
    const listener = listen();
    await cog.run(agentWith([hooked]), { input: 'Write', ...listener.options });
    expect(listener.available.map((event) => event.toolCallId)).toEqual(['a']);
    expect(listener.abandoned).toEqual([
      { toolCallId: 'a', toolName: 'write', reason: 'discarded' },
      { toolCallId: 'b', toolName: 'write', reason: 'incomplete' },
    ]);
    expect(hooks.map((event) => event.toolCallId)).toEqual(['a', 'b']);
    await cog.close();
  });

  it('are abandoned as discarded when an afterModel middleware drops or renames them', async () => {
    const drop: RunMiddleware = {
      name: 'drop',
      afterModel: ({ response }) => ({
        toolCalls: (response.toolCalls ?? [])
          .filter((call) => call.id !== 'gone')
          .map((call) => (call.id === 'renamed' ? { ...call, name: 'other' } : call)),
      }),
    };
    const other = tool({
      name: 'other',
      description: 'Other',
      parameters: z.object({}).passthrough(),
      execute: async () => 'other',
    });
    const { cog } = setup([
      {
        chunks: [
          {
            id: 's',
            delta: {
              toolCalls: [
                { id: 'kept', name: 'write', arguments: { path: 'k' } },
                { id: 'gone', name: 'write', arguments: { path: 'g' } },
                { id: 'renamed', name: 'write', arguments: { path: 'r' } },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      },
      answer('Done.'),
    ]);
    const listener = listen();
    await cog.run(agentWith([write, other], { middleware: [drop] }), {
      input: 'Write',
      ...listener.options,
    });
    expect(listener.abandoned).toEqual([
      { toolCallId: 'gone', toolName: 'write', reason: 'discarded' },
      { toolCallId: 'renamed', toolName: 'write', reason: 'discarded' },
    ]);
    await cog.close();
  });

  it('are abandoned when the run is aborted while the model writes them', async () => {
    const written = deferred();
    const { backend } = scriptedBackend([]);
    const cog = new Cogitator({
      llm: {
        backends: {
          mock: {
            ...backend,
            async *chatStream(request) {
              yield start('a', 'write');
              yield piece('a', '{"pa');
              written.resolve();
              await new Promise((_, reject) =>
                request.signal?.addEventListener('abort', () => reject(abortReason(request.signal)))
              );
            },
          },
        },
      },
    });
    const controller = new AbortController();
    const listener = listen();
    const run = cog.run(agentWith([write]), {
      input: 'Write',
      signal: controller.signal,
      ...listener.options,
    });
    await written.promise;
    controller.abort(new Error('stop'));
    await expect(run).rejects.toThrow('stop');
    expect(listener.abandoned).toEqual([
      { toolCallId: 'a', toolName: 'write', reason: 'incomplete' },
    ]);
    await cog.close();
  });
});

describe('tool input callbacks', () => {
  it('that throw are logged and the turn goes on', async () => {
    const write = tool({
      name: 'write',
      description: 'Writes',
      parameters: z.object({ path: z.string() }),
      onInputDelta: () => {
        throw new Error('hook broke');
      },
      execute: async () => 'written',
    });
    const { cog } = setup([
      {
        chunks: [start('a', 'write'), piece('a', '{"path":"a"}'), end('a'), finished('a', 'write')],
      },
      answer('Done.'),
    ]);
    const result = await cog.run(agentWith([write]), {
      input: 'Write',
      stream: true,
      onToolInputStart: () => {
        throw new Error('callback broke');
      },
    });
    expect(result.output).toBe('Done.');
    expect(result.toolCalls.map((call) => call.id)).toEqual(['a']);
    await cog.close();
  });

  it('reach the tools of the agent a run handed over to', async () => {
    const seen: string[] = [];
    const specialist = new Agent({
      name: 'specialist',
      model: 'mock/m',
      instructions: 'Write.',
      tools: [
        tool({
          name: 'write',
          description: 'Writes',
          parameters: z.object({ path: z.string() }),
          onInputStart: (event) => seen.push(event.toolCallId),
          execute: async () => 'written',
        }),
      ],
    });
    const triage = new Agent({
      name: 'triage',
      model: 'mock/m',
      instructions: 'Route.',
      handoffs: [specialist],
    });
    const { cog } = setup([
      callTools([{ id: 'h', name: 'transfer_to_specialist', arguments: {} }]),
      {
        chunks: [start('w', 'write'), piece('w', '{"path":"a"}'), end('w'), finished('w', 'write')],
      },
      answer('Done.'),
    ]);
    await cog.run(triage, { input: 'Write a file', stream: true });
    expect(seen).toEqual(['w']);
    await cog.close();
  });

  it('switch streaming on without keeping a wrong structured answer from being repaired', async () => {
    const watcher = tool({
      name: 'watch',
      description: 'Watches',
      parameters: z.object({}),
      onInputStart: () => undefined,
      execute: async () => 'ok',
    });
    const { cog, requests } = setup([answer('not json'), answer('{"ok":true}')]);
    const agent = agentWith([watcher], {
      responseFormat: { type: 'json_schema', schema: z.object({ ok: z.boolean() }) },
    });
    const result = await cog.run(agent, { input: 'Answer', stream: true });
    expect(requests).toHaveLength(2);
    expect(result.output).toBe('{"ok":true}');
    await cog.close();
  });
});

describe('streamed tool input', () => {
  it('gives a call without argument text its arguments as one delta before it is available', async () => {
    const events: string[] = [];
    const { backend } = scriptedBackend([
      { chunks: [start('a', 'ping'), end('a'), finished('a', 'ping', {})] },
    ]);
    await streamChatRequest(
      backend,
      { model: 'm', messages: [] },
      {
        onToken: () => undefined,
        onToolInputDelta: (event) => events.push(`delta ${event.delta}`),
        onToolInputAvailable: (event) => events.push(`available ${JSON.stringify(event.input)}`),
      }
    );
    expect(events).toEqual(['delta {}', 'available {}']);
  });
});

function finished(
  id: string,
  name: string,
  args: Record<string, unknown> = { path: 'a' }
): ChatStreamChunk {
  return {
    id: 's',
    delta: { toolCalls: [{ id, name, arguments: args }] },
    finishReason: 'tool_calls',
  };
}
