import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  FILE_CHECKPOINT_AT_KEY,
  FILE_CHECKPOINT_KEY,
  fileCheckpointOf,
  type ChatRequest,
  type ChatResponse,
  type CogitatorConfig,
  type MemoryEntry,
  type ToolCall,
} from '@cogitator-ai/types';
import { MemoryItems } from '@cogitator-ai/memory';
import { Agent } from '../agent';
import { Cogitator } from '../cogitator';
import { tool } from '../tool';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';
import { WORKSPACE_CHECKPOINTS_DIR } from '../workspace/snapshot-store';
import { checkpointAt, checkpointSettings, checkpointsOn } from '../cogitator/file-checkpoints';
import { answer, callTools, deferred, scriptedBackend } from './helpers/scripted-backend';

let base: string;
let root: string;
let workspace: LocalWorkspace;
const cogs: Cogitator[] = [];

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'file-checkpoints-')));
  root = join(base, 'project');
  workspace = new LocalWorkspace({ root, id: 'project-ws', snapshots: { gcGraceMs: 0 } });
  await workspace.start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cog of cogs.splice(0)) await cog.close();
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

function text(path: string, at = root): string {
  return readFileSync(join(at, path), 'utf8');
}

/**
 * A model that answers each user message by the plan for its text: the tool calls to make, one
 * turn each, then the answer
 */
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

function write(path: string, content: string, id = 'w'): ToolCall {
  return { id, name: 'write_file', arguments: { path, content } };
}

function shell(command: string, id = 'sh'): ToolCall {
  return { id, name: 'run_command', arguments: { command } };
}

function runtime(
  plan: Record<string, ToolCall[]>,
  config: Partial<CogitatorConfig> = {},
  memory: CogitatorConfig['memory'] = { adapter: 'memory' }
) {
  const { backend, requests } = plannedBackend(plan);
  const cog = new Cogitator({ llm: { backends: { mock: backend } }, memory, ...config });
  cogs.push(cog);
  return { cog, requests };
}

const coder = (extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) =>
  new Agent({
    id: 'coder',
    name: 'coder',
    model: 'mock/m',
    instructions: 'You edit files.',
    tools: workspaceTools(undefined, { requireApproval: () => false }),
    workspace,
    ...extra,
  });

async function path(cog: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const memory = await cog.getMemory();
  const read = await memory!.getPath!({ threadId, types: 'all' });
  if (!read.success) throw new Error(read.error);
  return read.data;
}

function userEntries(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return entries.filter(
    (entry) => (entry.type ?? 'message') === 'message' && entry.message.role === 'user'
  );
}

/** The last entry of the turn that answered user message `said` */
function turnEnd(entries: readonly MemoryEntry[], said: string): MemoryEntry {
  const start = entries.findIndex(
    (entry) => entry.message.role === 'user' && entry.message.content === said
  );
  let end = start;
  for (let at = start + 1; at < entries.length; at++) {
    if (entries[at].message.role === 'user') break;
    end = at;
  }
  return entries[end];
}

async function threeTurns(cog: Cogitator, agent: Agent, threadId = 'chat') {
  await cog.run(agent, { input: 'one', threadId });
  await cog.run(agent, { input: 'two', threadId });
  await cog.run(agent, { input: 'three', threadId });
  return path(cog, threadId);
}

const editPlan = {
  one: [write('app.ts', 'v1')],
  two: [write('app.ts', 'v2'), write('extra.ts', 'extra')],
  three: [write('app.ts', 'v3'), shell('rm extra.ts && echo gen > gen.txt')],
};

describe('file checkpoints', () => {
  it('takes a checkpoint before every user message, named in its entry and labelled with its id', async () => {
    const { cog } = runtime(editPlan, { checkpoints: true });
    const entries = await threeTurns(cog, coder());
    const users = userEntries(entries);
    expect(users).toHaveLength(3);
    const refs = users.map((entry) => fileCheckpointOf(entry.metadata));
    expect(refs.every((ref) => ref?.workspaceId === 'project-ws' && ref.root === root)).toBe(true);
    const snapshots = await workspace.listSnapshots();
    expect(snapshots.map((snapshot) => snapshot.id)).toEqual(refs.map((ref) => ref!.snapshotId));
    expect(snapshots.map((snapshot) => snapshot.label)).toEqual(users.map((entry) => entry.id));
    expect(snapshots[0]?.metadata).toMatchObject({ threadId: 'chat', entryId: users[0]!.id });
  });

  it('takes none unless they are turned on', async () => {
    const { cog } = runtime(editPlan);
    const entries = await threeTurns(cog, coder());
    expect(userEntries(entries).some((entry) => entry.metadata?.[FILE_CHECKPOINT_KEY])).toBe(false);
    expect(existsSync(join(root, ...WORKSPACE_CHECKPOINTS_DIR.split('/')))).toBe(false);
  });

  it('lets the agent and the run turn them on or off over the runtime', async () => {
    const { cog } = runtime(editPlan, { checkpoints: true });
    await cog.run(coder({ checkpoints: false }), { input: 'one', threadId: 'a' });
    await cog.run(coder({ checkpoints: false }), {
      input: 'two',
      threadId: 'a',
      checkpoints: true,
    });
    const users = userEntries(await path(cog, 'a'));
    expect(users.map((entry) => fileCheckpointOf(entry.metadata) !== undefined)).toEqual([
      false,
      true,
    ]);
    expect(
      checkpointSettings({ exclude: ['dist/**'] }, { exclude: ['*.log'], maxFileBytes: 10 }, true)
    ).toEqual({ exclude: ['dist/**', '*.log'], maxFileBytes: 10 });
    expect(checkpointSettings(true, { enabled: false }, undefined)).toBeUndefined();
  });

  it('takes a checkpoint before a follow-up message too', async () => {
    const { cog } = runtime(
      { one: [write('a.txt', '1')], more: [write('a.txt', '2')] },
      { checkpoints: true }
    );
    const handle = cog.start(coder(), { input: 'one', threadId: 'q' });
    handle.followUp('more');
    await handle.result;
    const users = userEntries(await path(cog, 'q'));
    expect(users.map((entry) => entry.message.content)).toEqual(['one', 'more']);
    expect(users.every((entry) => fileCheckpointOf(entry.metadata))).toBe(true);
    const back = await cog.rewind('q', users[1]!.id, { files: true, agents: [coder()] });
    expect(back.files?.exact).toBe(true);
    expect(text('a.txt')).toBe('1');
  });

  it('rewinds the conversation, the memory and the files in one operation', async () => {
    const { cog } = runtime(editPlan, { checkpoints: true });
    const agent = coder();
    const entries = await threeTurns(cog, agent);
    expect(text('app.ts')).toBe('v3');
    expect(text('gen.txt')).toBe('gen\n');
    const two = userEntries(entries)[1]!;
    const items = new MemoryItems({ adapter: (await cog.getMemory()) as never });
    const [fact] = await items.write([
      {
        kind: 'fact',
        content: 'The app has an extra module.',
        subject: 'app',
        trust: 'user',
        confidence: 0.9,
        scope: { agentId: 'coder' },
        evidence: [{ entryId: two.id, quote: 'two' }],
        verified: true,
        status: 'active',
        saidAt: new Date(),
        sessionAt: new Date(),
      },
    ]);
    const point = turnEnd(entries, 'one');

    const report = await cog.rewind('chat', point.id, { files: true, agents: [agent] });

    expect(report.dryRun).toBe(false);
    expect(report.conversation.rewound).toBe(true);
    expect(report.conversation.cut[0]).toBe(two.id);
    expect(report.conversation.previousLeafId).toBe(entries.at(-1)!.id);
    expect(report.items.stale).toEqual([fact!.id]);
    expect(report.files).toMatchObject({
      entryId: two.id,
      exact: true,
      workspaceId: 'project-ws',
      restored: ['app.ts'],
      deleted: ['gen.txt'],
    });
    expect(text('app.ts')).toBe('v1');
    expect(existsSync(join(root, 'extra.ts'))).toBe(false);
    expect(existsSync(join(root, 'gen.txt'))).toBe(false);
    const after = await path(cog, 'chat');
    expect(after.at(-1)!.id).toBe(point.id);

    await cog.run(agent, { input: 'two', threadId: 'chat' });
    expect(text('app.ts')).toBe('v2');
    expect(text('extra.ts')).toBe('extra');
  });

  it('restores the files before a turn when the point is inside it', async () => {
    const { cog } = runtime(editPlan, { checkpoints: true });
    const agent = coder();
    const entries = await threeTurns(cog, agent);
    const two = userEntries(entries)[1]!;
    const inside = entries.find(
      (entry, at) => at > entries.indexOf(two) && entry.message.role === 'tool'
    )!;
    const report = await cog.rewind('chat', inside.id, { files: true, agents: [agent] });
    expect(report.files).toMatchObject({ entryId: two.id, exact: false });
    expect(text('app.ts')).toBe('v1');
  });

  it('says what a rewind would change on a dry run, and changes nothing', async () => {
    const { cog } = runtime(editPlan, { checkpoints: true });
    const agent = coder();
    const entries = await threeTurns(cog, agent);
    const point = turnEnd(entries, 'one');
    const report = await cog.rewind('chat', point.id, {
      files: true,
      dryRun: true,
      agents: [agent],
    });
    expect(report).toMatchObject({ dryRun: true, conversation: { rewound: false } });
    expect(report.conversation.cut.length).toBeGreaterThan(0);
    expect(report.files).toMatchObject({
      dryRun: true,
      restored: ['app.ts'],
      deleted: ['gen.txt'],
    });
    expect(text('app.ts')).toBe('v3');
    expect((await path(cog, 'chat')).at(-1)!.id).toBe(entries.at(-1)!.id);
  });

  it('leaves the files alone unless asked, or told by the runtime', async () => {
    const plain = runtime(editPlan, { checkpoints: true });
    const agent = coder();
    const entries = await threeTurns(plain.cog, agent);
    const report = await plain.cog.rewind('chat', turnEnd(entries, 'one').id, { agents: [agent] });
    expect(report.files).toBeUndefined();
    expect(text('app.ts')).toBe('v3');

    const told = runtime(editPlan, { checkpoints: { rewindFiles: true } });
    const again = await threeTurns(told.cog, agent, 'other');
    const restored = await told.cog.rewind('other', turnEnd(again, 'one').id, { agents: [agent] });
    expect(restored.files?.restored).toContain('app.ts');
    expect(text('app.ts')).toBe('v1');
  });

  it('restores only the files with memory: false', async () => {
    const { cog } = runtime(editPlan, { checkpoints: true });
    const entries = await threeTurns(cog, coder());
    const report = await cog.rewind('chat', turnEnd(entries, 'one').id, {
      memory: false,
      files: true,
      workspace,
    });
    expect(report.conversation).toMatchObject({ rewound: false, cut: [] });
    expect(text('app.ts')).toBe('v1');
    expect((await path(cog, 'chat')).at(-1)!.id).toBe(entries.at(-1)!.id);
    await expect(cog.rewind('chat', entries[0]!.id, { memory: false })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('refuses files without a checkpoint or a workspace, before it changes anything', async () => {
    const off = runtime(editPlan);
    const agent = coder();
    const entries = await threeTurns(off.cog, agent);
    await expect(
      off.cog.rewind('chat', turnEnd(entries, 'one').id, { files: true, agents: [agent] })
    ).rejects.toThrow(/no file checkpoint/);
    expect((await path(off.cog, 'chat')).at(-1)!.id).toBe(entries.at(-1)!.id);

    const on = runtime(editPlan, { checkpoints: true });
    const kept = await threeTurns(on.cog, agent, 'kept');
    await expect(
      on.cog.rewind('kept', turnEnd(kept, 'one').id, { files: true, agents: ['coder'] })
    ).rejects.toThrow(/needs the workspace/);
    await expect(on.cog.rewind('kept', 'entry_missing', { agents: [agent] })).rejects.toThrow(
      /not on the active branch/
    );
  });

  it('catches what shell commands changed between messages', async () => {
    const { cog } = runtime({}, { checkpoints: true });
    const agent = coder();
    writeFileSync(join(root, 'notes.txt'), 'before');
    await cog.run(agent, { input: 'first', threadId: 'sh' });
    await workspace.exec('echo outside > notes.txt && mkdir -p out && echo built > out/b.txt');
    await cog.run(agent, { input: 'second', threadId: 'sh' });
    await workspace.exec('echo later > notes.txt');
    const entries = await path(cog, 'sh');
    const report = await cog.rewind('sh', turnEnd(entries, 'first').id, {
      files: true,
      agents: [agent],
    });
    expect(report.files?.entryId).toBe(userEntries(entries)[1]!.id);
    expect(text('notes.txt')).toBe('outside\n');
    expect(text('out/b.txt')).toBe('built\n');
    await cog.rewind('sh', entries[0]!.id, { files: true, agents: [agent] });
    expect(text('notes.txt')).toBe('before');
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  it('refuses while a run goes on in the thread, and aborts it with force', async () => {
    const gate = deferred();
    const waitStarted = deferred();
    const wait = tool({
      name: 'wait',
      description: 'Waits',
      parameters: z.object({}),
      execute: async () => {
        waitStarted.resolve();
        await gate.promise;
        return 'waited';
      },
    });
    const { cog } = runtime(
      { one: [], go: [{ id: 'w', name: 'wait', arguments: {} }] },
      { checkpoints: true }
    );
    const agent = coder({ tools: [wait] });
    await cog.run(agent, { input: 'one', threadId: 'busy' });
    const point = (await path(cog, 'busy')).at(-1)!;
    const running = cog.run(agent, { input: 'go', threadId: 'busy' });
    running.catch(() => undefined);
    await waitStarted.promise;

    const refused = await cog
      .rewind('busy', point.id, { agents: [agent] })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CogitatorError);
    expect((refused as CogitatorError).code).toBe(ErrorCode.THREAD_BUSY);
    const plan = await cog.rewind('busy', point.id, { agents: [agent], dryRun: true });
    expect(plan.runs.going).toHaveLength(1);

    const report = await cog.rewind('busy', point.id, { agents: [agent], force: true });
    await expect(running).rejects.toMatchObject({ code: ErrorCode.RUN_INTERRUPTED });
    expect(report.runs.interrupted).toHaveLength(1);
    expect((await path(cog, 'busy')).at(-1)!.id).toBe(point.id);
    gate.resolve();
  });

  it('aborts with force a run that waits for a person to approve a call', async () => {
    const risky = tool({
      name: 'deploy',
      description: 'Deploys',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async () => 'deployed',
    });
    const { cog } = runtime({ one: [], deploy: [{ id: 'd', name: 'deploy', arguments: {} }] });
    const agent = coder({ tools: [risky] });
    await cog.run(agent, { input: 'one', threadId: 'asking' });
    const point = (await path(cog, 'asking')).at(-1)!;
    const asked = deferred();
    const waiting = cog.run(agent, {
      input: 'deploy',
      threadId: 'asking',
      onApproval: () => {
        asked.resolve();
        return new Promise(() => undefined);
      },
    });
    waiting.catch(() => undefined);
    await asked.promise;
    const report = await cog.rewind('asking', point.id, { agents: [agent], force: true });
    expect(report.runs.interrupted).toHaveLength(1);
    await expect(waiting).rejects.toMatchObject({ code: ErrorCode.RUN_INTERRUPTED });
  });

  it('drops the paused run of the thread', async () => {
    const risky = tool({
      name: 'deploy',
      description: 'Deploys',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async () => 'deployed',
    });
    const { cog } = runtime(
      { one: [], deploy: [{ id: 'd', name: 'deploy', arguments: {} }] },
      { checkpoints: true }
    );
    const agent = coder({ tools: [risky] });
    await cog.run(agent, { input: 'one', threadId: 'paused' });
    const point = (await path(cog, 'paused')).at(-1)!;
    const paused = await cog.run(agent, { input: 'deploy', threadId: 'paused' });
    expect(paused.status).toBe('paused');

    const plan = await cog.rewind('paused', point.id, { agents: [agent], dryRun: true });
    expect(plan.runs.paused).toBe(true);
    const report = await cog.rewind('paused', point.id, { agents: [agent], files: true });
    expect(report.runs.paused).toBe(true);
    await expect(cog.resume(agent, 'paused')).rejects.toThrow();
  });

  it('drops the durable run a stopped process left in the thread', async () => {
    const started = deferred();
    const hang = tool({
      name: 'hang',
      description: 'Hangs',
      parameters: z.object({}),
      execute: () => {
        started.resolve();
        return new Promise<string>(() => undefined);
      },
    });
    const sqlite: CogitatorConfig['memory'] = {
      adapter: 'sqlite',
      sqlite: { path: join(base, 'memory.db') },
    };
    const plan = { one: [], go: [{ id: 'h', name: 'hang', arguments: {} }] };
    const first = runtime(
      plan,
      { checkpoints: true, durable: { owner: 'a', leaseMs: 60_000 } },
      sqlite
    );
    const agent = coder({ tools: [hang] });
    await first.cog.run(agent, { input: 'one', threadId: 'crash' });
    const point = (await path(first.cog, 'crash')).at(-1)!;
    first.cog.run(agent, { input: 'go', threadId: 'crash' }).catch(() => undefined);
    await started.promise;
    await first.cog.close();

    const second = runtime(plan, { checkpoints: true, durable: { owner: 'b' } }, sqlite);
    const held = await second.cog
      .rewind('crash', point.id, { agents: [agent] })
      .catch((error: unknown) => error);
    expect((held as CogitatorError).code).toBe(ErrorCode.THREAD_BUSY);
    const past = Date.now() + 120_000;
    vi.spyOn(Date, 'now').mockReturnValue(past);
    const kept = await second.cog.durableRuns();
    expect(kept).toHaveLength(1);
    const report = await second.cog.rewind('crash', point.id, { agents: [agent], files: true });
    expect(report.runs.durable).toEqual([kept[0]!.runId]);
    expect(await second.cog.durableRuns()).toEqual([]);
  });

  it('forks with the files into another workspace, which later rewinds of the fork restore', async () => {
    const { cog } = runtime(editPlan, { checkpoints: true });
    const agent = coder();
    const entries = await threeTurns(cog, agent);
    const forkRoot = join(base, 'fork');
    const forkWorkspace = new LocalWorkspace({ root: forkRoot, id: 'fork-ws' });
    try {
      const forked = await cog.forkThread('chat', turnEnd(entries, 'two').id, {
        files: true,
        workspace: forkWorkspace,
        source: workspace,
        newThreadId: 'chat-fork',
      });
      expect(forked.thread.id).toBe('chat-fork');
      expect(forked.snapshotsCopied).toHaveLength(3);
      expect(forked.snapshotsCopied.at(-1)).toBe(
        fileCheckpointOf(userEntries(entries)[2]!.metadata)?.snapshotId
      );
      expect(forked.files).toMatchObject({ exact: true, workspaceId: 'fork-ws' });
      expect(text('app.ts', forkRoot)).toBe('v2');
      expect(text('extra.ts', forkRoot)).toBe('extra');
      expect(text('app.ts')).toBe('v3');

      const forkPath = await path(cog, 'chat-fork');
      expect(userEntries(forkPath).every((entry) => fileCheckpointOf(entry.metadata))).toBe(true);
      await cog.rewind('chat-fork', turnEnd(forkPath, 'one').id, {
        files: true,
        workspace: forkWorkspace,
        agents: [agent],
      });
      expect(text('app.ts', forkRoot)).toBe('v1');
      expect(existsSync(join(forkRoot, 'extra.ts'))).toBe(false);
      expect(text('app.ts')).toBe('v3');
    } finally {
      await forkWorkspace.dispose();
    }
  });

  it('forks in place, restoring the same workspace, and forks without files', async () => {
    const { cog } = runtime(editPlan, { checkpoints: true });
    const agent = coder();
    const entries = await threeTurns(cog, agent);
    const plain = await cog.forkThread('chat', turnEnd(entries, 'one').id);
    expect(plain.files).toBeUndefined();
    expect(text('app.ts')).toBe('v3');
    const inPlace = await cog.forkThread('chat', turnEnd(entries, 'one').id, {
      files: true,
      agents: [agent],
    });
    expect(inPlace.snapshotsCopied).toEqual([]);
    expect(text('app.ts')).toBe('v1');
    await expect(cog.forkThread('chat', 'entry_nope')).rejects.toThrow(/not in thread/);
  });
});

describe('checkpointAt', () => {
  const entry = (
    id: string,
    role: 'user' | 'assistant' | 'tool' | 'system',
    snapshot?: string,
    type: MemoryEntry['type'] = 'message'
  ): MemoryEntry => ({
    id,
    threadId: 't',
    message: { role, content: id },
    tokenCount: 1,
    createdAt: new Date(),
    type,
    ...(snapshot && {
      metadata: { [FILE_CHECKPOINT_KEY]: { snapshotId: snapshot, workspaceId: 'w', root: '/r' } },
    }),
  });

  it('takes the next user message when only notes and events lie between', () => {
    const branch = [
      entry('u1', 'user', 's1'),
      entry('a1', 'assistant'),
      entry('ev', 'system', undefined, 'model_change'),
      entry('u2', 'user', 's2'),
      entry('n2', 'system'),
      entry('a2', 'assistant'),
    ];
    expect(checkpointAt(branch, 1)).toMatchObject({ entryId: 'u2', exact: true });
    expect(checkpointAt(branch, 3)).toMatchObject({ entryId: 'u2', exact: true });
    expect(checkpointAt(branch, 4)).toMatchObject({ entryId: 'u2', exact: true });
    expect(checkpointAt(branch, 5)).toMatchObject({ entryId: 'u2', exact: false });
    expect(checkpointAt(branch, 0)).toMatchObject({ entryId: 'u1', exact: true });
  });

  it('falls back to an earlier checkpoint, and to none', () => {
    const branch = [
      entry('u1', 'user', 's1'),
      entry('a1', 'assistant'),
      entry('u2', 'user'),
      entry('a2', 'assistant'),
    ];
    expect(checkpointAt(branch, 1)).toMatchObject({ entryId: 'u1', exact: false });
    expect(checkpointAt(branch, 3)).toMatchObject({ entryId: 'u1', exact: false });
    expect(checkpointAt([entry('a', 'assistant')], 0)).toBeUndefined();
  });

  it('takes the checkpoint a forked point names of the files at it, as exact as a message after it', () => {
    const at = { snapshotId: 's2', workspaceId: 'w', root: '/r', entryId: 'source-u2' };
    const point: MemoryEntry = {
      ...entry('a1', 'assistant'),
      metadata: { [FILE_CHECKPOINT_AT_KEY]: at, forkOf: 'source-a1' },
    };
    const branch = [entry('u1', 'user', 's1'), point, entry('ev', 'system', undefined, 'label')];
    const expected = {
      entryId: 'source-u2',
      checkpoint: { snapshotId: 's2', workspaceId: 'w', root: '/r' },
    };
    expect(checkpointAt(branch, 1)).toEqual({ ...expected, exact: true });
    expect(checkpointAt(branch, 2, branch)).toEqual({ ...expected, exact: true });
    const later = [...branch, entry('a2', 'assistant')];
    expect(checkpointAt(later, 3)).toEqual({ ...expected, exact: false });
    expect(checkpointsOn(branch).map((checkpoint) => checkpoint.snapshotId)).toEqual(['s1', 's2']);
  });
});
