import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ZodType } from 'zod';
import type {
  ChatStreamChunk,
  Tool,
  ToolOutputContent,
  ToolOutputResult,
  RunMiddleware,
  ToolInputAbandoned,
  ToolInputAvailable,
} from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { toolOutput } from '../tool-content';
import { isConcurrencySafe } from '../cogitator/tool-executor';
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

describe('lock keys that wait on each other', () => {
  it('fail the call that closes the cycle with TOOL_LOCK_CYCLE instead of waiting forever', async () => {
    const cog = new Cogitator();
    const both = deferred();
    let holding = 0;
    const inner = (key: string) =>
      tool({
        name: `inner_${key}`,
        description: 'Writes a key',
        parameters: z.object({}),
        lockKeys: () => [key],
        execute: async () => `inner ${key}`,
      });
    const outer = (own: string, other: string) =>
      tool({
        name: `outer_${own}`,
        description: 'Holds a key and asks for the other',
        parameters: z.object({}),
        lockKeys: () => [own],
        execute: async () => {
          holding++;
          if (holding === 2) both.resolve();
          await both.promise;
          return cog.invokeTool(inner(other), {});
        },
      });
    const [first, second] = await Promise.all([
      cog.invokeTool(outer('A', 'B'), {}),
      cog.invokeTool(outer('B', 'A'), {}),
    ]);
    const inners = [first.result, second.result] as Array<{ errorCode?: string; result: unknown }>;
    expect(inners.filter((result) => result.errorCode === ErrorCode.TOOL_LOCK_CYCLE)).toHaveLength(
      1
    );
    expect(inners.map((result) => result.result).filter(Boolean)).toHaveLength(1);
    await cog.close();
  });
});

describe('arguments a schema transforms', () => {
  it('are read once, so the safety check, the lock keys and the tool see the same values', async () => {
    let reads = 0;
    const seen: Record<string, number> = {};
    const stamped = tool({
      name: 'stamped',
      description: 'Stamped',
      parameters: z.object({ id: z.string() }).transform((value) => ({ ...value, read: ++reads })),
      isConcurrencySafe: ({ read }) => {
        seen.safety = read;
        return true;
      },
      lockKeys: ({ read }) => {
        seen.keys = read;
        return [`stamp:${read}`];
      },
      execute: async ({ read }) => {
        seen.execute = read;
        return read;
      },
    });
    const { cog } = setup([
      callTools([
        { id: 'a', name: 'stamped', arguments: { id: 'a' } },
        { id: 'b', name: 'other', arguments: {} },
      ]),
      answer('Done.'),
    ]);
    const other = tool({
      name: 'other',
      description: 'Other',
      parameters: z.object({}),
      isConcurrencySafe: true,
      execute: async () => 'other',
    });
    await cog.run(agentWith([stamped, other]), { input: 'Go', parallelToolCalls: true });
    expect(seen.keys).toBe(seen.execute);
    expect(seen.safety).toBe(seen.execute);
    await cog.close();
  });
});

describe('a tool that reports after its run stopped', () => {
  it('reaches onToolUpdate no more', async () => {
    let report: (() => void) | undefined;
    const started = deferred();
    const deaf = tool({
      name: 'deaf',
      description: 'Ignores its signal',
      parameters: z.object({}),
      execute: async (_params, context) => {
        report = () => context.update?.({ content: 'still here' });
        started.resolve();
        return new Promise<never>(() => undefined);
      },
    });
    const { cog } = setup([callTools([{ id: 'd', name: 'deaf', arguments: {} }])]);
    const updates: unknown[] = [];
    const controller = new AbortController();
    const run = cog.run(agentWith([deaf]), {
      input: 'Go',
      signal: controller.signal,
      onToolUpdate: (update) => updates.push(update.content),
    });
    await started.promise;
    report?.();
    controller.abort(new Error('stop'));
    await expect(run).rejects.toThrow('stop');
    report?.();
    expect(updates).toEqual(['still here']);
    await cog.close();
  });
});

describe('a schema that turns the arguments into another value', () => {
  const files = tool({
    name: 'files',
    description: 'Reads or writes',
    parameters: z
      .object({ mode: z.enum(['read', 'write']) })
      .transform((args) => args.mode === 'read'),
    isConcurrencySafe: (readOnly) => {
      expectTypeOf(readOnly).toEqualTypeOf<boolean>();
      return readOnly;
    },
    presentation: (readOnly) => ({ label: readOnly ? 'Read' : 'Write' }),
    execute: async (readOnly) => (readOnly ? 'read' : 'written'),
  });

  it('hands the safety check and the presentation the value the schema made', async () => {
    expect(isConcurrencySafe(files, { mode: 'read' })).toBe(true);
    expect(isConcurrencySafe(files, { mode: 'write' })).toBe(false);
    const cog = new Cogitator();
    expect(await cog.invokeTool(files, { mode: 'write' })).toMatchObject({
      result: 'written',
      presentation: { label: 'Write' },
    });
    await cog.close();
  });
});

describe('an outputSchema and a toolOutput result', () => {
  it('type the schema by the content the model reads', () => {
    const edit = tool({
      name: 'edit',
      description: 'Edits',
      parameters: z.object({}),
      outputSchema: z.object({ replacements: z.number() }),
      execute: async () =>
        toolOutput({ content: { replacements: 1 }, details: { diff: '-a\n+b' } }),
    });
    expectTypeOf(edit.outputSchema).toEqualTypeOf<ZodType<{ replacements: number }> | undefined>();
    expectTypeOf<Awaited<ReturnType<typeof edit.execute>>>().toEqualTypeOf<
      ToolOutputResult<{ replacements: number }, { diff: string }>
    >();
    expectTypeOf<
      ToolOutputContent<ToolOutputResult<{ n: number }, { d: string }>>
    >().toEqualTypeOf<{ n: number }>();
    expectTypeOf<ToolOutputContent<string>>().toEqualTypeOf<string>();
    const own = tool({
      name: 'own',
      description: 'Returns an object with a content field of its own',
      parameters: z.object({}),
      execute: async () => ({ content: 'hello' }),
    });
    expectTypeOf(own).toEqualTypeOf<Tool<Record<string, never>, { content: string }>>();
    expect(edit.outputSchema?.safeParse({ replacements: 1 }).success).toBe(true);
  });
});

describe('a call aborted while it works out its lock keys', () => {
  it('never runs, also when it turns out to need no key', async () => {
    const keysAsked = deferred();
    const keysGiven = deferred();
    const execute = vi.fn(async () => 'ran');
    const late = tool({
      name: 'late',
      description: 'Works out its keys slowly',
      parameters: z.object({}),
      lockKeys: async () => {
        keysAsked.resolve();
        await keysGiven.promise;
        return [];
      },
      execute,
    });
    const cog = new Cogitator();
    const controller = new AbortController();
    const call = cog.invokeTool(late, {}, { signal: controller.signal });
    await keysAsked.promise;
    controller.abort(new Error('stopped'));
    keysGiven.resolve();
    expect(await call).toMatchObject({ error: 'stopped' });
    expect(execute).not.toHaveBeenCalled();
    await cog.close();
  });
});

describe('code a tool left running after it let its keys go', () => {
  it('waits for the keys like any other call', async () => {
    const cog = new Cogitator();
    const log: string[] = [];
    const later = deferred();
    const holderGate = deferred();
    let leftBehind: Promise<unknown> | undefined;
    const inner = tool({
      name: 'inner',
      description: 'Writes K',
      parameters: z.object({}),
      lockKeys: () => ['K'],
      execute: async () => {
        log.push('inner');
        return 'inner';
      },
    });
    const outer = tool({
      name: 'outer',
      description: 'Writes K and leaves work behind',
      parameters: z.object({}),
      lockKeys: () => ['K'],
      execute: async () => {
        leftBehind = later.promise.then(() => cog.invokeTool(inner, {}));
        return 'outer';
      },
    });
    const holder = tool({
      name: 'holder',
      description: 'Holds K',
      parameters: z.object({}),
      lockKeys: () => ['K'],
      execute: async () => {
        log.push('holder start');
        await holderGate.promise;
        log.push('holder end');
        return 'holder';
      },
    });
    await cog.invokeTool(outer, {});
    const holding = cog.invokeTool(holder, {});
    await settle();
    later.resolve();
    await settle();
    expect(log).toEqual(['holder start']);
    holderGate.resolve();
    await holding;
    await leftBehind;
    expect(log).toEqual(['holder start', 'holder end', 'inner']);
    await cog.close();
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

describe('a safe call that timed out and still runs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the call the step runs alone after it waiting until it really stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log: string[] = [];
    const stuck = deferred();
    const reader = tool({
      name: 'reader',
      description: 'Reads, ignoring its signal',
      parameters: z.object({}),
      isConcurrencySafe: true,
      execute: async () => {
        log.push('start reader');
        await stuck.promise;
        log.push('end reader');
        return 'read';
      },
    });
    const writer = tool({
      name: 'writer',
      description: 'Writes',
      parameters: z.object({}),
      execute: async () => {
        log.push('start writer');
        return 'written';
      },
    });
    const { cog } = setup([
      callTools([
        { id: 'r', name: 'reader', arguments: {} },
        { id: 'w', name: 'writer', arguments: {} },
      ]),
      answer('Done.'),
    ]);
    const run = cog.run(agentWith([reader, writer]), {
      input: 'Go',
      parallelToolCalls: true,
      timeouts: { toolMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start reader']);
    stuck.resolve();
    await run;
    expect(log).toEqual(['start reader', 'end reader', 'start writer']);
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
