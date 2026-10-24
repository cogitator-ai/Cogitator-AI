import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  ChatStreamChunk,
  MemoryEntry,
  ToolInputAvailable,
  ToolInputDelta,
  ToolInputStart,
  ToolUpdate,
} from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { toolOutput } from '../tool-content';
import { isConcurrencySafe } from '../cogitator/tool-executor';
import { scheduleToolCalls } from '../cogitator/tool-scheduler';
import { KeyedLock } from '../cogitator/tool-locks';
import { fileLockKey, restrictFileTools } from '../tools/path-guard';
import { workspaceTools } from '../tools/workspace-tools';
import { ToolInputStream } from '../llm/tool-input';
import { streamChatRequest } from '../cogitator/streaming';
import { ABORTED_BEFORE_DISPATCH } from '../utils/tool-history';
import {
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

async function entriesOf(cog: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const entries = await cog.memory!.getEntries({ threadId, includeToolCalls: true, types: 'all' });
  if (!entries.success) throw new Error(entries.error);
  return entries.data;
}

/** Lets every promise and I/O callback that is ready run */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const agentWith = (tools: ReturnType<typeof tool>[]) =>
  new Agent({ name: 'worker', model: 'mock/m', instructions: 'Work.', tools });

/** A tool whose calls wait until the test lets them finish, with a log of starts and ends */
function gatedTool(name: string, log: string[], options: { safe?: boolean } = {}) {
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const gateOf = (id: string) => {
    let gate = gates.get(id);
    if (!gate) {
      gate = deferred();
      gates.set(id, gate);
    }
    return gate;
  };
  const gated = tool({
    name,
    description: name,
    parameters: z.object({ id: z.string() }),
    ...(options.safe !== undefined && { isConcurrencySafe: options.safe }),
    execute: async ({ id }) => {
      log.push(`start ${id}`);
      await gateOf(id).promise;
      log.push(`end ${id}`);
      return `${name} ${id}`;
    },
  });
  return { tool: gated, open: (id: string) => gateOf(id).resolve() };
}

const toolTexts = (messages: { role: string; content: unknown }[]) =>
  messages.filter((message) => message.role === 'tool').map((message) => message.content);

describe('scheduleToolCalls', () => {
  it('runs safe calls in a pool of at most maxParallel, outcomes in call order', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<string>());
    const started: number[] = [];
    const done = scheduleToolCalls({
      count: 4,
      safe: () => true,
      maxParallel: 2,
      run: (index) => {
        started.push(index);
        return gates[index].promise;
      },
    });
    await settle();
    expect(started).toEqual([0, 1]);
    gates[1].resolve('b');
    await settle();
    expect(started).toEqual([0, 1, 2]);
    gates[2].resolve('c');
    gates[0].resolve('a');
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[3].resolve('d');
    await expect(done).resolves.toEqual(['a', 'b', 'c', 'd']);
  });

  it('runs a call that is not safe alone, after the calls before it and before the ones after', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    const started: number[] = [];
    const done = scheduleToolCalls({
      count: 4,
      safe: (index) => index !== 2,
      maxParallel: 10,
      run: (index) => {
        started.push(index);
        return gates[index].promise;
      },
    });
    await settle();
    expect(started).toEqual([0, 1]);
    gates[1].resolve(1);
    await settle();
    expect(started).toEqual([0, 1]);
    gates[0].resolve(0);
    await settle();
    expect(started).toEqual([0, 1, 2]);
    gates[2].resolve(2);
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[3].resolve(3);
    await expect(done).resolves.toEqual([0, 1, 2, 3]);
  });

  it('starts no call after one that stops, and leaves the ones never started out', async () => {
    const run = vi.fn(async (index: number) => index);
    const outcomes = await scheduleToolCalls({
      count: 3,
      safe: () => false,
      maxParallel: 10,
      run,
      stops: (outcome) => outcome === 1,
    });
    expect(outcomes).toEqual([0, 1]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects with the first failure and starts no other call', async () => {
    const run = vi.fn(async (index: number) => {
      if (index === 0) throw new Error('broken');
      return index;
    });
    await expect(
      scheduleToolCalls({ count: 3, safe: () => true, maxParallel: 1, run })
    ).rejects.toThrow('broken');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('isConcurrencySafe', () => {
  const base = { name: 't', description: 't', parameters: z.object({ path: z.string() }) };

  it('defaults to the MCP readOnlyHint, and to not safe without one', () => {
    const readOnly = tool({ ...base, annotations: { readOnlyHint: true }, execute: async () => 1 });
    const plain = tool({ ...base, execute: async () => 1 });
    expect(isConcurrencySafe(readOnly, { path: 'a' })).toBe(true);
    expect(isConcurrencySafe(plain, { path: 'a' })).toBe(false);
  });

  it('asks a check with the arguments its schema reads, and a check that throws says no', () => {
    const byPath = tool({
      ...base,
      isConcurrencySafe: ({ path }) => path.startsWith('docs/'),
      execute: async () => 1,
    });
    const throwing = tool({
      ...base,
      isConcurrencySafe: () => {
        throw new Error('no idea');
      },
      execute: async () => 1,
    });
    expect(isConcurrencySafe(byPath, { path: 'docs/a.md' })).toBe(true);
    expect(isConcurrencySafe(byPath, { path: 'src/a.ts' })).toBe(false);
    expect(isConcurrencySafe(throwing, { path: 'a' })).toBe(false);
  });
});

describe('parallel tool calls in a run', () => {
  it('runs safe calls together and hands the results to the model in call order', async () => {
    const log: string[] = [];
    const slow = gatedTool('slow', log, { safe: true });
    const { cog, requests } = setup([
      callTools([
        { id: 'c1', name: 'slow', arguments: { id: 'a' } },
        { id: 'c2', name: 'slow', arguments: { id: 'b' } },
      ]),
      answer('Done.'),
    ]);
    const run = cog.run(agentWith([slow.tool]), { input: 'Go', parallelToolCalls: true });
    await settle();
    expect(log).toEqual(['start a', 'start b']);
    slow.open('b');
    await settle();
    slow.open('a');
    await run;

    expect(log).toEqual(['start a', 'start b', 'end b', 'end a']);
    expect(toolTexts(requests[1].messages)).toEqual(['"slow a"', '"slow b"']);
    await cog.close();
  });

  it('makes a call that is not safe a barrier between the safe ones', async () => {
    const log: string[] = [];
    const reader = gatedTool('reader', log, { safe: true });
    const writer = gatedTool('writer', log);
    const { cog } = setup([
      callTools([
        { id: 'c1', name: 'reader', arguments: { id: 'r1' } },
        { id: 'c2', name: 'writer', arguments: { id: 'w' } },
        { id: 'c3', name: 'reader', arguments: { id: 'r2' } },
      ]),
      answer('Done.'),
    ]);
    const run = cog.run(agentWith([reader.tool, writer.tool]), {
      input: 'Go',
      parallelToolCalls: true,
    });
    await settle();
    expect(log).toEqual(['start r1']);
    reader.open('r1');
    await settle();
    expect(log).toEqual(['start r1', 'end r1', 'start w']);
    writer.open('w');
    await settle();
    expect(log.at(-1)).toBe('start r2');
    reader.open('r2');
    await run;
    await cog.close();
  });

  it('runs every call after the one before it without parallelToolCalls, safe ones too', async () => {
    const log: string[] = [];
    const slow = gatedTool('slow', log, { safe: true });
    const { cog } = setup([
      callTools([
        { id: 'c1', name: 'slow', arguments: { id: 'a' } },
        { id: 'c2', name: 'slow', arguments: { id: 'b' } },
      ]),
      answer('Done.'),
    ]);
    const run = cog.run(agentWith([slow.tool]), { input: 'Go' });
    await settle();
    expect(log).toEqual(['start a']);
    slow.open('a');
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    slow.open('b');
    await run;
    await cog.close();
  });

  it('holds the pool to maxParallelToolCalls', async () => {
    const log: string[] = [];
    const slow = gatedTool('slow', log, { safe: true });
    const { cog } = setup([
      callTools(
        ['a', 'b', 'c'].map((id, at) => ({ id: `c${at}`, name: 'slow', arguments: { id } }))
      ),
      answer('Done.'),
    ]);
    const run = cog.run(agentWith([slow.tool]), {
      input: 'Go',
      parallelToolCalls: true,
      maxParallelToolCalls: 2,
    });
    await settle();
    expect(log).toEqual(['start a', 'start b']);
    slow.open('a');
    await settle();
    expect(log).toEqual(['start a', 'start b', 'end a', 'start c']);
    slow.open('b');
    slow.open('c');
    await run;
    await cog.close();
  });

  it('starts no call after one that asks a question, and runs it once resumed', async () => {
    const lookup = vi.fn(async () => 'looked up');
    const agent = agentWith([
      tool({
        name: 'ask',
        description: 'Asks',
        parameters: z.object({}),
        execute: async (_params, context) =>
          context.interrupt!({ reason: 'confirm', message: 'Sure?' }),
      }),
      tool({
        name: 'lookup',
        description: 'Looks up',
        parameters: z.object({}),
        isConcurrencySafe: true,
        execute: lookup,
      }),
    ]);
    const { cog } = setup([
      callTools([
        { id: 'q', name: 'ask', arguments: {} },
        { id: 'l', name: 'lookup', arguments: {} },
      ]),
      answer('Done.'),
    ]);
    const paused = await cog.run(agent, { input: 'Go', parallelToolCalls: true });
    expect(paused.status).toBe('paused');
    expect(lookup).not.toHaveBeenCalled();

    const done = await cog.resume(agent, paused.checkpoint!, {
      parallelToolCalls: true,
      responses: { 'q#0': 'yes' },
    });
    expect(done.status).toBe('completed');
    expect(lookup).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('answers the calls an abort kept from starting with aborted before dispatch', async () => {
    const log: string[] = [];
    const reader = gatedTool('reader', log, { safe: true });
    const writer = gatedTool('writer', log);
    const { cog } = setup([
      callTools([
        { id: 'c1', name: 'reader', arguments: { id: 'r1' } },
        { id: 'c2', name: 'reader', arguments: { id: 'r2' } },
        { id: 'c3', name: 'writer', arguments: { id: 'w' } },
      ]),
      answer('Done.'),
    ]);
    const controller = new AbortController();
    const run = cog.run(agentWith([reader.tool, writer.tool]), {
      input: 'Go',
      threadId: 'abort-pool',
      parallelToolCalls: true,
      signal: controller.signal,
    });
    await settle();
    reader.open('r1');
    await settle();
    controller.abort(new Error('stop'));
    await expect(run).rejects.toThrow('stop');

    const results = (await entriesOf(cog, 'abort-pool')).flatMap(
      (entry) => entry.toolResults ?? []
    );
    expect(results).toEqual([
      { callId: 'c1', name: 'reader', result: 'reader r1' },
      { callId: 'c3', name: 'writer', result: null, error: ABORTED_BEFORE_DISPATCH },
    ]);
    expect(log).not.toContain('start w');
    await cog.close();
  });
});

describe('locks by key', () => {
  it('lets calls that share a key go one after another, in the order they asked', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const first = await lock.acquire(['file:a']);
    const second = lock.acquire(['file:a', 'file:b']).then((release) => {
      order.push('second');
      return release;
    });
    const other = lock.acquire(['file:c']).then((release) => {
      order.push('other');
      return release;
    });
    await settle();
    expect(order).toEqual(['other']);
    first();
    (await second)();
    (await other)();
    expect(order).toEqual(['other', 'second']);
    await settle();
    expect(lock.size).toBe(0);
  });

  it('gives up the place in the queue when the signal aborts', async () => {
    const lock = new KeyedLock();
    const held = await lock.acquire(['k']);
    const controller = new AbortController();
    const waiting = lock.acquire(['k'], controller.signal);
    const after = lock.acquire(['k']);
    controller.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
    held();
    (await after)();
    await settle();
    expect(lock.size).toBe(0);
  });

  describe('fileLockKey', () => {
    let dir: string;
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('is the same for a file and a symlink to it, and for a file not written yet', async () => {
      dir = await mkdtemp(join(tmpdir(), 'lock-key-'));
      await writeFile(join(dir, 'real.txt'), 'x');
      await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'));
      expect(await fileLockKey(join(dir, 'link.txt'))).toBe(
        await fileLockKey(join(dir, 'real.txt'))
      );
      expect(await fileLockKey(join(dir, 'sub', '..', 'new.txt'))).toBe(
        await fileLockKey(join(dir, 'new.txt'))
      );
    });
  });

  it('keeps calls whose lock keys meet apart, even across separate invocations', async () => {
    const log: string[] = [];
    const gates = new Map([
      ['a1', deferred()],
      ['a2', deferred()],
      ['b', deferred()],
    ]);
    const locked = tool({
      name: 'locked',
      description: 'Writes a key',
      parameters: z.object({ key: z.string(), id: z.string() }),
      lockKeys: ({ key }) => [key],
      execute: async ({ id }) => {
        log.push(`start ${id}`);
        await gates.get(id)!.promise;
        log.push(`end ${id}`);
        return id;
      },
    });
    const cog = new Cogitator();
    const calls = [
      cog.invokeTool(locked, { key: 'a', id: 'a1' }),
      cog.invokeTool(locked, { key: 'a', id: 'a2' }),
      cog.invokeTool(locked, { key: 'b', id: 'b' }),
    ];
    await settle();
    expect(log).toEqual(['start a1', 'start b']);
    gates.get('a1')!.resolve();
    await settle();
    expect(log).toEqual(['start a1', 'start b', 'end a1', 'start a2']);
    gates.get('a2')!.resolve();
    gates.get('b')!.resolve();
    await Promise.all(calls);
    await cog.close();
  });

  it('gives a restricted file tool the lock keys of its original, for the path it resolves', async () => {
    const lockKeys = vi.fn(async ({ path }: { path: string }) => [path]);
    const original = tool({
      name: 'write_thing',
      description: 'Writes',
      parameters: z.object({ path: z.string() }),
      isConcurrencySafe: true,
      lockKeys,
      presentation: { label: 'Write thing' },
      execute: async ({ path }) => path,
    });
    const [restricted] = restrictFileTools([original], ['/srv'], { base: '/srv' });
    expect(restricted.isConcurrencySafe).toBe(true);
    expect(restricted.presentation).toEqual({ label: 'Write thing' });
    const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
    expect(await restricted.lockKeys!({ path: 'notes.md' }, context)).toEqual(['/srv/notes.md']);
  });
});

describe('tool results for people', () => {
  it('gives the model the content, and the application the details and the presentation', async () => {
    const edit = tool({
      name: 'edit',
      description: 'Edits',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) =>
        toolOutput({
          content: { path, replacements: 1 },
          details: { diff: '-a\n+b' },
          presentation: { label: 'Edit file', icon: 'file-pen', detail: path },
        }),
    });
    const { cog, requests } = setup([
      callTools([{ id: 'e1', name: 'edit', arguments: { path: 'a.ts' } }]),
      answer('Edited.'),
    ]);
    const results: unknown[] = [];
    await cog.run(agentWith([edit]), {
      input: 'Edit',
      threadId: 'output',
      onToolResult: (result) => results.push(result),
    });

    expect(toolTexts(requests[1].messages)).toEqual([
      JSON.stringify({ path: 'a.ts', replacements: 1 }),
    ]);
    expect(results).toEqual([
      {
        callId: 'e1',
        name: 'edit',
        result: { path: 'a.ts', replacements: 1 },
        details: { diff: '-a\n+b' },
        presentation: { label: 'Edit file', icon: 'file-pen', detail: 'a.ts' },
      },
    ]);
    const entry = (await entriesOf(cog, 'output')).find((item) => item.message.role === 'tool');
    expect(entry?.toolResults).toEqual([
      { callId: 'e1', name: 'edit', result: { path: 'a.ts', replacements: 1 } },
    ]);
    expect(entry?.metadata).toEqual({
      details: { diff: '-a\n+b' },
      presentation: { label: 'Edit file', icon: 'file-pen', detail: 'a.ts' },
    });
    await cog.close();
  });

  it("presents a call by the tool's presentation of its arguments, a failed one too", async () => {
    const fetchPage = tool({
      name: 'fetch_page',
      description: 'Fetches',
      parameters: z.object({ url: z.string() }),
      presentation: ({ url }) => ({ label: 'Fetch page', icon: 'globe', detail: url }),
      execute: async ({ url }) => {
        if (url.includes('bad')) throw new Error('404');
        return 'page';
      },
    });
    const { cog } = setup([
      callTools([
        { id: 'f1', name: 'fetch_page', arguments: { url: 'https://ok.dev' } },
        { id: 'f2', name: 'fetch_page', arguments: { url: 'https://bad.dev' } },
      ]),
      answer('Fetched.'),
    ]);
    const shown: unknown[] = [];
    await cog.run(agentWith([fetchPage]), {
      input: 'Fetch',
      onToolResult: (result) => shown.push([result.error ?? result.result, result.presentation]),
    });
    expect(shown).toEqual([
      ['page', { label: 'Fetch page', icon: 'globe', detail: 'https://ok.dev' }],
      ['404', { label: 'Fetch page', icon: 'globe', detail: 'https://bad.dev' }],
    ]);
    await cog.close();
  });

  it('reports what a running tool has so far, and nothing it reports after it returned', async () => {
    let late: (() => void) | undefined;
    const build = tool({
      name: 'build',
      description: 'Builds',
      parameters: z.object({}),
      execute: async (_params, context) => {
        context.update?.({ content: 'compiling', presentation: { label: 'Build', detail: '1/2' } });
        context.update?.({ content: 'linking', details: { step: 2 } });
        late = () => context.update?.({ content: 'too late' });
        return 'built';
      },
    });
    const { cog } = setup([callTools([{ id: 'b1', name: 'build', arguments: {} }]), answer('Ok.')]);
    const updates: ToolUpdate[] = [];
    await cog.run(agentWith([build]), {
      input: 'Build',
      onToolUpdate: (update) => updates.push(update),
    });
    late?.();
    expect(updates).toEqual([
      {
        callId: 'b1',
        name: 'build',
        content: 'compiling',
        presentation: { label: 'Build', detail: '1/2' },
      },
      { callId: 'b1', name: 'build', content: 'linking', details: { step: 2 } },
    ]);
    await cog.close();
  });

  it('reports updates and splits the result in invokeTool too', async () => {
    const count = tool({
      name: 'count',
      description: 'Counts',
      parameters: z.object({}),
      execute: async (_params, context) => {
        context.update?.({ content: 1 });
        return toolOutput({ content: 2, details: { counted: true } });
      },
    });
    const cog = new Cogitator();
    const updates: ToolUpdate[] = [];
    const result = await cog.invokeTool(
      count,
      {},
      { toolCallId: 'k', onUpdate: (update) => updates.push(update) }
    );
    expect(updates).toEqual([{ callId: 'k', name: 'count', content: 1 }]);
    expect(result).toMatchObject({ result: 2, details: { counted: true } });
    await cog.close();
  });

  it('presents the workspace tools by what they touch', () => {
    const tools = new Map(workspaceTools().map((item) => [item.name, item]));
    const present = (name: string, args: Record<string, unknown>) => {
      const presentation = tools.get(name)!.presentation;
      return typeof presentation === 'function' ? presentation(args) : presentation;
    };
    expect(present('edit_file', { path: 'src/a.ts' })).toEqual({
      label: 'Edit file',
      icon: 'file-pen',
      detail: 'src/a.ts',
    });
    expect(present('run_command', { command: 'pnpm test' })?.detail).toBe('pnpm test');
    expect(tools.get('read_file')!.isConcurrencySafe).toBe(true);
    expect(tools.get('write_file')!.isConcurrencySafe).toBeUndefined();
    expect(tools.get('write_file')!.lockKeys).toBeTypeOf('function');
  });
});

describe('tool input as the model writes it', () => {
  const sink = () => {
    const events: string[] = [];
    return {
      events,
      onToken: () => undefined,
      onToolInputStart: (event: ToolInputStart) =>
        events.push(`start ${event.toolCallId} ${event.toolName}`),
      onToolInputDelta: (event: ToolInputDelta) =>
        events.push(`delta ${event.toolCallId} ${event.delta}`),
      onToolInputAvailable: (event: ToolInputAvailable) =>
        events.push(`available ${event.toolCallId} ${JSON.stringify(event.input)}`),
    };
  };

  it('turns provider pieces into a start once id and name are known, then deltas', () => {
    const stream = new ToolInputStream();
    expect(stream.piece(0, { arguments: '{"a"' })).toEqual([]);
    expect(stream.piece(0, { id: 'c1', name: 'write', arguments: ':1' })).toEqual([
      { type: 'start', toolCallId: 'c1', toolName: 'write' },
      { type: 'delta', toolCallId: 'c1', delta: '{"a"' },
      { type: 'delta', toolCallId: 'c1', delta: ':1' },
    ]);
    expect(stream.piece(0, { id: 'c1', arguments: '}' })).toEqual([
      { type: 'delta', toolCallId: 'c1', delta: '}' },
    ]);
  });

  it('reports streamed pieces, then the complete call once the turn is settled', async () => {
    const chunks: ChatStreamChunk[] = [
      { id: 's', delta: { toolInput: [{ type: 'start', toolCallId: 'c1', toolName: 'write' }] } },
      { id: 's', delta: { toolInput: [{ type: 'delta', toolCallId: 'c1', delta: '{"path":' }] } },
      { id: 's', delta: { toolInput: [{ type: 'delta', toolCallId: 'c1', delta: '"a"}' }] } },
      {
        id: 's',
        delta: { toolCalls: [{ id: 'c1', name: 'write', arguments: { path: 'a' } }] },
        finishReason: 'tool_calls',
      },
    ];
    const { backend } = scriptedBackend([{ chunks }]);
    const listener = sink();
    await streamChatRequest(backend, { model: 'm', messages: [] }, listener);
    expect(listener.events).toEqual([
      'start c1 write',
      'delta c1 {"path":',
      'delta c1 "a"}',
      'available c1 {"path":"a"}',
    ]);
  });

  it('reports a call that arrives whole as a start and one delta, and an unreadable one without available', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        id: 's',
        delta: {
          toolCalls: [
            { id: 'c1', name: 'read', arguments: { path: 'a' } },
            { id: 'c2', name: 'read', arguments: {}, argumentsError: 'not valid JSON: {' },
          ],
        },
        finishReason: 'tool_calls',
      },
    ];
    const { backend } = scriptedBackend([{ chunks }]);
    const listener = sink();
    await streamChatRequest(backend, { model: 'm', messages: [] }, listener);
    expect(listener.events).toEqual([
      'start c1 read',
      'delta c1 {"path":"a"}',
      'start c2 read',
      'available c1 {"path":"a"}',
    ]);
  });

  it('reaches the run callbacks and the hooks of the tool in a streamed run, never otherwise', async () => {
    const hooks: string[] = [];
    const write = tool({
      name: 'write',
      description: 'Writes',
      parameters: z.object({ path: z.string() }),
      onInputStart: (event) => hooks.push(`start ${event.toolCallId}`),
      onInputDelta: (event) => hooks.push(`delta ${event.delta}`),
      onInputAvailable: (event) => hooks.push(`available ${JSON.stringify(event.input)}`),
      execute: async () => 'written',
    });
    const turn: ScriptedTurn = {
      chunks: [
        { id: 's', delta: { toolInput: [{ type: 'start', toolCallId: 'w1', toolName: 'write' }] } },
        {
          id: 's',
          delta: { toolInput: [{ type: 'delta', toolCallId: 'w1', delta: '{"path":"a"}' }] },
        },
        {
          id: 's',
          delta: { toolCalls: [{ id: 'w1', name: 'write', arguments: { path: 'a' } }] },
          finishReason: 'tool_calls',
        },
      ],
    };
    const { cog } = setup([turn, answer('Done.')]);
    const listener = sink();
    await cog.run(agentWith([write]), {
      input: 'Write',
      stream: true,
      onToolInputStart: listener.onToolInputStart,
      onToolInputDelta: listener.onToolInputDelta,
      onToolInputAvailable: listener.onToolInputAvailable,
    });
    expect(listener.events).toEqual([
      'start w1 write',
      'delta w1 {"path":"a"}',
      'available w1 {"path":"a"}',
    ]);
    expect(hooks).toEqual(['start w1', 'delta {"path":"a"}', 'available {"path":"a"}']);

    const quiet = setup([
      callTools([{ id: 'w2', name: 'write', arguments: { path: 'b' } }]),
      answer('Ok.'),
    ]);
    const unstreamed = sink();
    await quiet.cog.run(agentWith([write]), {
      input: 'Write',
      onToolInputStart: unstreamed.onToolInputStart,
    });
    expect(unstreamed.events).toEqual([]);
    await cog.close();
    await quiet.cog.close();
  });
});

describe('stage timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a streamed call that goes quiet for chunkMs with RUN_CHUNK_TIMEOUT', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cog } = setup([{ stream: ['Hel'], thenWait: true }]);
    const run = cog.run(agentWith([]), {
      input: 'Hi',
      stream: true,
      onToken: () => undefined,
      timeouts: { chunkMs: 1000 },
    });
    const failed = expect(run).rejects.toMatchObject({ code: ErrorCode.RUN_CHUNK_TIMEOUT });
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    await cog.close();
  });

  it('fails a model call that outlasts stepMs with RUN_STEP_TIMEOUT, also one that ignores its signal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cog } = setup([() => new Promise(() => undefined)]);
    const agent = new Agent({
      name: 'slow',
      model: 'mock/m',
      instructions: 'x',
      timeouts: { stepMs: 5000 },
    });
    const run = cog.run(agent, { input: 'Hi' });
    const failed = expect(run).rejects.toMatchObject({ code: ErrorCode.RUN_STEP_TIMEOUT });
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    await cog.close();
  });

  it('fails a tool call that outlasts toolMs with TOOL_TIMEOUT and lets the run go on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hang = tool({
      name: 'hang',
      description: 'Hangs',
      parameters: z.object({}),
      execute: () => new Promise<string>(() => undefined),
    });
    const { cog, requests } = setup([
      callTools([{ id: 'h1', name: 'hang', arguments: {} }]),
      answer('It hung.'),
    ]);
    const results: unknown[] = [];
    const run = cog.run(agentWith([hang]), {
      input: 'Go',
      timeouts: { toolMs: 2000 },
      onToolResult: (result) => results.push(result),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await run;
    expect(result.output).toBe('It hung.');
    expect(results).toEqual([
      {
        callId: 'h1',
        name: 'hang',
        result: null,
        error: 'Tool "hang" timed out after 2000ms',
        errorCode: ErrorCode.TOOL_TIMEOUT,
      },
    ]);
    expect(toolTexts(requests[1].messages)).toEqual([
      JSON.stringify({ error: 'Tool "hang" timed out after 2000ms' }),
    ]);
    await cog.close();
  });

  it('takes totalMs over timeout, and the run fields over the agent ones', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cog } = setup([() => new Promise(() => undefined)]);
    const agent = new Agent({
      name: 'slow',
      model: 'mock/m',
      instructions: 'x',
      timeout: 60_000,
      timeouts: { stepMs: 50_000 },
    });
    const run = cog.run(agent, { input: 'Hi', timeout: 90_000, timeouts: { totalMs: 3000 } });
    const failed = expect(run).rejects.toMatchObject({
      code: ErrorCode.RUN_TIMEOUT,
      details: { timeout: 3000 },
    });
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    await cog.close();
  });
});
