import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  WorkspaceError,
  FILE_CHECKPOINT_KEY,
  fileCheckpointOf,
  type ChatRequest,
  type ChatResponse,
  type CogitatorConfig,
  type MemoryEntry,
  type ToolCall,
} from '@cogitator-ai/types';
import { Agent } from '../agent';
import { Cogitator } from '../cogitator';
import { tool } from '../tool';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';
import { WorkspaceRuns } from '../cogitator/workspace-runs';
import { answer, callTools, deferred, scriptedBackend } from './helpers/scripted-backend';

let base: string;
let root: string;
let workspace: LocalWorkspace;
const cogs: Cogitator[] = [];

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-guards-')));
  root = join(base, 'project');
  workspace = new LocalWorkspace({ root, id: 'project-ws', snapshots: { gcGraceMs: 0 } });
  await workspace.start();
});

afterEach(async () => {
  for (const cog of cogs.splice(0)) await cog.close();
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

function text(path: string, at = root): string {
  return readFileSync(join(at, path), 'utf8');
}

/** A model that answers each user message by the plan for its text, one tool call per turn */
function plannedBackend(plan: Record<string, ToolCall[]>) {
  let seq = 0;
  return scriptedBackend([
    (request: ChatRequest): ChatResponse => {
      const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
      const said = typeof lastUser?.content === 'string' ? lastUser.content : '';
      const asked = Object.entries(plan).find(([key]) => said.includes(key))?.[1] ?? [];
      const at = request.messages.lastIndexOf(lastUser!);
      const done = request.messages.slice(at).filter((message) => message.role === 'tool').length;
      const next = asked[done];
      if (next) return callTools([{ ...next, id: `${next.id}_${seq++}` }]);
      return answer(`done: ${said.slice(0, 20)}`);
    },
  ]);
}

function write(path: string, content: string): ToolCall {
  return { id: 'w', name: 'write_file', arguments: { path, content } };
}

function runtime(
  plan: Record<string, ToolCall[]>,
  config: Partial<CogitatorConfig> = {},
  memory: CogitatorConfig['memory'] = { adapter: 'memory' }
) {
  const { backend, requests } = plannedBackend(plan);
  const cog = new Cogitator({
    llm: { backends: { mock: backend } },
    memory,
    checkpoints: true,
    ...config,
  });
  cogs.push(cog);
  return { cog, requests };
}

/** Resolves once `probe` gives true, polling, so a test waits for a condition rather than a delay */
async function until(probe: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('The condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A tool that waits for `gate`, or ends when its call is aborted, telling `started` it began */
const waiting = (gate: Promise<void>, started?: { resolve(): void }) =>
  tool({
    name: 'wait',
    description: 'Waits',
    parameters: z.object({}),
    execute: async (_args, context) => {
      started?.resolve();
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      return 'waited';
    },
  });

function coder(extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  return new Agent({
    id: 'coder',
    name: 'coder',
    model: 'mock/m',
    instructions: 'You edit files.',
    tools: workspaceTools(undefined, { requireApproval: () => false }),
    workspace,
    ...extra,
  });
}

async function path(cog: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const memory = await cog.getMemory();
  const read = await memory!.getPath!({ threadId, types: 'all' });
  if (!read.success) throw new Error(read.error);
  return read.data;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof CogitatorError ? error.code : undefined;
}

describe('rewind and fork guards, round two', () => {
  it('waits with force for a tool that ignores its abort before it restores, and refuses past the wait', async () => {
    const wrote = deferred();
    const slowStarted = deferred();
    const stuckStarted = deferred();
    const stubborn = tool({
      name: 'stubborn',
      description: 'Ignores its abort signal, then writes',
      parameters: z.object({}),
      execute: async () => {
        slowStarted.resolve();
        await new Promise((resolve) => setTimeout(resolve, 300));
        writeFileSync(join(root, 'a.txt'), 'late write');
        wrote.resolve();
        return 'written';
      },
    });
    const forever = tool({
      name: 'forever',
      description: 'Never ends',
      parameters: z.object({}),
      execute: () => {
        stuckStarted.resolve();
        return new Promise<string>(() => undefined);
      },
    });
    const { cog } = runtime({
      one: [write('a.txt', '1')],
      slow: [{ id: 's', name: 'stubborn', arguments: {} }],
      stuck: [{ id: 'f', name: 'forever', arguments: {} }],
    });
    const agent = coder({
      tools: [...workspaceTools(undefined, { requireApproval: () => false }), stubborn, forever],
    });
    await cog.run(agent, { input: 'one', threadId: 't' });
    await cog.run(agent, { input: 'one again', threadId: 't' });
    const entries = await path(cog, 't');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'one again') - 1]!;

    const slow = cog.run(agent, { input: 'slow', threadId: 't' });
    slow.catch(() => undefined);
    await slowStarted.promise;
    const report = await cog.rewind('t', point.id, { files: true, agents: [agent], force: true });
    await wrote.promise;
    expect(report.files?.restored).toContain('a.txt');
    expect(text('a.txt')).toBe('1');

    const stopper = new AbortController();
    const stuck = cog.run(agent, { input: 'stuck', threadId: 't', signal: stopper.signal });
    stuck.catch(() => undefined);
    await stuckStarted.promise;
    stopper.abort();
    await stuck.catch(() => undefined);
    const later = (await path(cog, 't')).at(-1)!;
    const plain = await cog
      .rewind('t', later.id, { files: true, memory: false, agents: [agent] })
      .catch((error: unknown) => error);
    expect(codeOf(plain)).toBe(ErrorCode.WORKSPACE_BUSY);
    const waited = await cog
      .rewind('t', later.id, { files: true, agents: [agent], force: true, toolSettleMs: 100 })
      .catch((error: unknown) => error);
    expect(codeOf(waited)).toBe(ErrorCode.WORKSPACE_BUSY);
    expect((waited as Error).message).toContain('have not ended');
  });

  it('keeps the checkpoint a retention would prune until it is restored', async () => {
    const retained = new LocalWorkspace({
      root,
      id: 'project-ws',
      snapshots: { retain: { count: 1 } },
    });
    try {
      const { cog } = runtime({ one: [write('a.txt', '1')], two: [write('a.txt', '2')] });
      const agent = coder({ workspace: retained });
      await cog.run(agent, { input: 'one', threadId: 'r' });
      await cog.run(agent, { input: 'two', threadId: 'r' });
      const entries = await path(cog, 'r');
      const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;
      writeFileSync(join(root, 'a.txt'), 'later');
      const report = await cog.rewind('r', point.id, { files: true, agents: [agent] });
      expect(text('a.txt')).toBe('1');
      expect(report.files?.safetySnapshotId).toBeDefined();
    } finally {
      await retained.dispose();
    }
  });

  it('takes a safety snapshot that brings back exactly what the rewind changed', async () => {
    const big = (fill: string) => fill.repeat(150);
    const { cog } = runtime(
      {
        one: [write('big.txt', big('a')), write('small.txt', 's1')],
        two: [write('big.txt', big('b')), write('extra.txt', 'x')],
      },
      { checkpoints: { maxFileBytes: 100, exclude: ['*.log'] } }
    );
    const agent = coder({ checkpoints: { maxFileBytes: 200 } });
    await cog.run(agent, { input: 'one', threadId: 's' });
    await cog.run(agent, { input: 'two', threadId: 's' });
    writeFileSync(join(root, 'note.log'), 'a log the checkpoints leave out at runtime level');
    const state = () =>
      ['big.txt', 'small.txt', 'extra.txt', 'note.log'].map((name) => {
        try {
          return [name, text(name)];
        } catch {
          return [name, undefined];
        }
      });
    const before = state();
    const entries = await path(cog, 's');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;
    const report = await cog.rewind('s', point.id, { files: true, agents: [agent] });
    expect(text('big.txt')).toBe(big('a'));
    await workspace.restore(report.files!.safetySnapshotId!);
    expect(state()).toEqual(before);
  });

  it('counts a run on a side branch of the thread as busy, and stops it with force', async () => {
    const gate = deferred();
    const toolStarted = deferred();
    const { cog } = runtime({
      one: [write('a.txt', '1')],
      go: [{ id: 'w', name: 'wait', arguments: {} }],
    });
    const agent = coder({
      tools: [
        ...workspaceTools(undefined, { requireApproval: () => false }),
        waiting(gate.promise, toolStarted),
      ],
    });
    await cog.run(agent, { input: 'one', threadId: 'side' });
    await cog.run(agent, { input: 'one more', threadId: 'side' });
    const entries = await path(cog, 'side');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'one more') - 1]!;
    const aside = cog.run(agent, {
      input: 'go',
      threadId: 'side',
      branch: { fromEntryId: point.id, activate: false },
    });
    aside.catch(() => undefined);
    await toolStarted.promise;
    const refused = await cog
      .rewind('side', point.id, { files: true, agents: [agent] })
      .catch((error: unknown) => error);
    expect(codeOf(refused)).toBe(ErrorCode.WORKSPACE_BUSY);
    const report = await cog.rewind('side', point.id, {
      files: true,
      agents: [agent],
      force: true,
    });
    expect(report.runs.interrupted).toHaveLength(1);
    await expect(aside).rejects.toMatchObject({ code: ErrorCode.RUN_INTERRUPTED });
    gate.resolve();
  });
});

describe('rewind and fork guards, round seven', () => {
  it('keeps the exact checkpoint of the point in a fork, for its rewinds and its forks', async () => {
    writeFileSync(join(root, 'a.txt'), 'v0');
    const { cog } = runtime({ one: [write('a.txt', 'v1')], two: [write('a.txt', 'v2')] });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 's' });
    await cog.run(agent, { input: 'two', threadId: 's' });
    const entries = await path(cog, 's');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;

    const { thread, files } = await cog.forkThread('s', point.id, { files: true, workspace });
    expect(files).toMatchObject({ exact: true });
    expect(text('a.txt')).toBe('v1');
    writeFileSync(join(root, 'a.txt'), 'changed in the fork');
    const leaf = (await path(cog, thread.id)).at(-1)!;
    const rewound = await cog.rewind(thread.id, leaf.id, { files: true, workspace });
    expect(rewound.files).toMatchObject({ exact: true, entryId: files!.entryId });
    expect(text('a.txt')).toBe('v1');

    const plain = await cog.forkThread('s', point.id);
    writeFileSync(join(root, 'a.txt'), 'changed again');
    const plainLeaf = (await path(cog, plain.thread.id)).at(-1)!;
    await cog.rewind(plain.thread.id, plainLeaf.id, { files: true, workspace });
    expect(text('a.txt')).toBe('v1');

    writeFileSync(join(root, 'a.txt'), 'changed once more');
    const again = await cog.forkThread(thread.id, leaf.id, { files: true, workspace });
    expect(again.files).toMatchObject({ exact: true, entryId: files!.entryId });
    expect(text('a.txt')).toBe('v1');
  });
});

describe('rewind and fork guards, round five', () => {
  async function threadIds(cog: Cogitator): Promise<string[]> {
    const memory = await cog.getMemory();
    const page = await memory!.listThreads();
    if (!page.success) throw new Error(page.error);
    return page.data.threads.map((thread) => thread.id).sort();
  }

  async function forksOf(cog: Cogitator, threadId: string): Promise<unknown> {
    const memory = await cog.getMemory();
    const read = await memory!.getThread(threadId);
    if (!read.success) throw new Error(read.error);
    return read.data?.metadata.memoryForks;
  }

  it('restores the same checkpoint when a rewind to a point is repeated, as a fork from it does', async () => {
    const { cog } = runtime({ one: [write('a.txt', 'v1')], two: [write('a.txt', 'v2')] });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 'r' });
    await cog.run(agent, { input: 'two', threadId: 'r' });
    expect(text('a.txt')).toBe('v2');
    const entries = await path(cog, 'r');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;

    const first = await cog.rewind('r', point.id, { files: true, workspace });
    expect(text('a.txt')).toBe('v1');
    expect(first.files).toMatchObject({ exact: true, restored: ['a.txt'] });
    const again = await cog.rewind('r', point.id, { files: true, workspace });
    expect(text('a.txt')).toBe('v1');
    expect(again.files).toMatchObject({ entryId: first.files!.entryId, exact: true, restored: [] });
    const fork = await cog.forkThread('r', point.id, { files: true, workspace, dryRun: true });
    expect(fork.files?.entryId).toBe(first.files!.entryId);
  });

  it('drops the checkpoint of a user message that could not be written', async () => {
    const { cog } = runtime({ one: [write('a.txt', 'v1')] });
    const memory = (await cog.getMemory())!;
    const add = memory.addEntry.bind(memory);
    memory.addEntry = async (entry) =>
      entry.message.role === 'user' ? { success: false, error: 'the store is full' } : add(entry);
    await cog.run(coder(), { input: 'one', threadId: 'lost' });
    const taken = await workspace.listSnapshots();
    expect(taken.filter((snapshot) => snapshot.metadata?.threadId === 'lost')).toEqual([]);
  });

  it('keeps one key for a workspace whose root is made later under a symlink', async () => {
    const real = join(base, 'real');
    mkdirSync(real);
    symlinkSync(real, join(base, 'link'));
    const runs = new WorkspaceRuns();
    const later = new LocalWorkspace({ root: join(base, 'link', 'later') });
    const same = new LocalWorkspace({ root: join(real, 'later') });
    const done = deferred();
    try {
      const seat = await runs.enter(
        { runId: () => 'early', threadId: 'early', abort: () => undefined, done: done.promise },
        later
      );
      await later.start();
      expect(later.root).toBe(join(real, 'later'));
      expect((await runs.active(later)).map((run) => run.runId())).toEqual(['early']);
      expect((await runs.active(same)).map((run) => run.runId())).toEqual(['early']);
      const tool = deferred();
      seat.track(tool.promise);
      expect(await runs.toolsInFlight(same)).toBe(1);
      tool.resolve();
      seat.release();
      expect(await runs.active(later)).toEqual([]);
    } finally {
      done.resolve();
      await Promise.all([later.dispose(), same.dispose()]);
    }
  });

  it('leaves no thread, link or copied checkpoint behind when a fork is refused, nor after a dry run', async () => {
    const { cog } = runtime({
      one: [write('private.txt', 'from the checkpoint')],
      two: [write('a.txt', 'x')],
    });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 'p' });
    await cog.run(agent, { input: 'two', threadId: 'p' });
    const forkRoot = join(base, 'fork-refused');
    const target = new LocalWorkspace({ root: forkRoot, snapshots: { exclude: ['private.txt'] } });
    try {
      await target.start();
      writeFileSync(join(forkRoot, 'private.txt'), 'only here');
      const entries = await path(cog, 'p');
      const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;
      const options = { files: true, workspace: target, source: workspace } as const;

      const refused = await cog.forkThread('p', point.id, options).catch((error: unknown) => error);
      expect(WorkspaceError.is(refused, 'DENIED')).toBe(true);
      expect(await threadIds(cog)).toEqual(['p']);
      expect(await forksOf(cog, 'p')).toBeUndefined();
      expect(await target.listSnapshots()).toEqual([]);

      const plan = await cog.forkThread('p', point.id, { ...options, dryRun: true });
      expect(plan.snapshotsCopied.length).toBeGreaterThan(0);
      expect(await target.listSnapshots()).toEqual([]);
    } finally {
      await target.dispose();
    }
  });

  it('refuses a fork into a thread id taken already, before it changes anything', async () => {
    const { cog } = runtime({ one: [write('a.txt', 'v1')], two: [write('a.txt', 'v2')] });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 'src' });
    await cog.run(agent, { input: 'two', threadId: 'src' });
    await cog.run(agent, { input: 'one', threadId: 'taken' });
    const before = await path(cog, 'taken');
    const snapshots = (await workspace.listSnapshots()).length;
    const entries = await path(cog, 'src');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;

    for (const options of [
      {},
      { files: true, workspace },
      { files: true, workspace, dryRun: true },
    ]) {
      const refused = await cog
        .forkThread('src', point.id, { ...options, newThreadId: 'taken' })
        .catch((error: unknown) => error);
      expect(codeOf(refused)).toBe(ErrorCode.VALIDATION_ERROR);
    }
    expect((await path(cog, 'taken')).map((entry) => entry.id)).toEqual(
      before.map((entry) => entry.id)
    );
    expect(await forksOf(cog, 'src')).toBeUndefined();
    expect(await workspace.listSnapshots()).toHaveLength(snapshots);
    expect(text('a.txt')).toBe('v1');
  });

  it('takes the fork back when its files fail to restore, keeping the safety snapshot only when files changed', async () => {
    const { cog } = runtime({ one: [write('a.txt', 'v1')], two: [write('a.txt', 'v2')] });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 'q' });
    await cog.run(agent, { input: 'two', threadId: 'q' });
    const forkRoot = join(base, 'fork-failing');
    const target = new LocalWorkspace({ root: forkRoot });
    try {
      await target.start();
      writeFileSync(join(forkRoot, 'a.txt'), 'in the fork');
      const entries = await path(cog, 'q');
      const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;
      const restore = target.restore.bind(target);
      let failure = new WorkspaceError('BUSY', 'a command started');
      let halfway = false;
      vi.spyOn(target, 'restore').mockImplementation(async (id, options) => {
        if (options?.dryRun) return restore(id, options);
        if (halfway) writeFileSync(join(forkRoot, 'a.txt'), 'halfway');
        throw failure;
      });
      const options = { files: true, workspace: target, source: workspace } as const;

      await expect(cog.forkThread('q', point.id, options)).rejects.toBe(failure);
      expect(await threadIds(cog)).toEqual(['q']);
      expect(await forksOf(cog, 'q')).toEqual([]);
      expect(await target.listSnapshots()).toEqual([]);

      failure = new WorkspaceError('IO', 'the disk went away before anything changed');
      await expect(cog.forkThread('q', point.id, options)).rejects.toBe(failure);
      expect(await target.listSnapshots()).toEqual([]);

      failure = new WorkspaceError('BUSY', 'a command started halfway through');
      halfway = true;
      await expect(cog.forkThread('q', point.id, options)).rejects.toBe(failure);
      expect(await threadIds(cog)).toEqual(['q']);
      const left = await target.listSnapshots();
      expect(left.map((snapshot) => snapshot.metadata?.safety)).toEqual([true]);
      expect(text('a.txt', forkRoot)).toBe('halfway');
      vi.mocked(target.restore).mockRestore();
      await target.restore(left[0]!.id);
      expect(text('a.txt', forkRoot)).toBe('in the fork');
    } finally {
      await target.dispose();
    }
  });
});

describe('rewind and fork guards, round three', () => {
  const asRoot = process.getuid?.() === 0;

  it('refuses a restore it could not undo, a file in the way that cannot be read', async () => {
    if (asRoot) return;
    const { cog } = runtime({ one: [write('a.txt', '1')], two: [write('a.txt', '2')] });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 'u' });
    await cog.run(agent, { input: 'two', threadId: 'u' });
    const entries = await path(cog, 'u');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;
    const before = (await workspace.listSnapshots()).map((snapshot) => snapshot.id);
    chmodSync(join(root, 'a.txt'), 0o000);
    try {
      const refused = await cog
        .rewind('u', point.id, { files: true, agents: [agent] })
        .catch((error: unknown) => error);
      expect(WorkspaceError.is(refused, 'DENIED')).toBe(true);
      expect((refused as Error).message).toContain('a.txt');
      expect((await workspace.listSnapshots()).map((snapshot) => snapshot.id)).toEqual(before);
      expect((await path(cog, 'u')).at(-1)!.id).toBe(entries.at(-1)!.id);
    } finally {
      chmodSync(join(root, 'a.txt'), 0o644);
    }
    expect(text('a.txt')).toBe('2');
  });

  it('counts a run in a workspace nested in the one a rewind restores', async () => {
    const gate = deferred();
    const toolStarted = deferred();
    const inner = new LocalWorkspace({ root: join(root, 'sub'), id: 'sub-ws' });
    try {
      const { cog } = runtime({
        one: [write('a.txt', '1')],
        go: [{ id: 'w', name: 'wait', arguments: {} }],
      });
      const outer = coder();
      await cog.run(outer, { input: 'one', threadId: 'outer' });
      await cog.run(outer, { input: 'one more', threadId: 'outer' });
      const nested = coder({
        id: 'nested',
        name: 'nested',
        workspace: inner,
        tools: [waiting(gate.promise, toolStarted)],
      });
      const working = cog.run(nested, { input: 'go', threadId: 'inner' });
      working.catch(() => undefined);
      await toolStarted.promise;
      const entries = await path(cog, 'outer');
      const point =
        entries[entries.findIndex((entry) => entry.message.content === 'one more') - 1]!;
      const refused = await cog
        .rewind('outer', point.id, { files: true, agents: [outer] })
        .catch((error: unknown) => error);
      expect(codeOf(refused)).toBe(ErrorCode.WORKSPACE_BUSY);
      gate.resolve();
      await working;
      writeFileSync(join(root, 'a.txt'), 'changed');
      const report = await cog.rewind('outer', point.id, { files: true, agents: [outer] });
      expect(report.files?.restored).toContain('a.txt');
    } finally {
      await inner.dispose();
    }
  });

  it('lets one waiter at a time take a workspace a release frees', async () => {
    const runs = new WorkspaceRuns();
    const order: string[] = [];
    const first = await runs.lock(workspace);
    const waiters = ['a', 'b', 'c'].map(async (name) => {
      const release = await runs.lock(workspace);
      order.push(`${name}+`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${name}-`);
      release();
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    first();
    await Promise.all(waiters);
    for (let at = 0; at < order.length; at += 2) {
      expect(order[at]?.endsWith('+')).toBe(true);
      expect(order[at + 1]).toBe(`${order[at]!.slice(0, -1)}-`);
    }
    expect(order).toHaveLength(6);
  });

  it('refuses a fork whose files the workspace snapshot excludes would leave out of the safety snapshot', async () => {
    const { cog } = runtime({
      one: [write('private.txt', 'from the checkpoint')],
      two: [write('a.txt', 'x')],
    });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 'p' });
    await cog.run(agent, { input: 'two', threadId: 'p' });
    const forkRoot = join(base, 'fork-excluding');
    const target = new LocalWorkspace({ root: forkRoot, snapshots: { exclude: ['private.txt'] } });
    try {
      await target.start();
      writeFileSync(join(forkRoot, 'private.txt'), 'only here');
      const entries = await path(cog, 'p');
      const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;
      const refused = await cog
        .forkThread('p', point.id, { files: true, workspace: target, source: workspace })
        .catch((error: unknown) => error);
      expect(WorkspaceError.is(refused, 'DENIED')).toBe(true);
      expect((refused as Error).message).toContain('private.txt');
      expect(readFileSync(join(forkRoot, 'private.txt'), 'utf8')).toBe('only here');
    } finally {
      await target.dispose();
    }
  });

  it('matches runs, tool calls and holds of overlapping roots both ways', async () => {
    const runs = new WorkspaceRuns();
    const parent = new LocalWorkspace({ root });
    const child = new LocalWorkspace({ root: join(root, 'pkg') });
    const sibling = new LocalWorkspace({ root: join(base, 'project-other') });
    const done = deferred();
    const run = (runId: string) => ({
      runId: () => runId,
      threadId: runId,
      abort: () => undefined,
      done: done.promise,
    });
    try {
      await Promise.all([parent.start(), child.start(), sibling.start()]);
      const inChild = await runs.enter(run('child-run'), child);
      expect((await runs.active(parent)).map((each) => each.runId())).toEqual(['child-run']);
      expect(await runs.active(sibling)).toEqual([]);
      const inParent = await runs.enter(run('parent-run'), parent);
      expect((await runs.active(child)).map((each) => each.runId()).sort()).toEqual([
        'child-run',
        'parent-run',
      ]);
      const tool = deferred();
      inChild.track(tool.promise);
      expect(await runs.toolsInFlight(parent)).toBe(1);
      expect(await runs.toolsSettled(parent, 20)).toBe(false);
      tool.resolve();
      expect(await runs.toolsSettled(parent, 1000)).toBe(true);
      const release = await runs.lock(parent);
      let entered = false;
      const waiting = runs.enter(run('late'), child).then((seat) => {
        entered = true;
        return seat;
      });
      const siblingSeat = await runs.enter(run('free'), sibling);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(entered).toBe(false);
      release();
      (await waiting).release();
      inChild.release();
      inParent.release();
      siblingSeat.release();
    } finally {
      done.resolve();
      await Promise.all([parent.dispose(), child.dispose(), sibling.dispose()]);
    }
  });
});

describe('rewind and fork guards', () => {
  it('refuses while a run of another thread works in the same workspace, and stops it with force', async () => {
    const gate = deferred();
    const toolStarted = deferred();
    const { cog } = runtime({
      one: [write('a.txt', '1')],
      go: [{ id: 'w', name: 'wait', arguments: {} }],
    });
    const agent = coder({
      tools: [
        ...workspaceTools(undefined, { requireApproval: () => false }),
        waiting(gate.promise, toolStarted),
      ],
    });
    await cog.run(agent, { input: 'one', threadId: 'a' });
    await cog.run(agent, { input: 'one more', threadId: 'a' });
    writeFileSync(join(root, 'a.txt'), 'later');
    const other = cog.run(agent, { input: 'go', threadId: 'b' });
    other.catch(() => undefined);
    await toolStarted.promise;
    const entries = await path(cog, 'a');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'one more') - 1]!;

    const refused = await cog
      .rewind('a', point.id, { files: true, agents: [agent] })
      .catch((error: unknown) => error);
    expect(codeOf(refused)).toBe(ErrorCode.WORKSPACE_BUSY);
    const plan = await cog.rewind('a', point.id, { files: true, agents: [agent], dryRun: true });
    expect(plan.runs.going).toHaveLength(1);
    expect(text('a.txt')).toBe('later');

    const report = await cog.rewind('a', point.id, { files: true, agents: [agent], force: true });
    await expect(other).rejects.toMatchObject({ code: ErrorCode.RUN_INTERRUPTED });
    expect(report.runs.interrupted).toHaveLength(1);
    expect(text('a.txt')).toBe('1');
    gate.resolve();
  });

  it('holds the thread for the whole rewind: a run asked for meanwhile waits, then goes on after it', async () => {
    const { cog } = runtime({ one: [write('a.txt', '1')], two: [write('a.txt', '2')] });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 't' });
    await cog.run(agent, { input: 'two', threadId: 't' });
    const point = (await path(cog, 't'))[2]!;
    const restoring = deferred();
    const release = deferred();
    const restore = workspace.restore.bind(workspace);
    vi.spyOn(workspace, 'restore').mockImplementation(async (id, options) => {
      if (!options?.dryRun) {
        restoring.resolve();
        await release.promise;
      }
      return restore(id, options);
    });
    const rewinding = cog.rewind('t', point.id, { files: true, agents: [agent] });
    await restoring.promise;
    let started = false;
    const later = cog.run(agent, {
      input: 'three',
      threadId: 't',
      onRunStart: () => {
        started = true;
      },
    });
    const refused = await cog
      .run(agent, { input: 'four', threadId: 't', multitaskStrategy: 'reject' })
      .catch((error: unknown) => error);
    expect(codeOf(refused)).toBe(ErrorCode.THREAD_BUSY);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(false);
    release.resolve();
    const report = await rewinding;
    await later;
    const after = await path(cog, 't');
    expect(after.map((entry) => entry.message.content)).toContain('three');
    expect(report.conversation.cut.every((id) => after.every((entry) => entry.id !== id))).toBe(
      true
    );
    expect(after[3]?.message.content).toBe('three');
  });

  it('checks the restore before it stops anything, and its dry run says when commands run', async () => {
    const gate = deferred();
    const toolStarted = deferred();
    const { cog } = runtime({
      one: [write('a.txt', '1')],
      go: [{ id: 'w', name: 'wait', arguments: {} }],
    });
    const agent = coder({
      tools: [
        ...workspaceTools(undefined, { requireApproval: () => false }),
        waiting(gate.promise, toolStarted),
      ],
    });
    await cog.run(agent, { input: 'one', threadId: 't' });
    await cog.run(agent, { input: 'one again', threadId: 't' });
    const entries = await path(cog, 't');
    const users = entries.filter((entry) => entry.message.role === 'user');
    const point = entries[entries.indexOf(users[1]!) - 1]!;
    const running = cog.run(agent, { input: 'go', threadId: 't' });
    let ended = false;
    void running.then(
      () => undefined,
      () => {
        ended = true;
      }
    );
    await toolStarted.promise;
    await workspace.deleteSnapshot(fileCheckpointOf(users[1]!.metadata)!.snapshotId);
    const refused = await cog
      .rewind('t', point.id, { files: true, agents: [agent], force: true })
      .catch((error: unknown) => error);
    expect(codeOf(refused)).toBe(ErrorCode.VALIDATION_ERROR);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toBe(false);
    gate.resolve();
    await running;

    const stopCommand = new AbortController();
    const command = workspace
      .exec('sleep 60', { signal: stopCommand.signal })
      .catch(() => undefined);
    const firstSnapshot = fileCheckpointOf(users[0]!.metadata)!.snapshotId;
    await until(
      async () => (await workspace.restore(firstSnapshot, { dryRun: true })).busy === true
    );
    const first = entries[entries.indexOf(users[0]!)]!;
    const plan = await cog.rewind('t', first.id, { files: true, agents: [agent], dryRun: true });
    expect(plan.files?.busy).toBe(true);
    const busy = await cog
      .rewind('t', first.id, { files: true, agents: [agent] })
      .catch((error: unknown) => error);
    expect(codeOf(busy)).toBe(ErrorCode.WORKSPACE_BUSY);
    stopCommand.abort();
    await command;
  });

  it('never forces a durable run another process holds while files are restored', async () => {
    const hanging = deferred();
    const hang = tool({
      name: 'hang',
      description: 'Hangs',
      parameters: z.object({}),
      execute: () => {
        hanging.resolve();
        return new Promise<string>(() => undefined);
      },
    });
    const sqlite: CogitatorConfig['memory'] = {
      adapter: 'sqlite',
      sqlite: { path: join(base, 'memory.db') },
    };
    const plan = { one: [], go: [{ id: 'h', name: 'hang', arguments: {} }] };
    const first = runtime(plan, { durable: { owner: 'a' } }, sqlite);
    const agent = coder({ tools: [hang] });
    await first.cog.run(agent, { input: 'one', threadId: 'held' });
    const point = (await path(first.cog, 'held')).at(-1)!;
    first.cog.run(agent, { input: 'go', threadId: 'held' }).catch(() => undefined);
    await hanging.promise;

    const second = runtime(plan, { durable: { owner: 'b' } }, sqlite);
    for (const call of [
      () => second.cog.rewind('held', point.id, { files: true, agents: [agent], force: true }),
      () => second.cog.forkThread('held', point.id, { files: true, agents: [agent], force: true }),
    ]) {
      const refused = await call().catch((error: unknown) => error);
      expect(codeOf(refused)).toBe(ErrorCode.THREAD_BUSY);
      expect((refused as Error).message).toContain('another process holds');
    }
    const forked = await second.cog
      .forkThread('held', point.id, { files: true, agents: [agent] })
      .catch((error: unknown) => error);
    expect(codeOf(forked)).toBe(ErrorCode.THREAD_BUSY);
    const conversationOnly = await second.cog.rewind('held', point.id, {
      agents: [agent],
      force: true,
    });
    expect(conversationOnly.runs.durable).toHaveLength(1);
  });

  it('takes checkpoints in the workspace of the agent a run handed over to', async () => {
    const otherRoot = join(base, 'other');
    const other = new LocalWorkspace({ root: otherRoot, id: 'other-ws' });
    try {
      const specialist = new Agent({
        id: 'specialist',
        name: 'specialist',
        model: 'mock/m',
        instructions: 'You specialize.',
        workspace: other,
      });
      const { cog } = runtime({
        start: [{ id: 'h', name: 'transfer_to_specialist', arguments: {} }],
      });
      const triage = coder({ handoffs: [specialist] });
      const handle = cog.start(triage, { input: 'start', threadId: 'h' });
      handle.followUp('more');
      await handle.result;
      const users = (await path(cog, 'h')).filter((entry) => entry.message.role === 'user');
      expect(users.map((entry) => fileCheckpointOf(entry.metadata)?.workspaceId)).toEqual([
        'project-ws',
        'other-ws',
      ]);
      const last = (await path(cog, 'h')).at(-1)!;
      const wrong = await cog
        .rewind('h', last.id, { files: true, memory: false, workspace })
        .catch((error: unknown) => error);
      expect(codeOf(wrong)).toBe(ErrorCode.VALIDATION_ERROR);
      expect((wrong as Error).message).toContain('does not keep checkpoint');
    } finally {
      await other.dispose();
    }
  });

  it('refuses a checkpoint reference forged into an entry of another thread', async () => {
    const { cog } = runtime({ one: [write('a.txt', 'one')] });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 'victim' });
    const stolen = fileCheckpointOf(
      (await path(cog, 'victim')).find((entry) => entry.message.role === 'user')!.metadata
    )!;
    const memory = (await cog.getMemory())!;
    await memory.createThread('coder', {}, 'attacker');
    const forged = await memory.addEntry({
      threadId: 'attacker',
      message: { role: 'user', content: 'hi' },
      tokenCount: 1,
      metadata: { [FILE_CHECKPOINT_KEY]: stolen },
    });
    if (!forged.success) throw new Error(forged.error);
    const refused = await cog
      .rewind('attacker', forged.data.id, { files: true, memory: false, workspace })
      .catch((error: unknown) => error);
    expect(codeOf(refused)).toBe(ErrorCode.VALIDATION_ERROR);
    expect((refused as Error).message).toContain('was not taken for entry');
  });

  it('aborts with force a run whose approval hook never answers', async () => {
    const risky = tool({
      name: 'deploy',
      description: 'Deploys',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async () => 'deployed',
    });
    const asked = deferred();
    const { cog } = runtime(
      { one: [], deploy: [{ id: 'd', name: 'deploy', arguments: {} }] },
      {
        middleware: [
          {
            name: 'slow-gate',
            decideApproval: () => {
              asked.resolve();
              return new Promise(() => undefined);
            },
          },
        ],
      }
    );
    const agent = coder({ tools: [risky] });
    await cog.run(agent, { input: 'one', threadId: 'gate' });
    const point = (await path(cog, 'gate')).at(-1)!;
    const stuck = cog.run(agent, { input: 'deploy', threadId: 'gate' });
    stuck.catch(() => undefined);
    await asked.promise;
    const report = await cog.rewind('gate', point.id, { agents: [agent], force: true });
    expect(report.runs.interrupted).toHaveLength(1);
    await expect(stuck).rejects.toMatchObject({ code: ErrorCode.RUN_INTERRUPTED });
  });

  it('refuses a rewind a tool of a run of the thread asks for, instead of waiting for itself', async () => {
    let caught: unknown;
    let cogRef: Cogitator | undefined;
    const selfRewind = tool({
      name: 'self_rewind',
      description: 'Rewinds its own thread',
      parameters: z.object({}),
      execute: async () => {
        const entries = await path(cogRef!, 'self');
        await cogRef!
          .rewind('self', entries[0]!.id, { force: true, agents: ['coder'] })
          .catch((error: unknown) => {
            caught = error;
          });
        return 'tried';
      },
    });
    const { cog } = runtime({ again: [{ id: 's', name: 'self_rewind', arguments: {} }] });
    cogRef = cog;
    const agent = coder({ tools: [selfRewind] });
    await cog.run(agent, { input: 'first', threadId: 'self' });
    const result = await cog.run(agent, { input: 'again', threadId: 'self' });
    expect(result.output).toContain('done');
    expect(codeOf(caught)).toBe(ErrorCode.VALIDATION_ERROR);
    expect((caught as Error).message).toContain('would have to stop that very run');
  });

  it('takes a safety snapshot first that undoes the rewind, and previews a fork with its files', async () => {
    const { cog } = runtime({ one: [write('a.txt', '1')], two: [write('a.txt', '2')] });
    const agent = coder();
    await cog.run(agent, { input: 'one', threadId: 'undo' });
    await cog.run(agent, { input: 'two', threadId: 'undo' });
    writeFileSync(join(root, 'notes.md'), 'work in progress');
    const entries = await path(cog, 'undo');
    const point = entries[entries.findIndex((entry) => entry.message.content === 'two') - 1]!;

    const preview = await cog.forkThread('undo', point.id, {
      files: true,
      agents: [agent],
      dryRun: true,
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.files).toMatchObject({ restored: ['a.txt'], deleted: ['notes.md'] });
    expect(text('a.txt')).toBe('2');
    const memory = (await cog.getMemory())!;
    const threads = await memory.listThreads();
    expect(threads.success && threads.data.threads.map((thread) => thread.id)).toEqual(['undo']);

    const report = await cog.rewind('undo', point.id, { files: true, agents: [agent] });
    expect(report.files?.safetySnapshotId).toMatch(/^snap_/);
    expect(text('a.txt')).toBe('1');
    await workspace.restore(report.files!.safetySnapshotId!);
    expect(text('a.txt')).toBe('2');
    expect(text('notes.md')).toBe('work in progress');
  });
});
