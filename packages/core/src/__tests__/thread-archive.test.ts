import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CogitatorError, ErrorCode, type MemoryAdapter } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { answer, callTools, deferred, scriptedBackend } from './helpers/scripted-backend';

const agent = new Agent({ name: 'helper', model: 'mock/m', instructions: 'Help.' });

async function memoryOf(cog: Cogitator): Promise<MemoryAdapter> {
  const memory = await cog.getMemory();
  if (!memory) throw new Error('no memory');
  return memory;
}

async function withThreads(count: number) {
  const scripted = scriptedBackend([answer('ok')]);
  const cog = new Cogitator({
    memory: { adapter: 'memory' },
    llm: { backends: { mock: scripted.backend } },
  });
  const memory = await memoryOf(cog);
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = `thread_${index}`;
    const created = await memory.createThread('helper', {}, id);
    if (!created.success) throw new Error(created.error);
    ids.push(id);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return { cog, ids };
}

describe('archived threads', () => {
  it('archives and unarchives a thread through its metadata', async () => {
    const { cog, ids } = await withThreads(1);
    const id = ids[0] ?? '';
    const archived = await cog.archiveThread(id);
    expect(archived.metadata.archived).toBe(true);
    expect(typeof archived.metadata.archivedAt).toBe('string');
    expect(Number.isNaN(Date.parse(String(archived.metadata.archivedAt)))).toBe(false);

    const again = await cog.archiveThread(id);
    expect(again.metadata.archivedAt).toBe(archived.metadata.archivedAt);

    const restored = await cog.unarchiveThread(id);
    expect(restored.metadata).toMatchObject({ archived: false, archivedAt: null });
    await cog.close();
  });

  it('lists threads by archive state', async () => {
    const { cog, ids } = await withThreads(3);
    await cog.archiveThread(ids[1] ?? '');
    const all = await cog.listThreads();
    expect(all.threads.map((thread) => thread.id).sort()).toEqual([...ids].sort());
    const archived = await cog.listThreads({ archived: true });
    expect(archived.threads.map((thread) => thread.id)).toEqual([ids[1]]);
    const active = await cog.listThreads({ archived: false });
    expect(active.threads.map((thread) => thread.id).sort()).toEqual([ids[0], ids[2]].sort());
    await cog.unarchiveThread(ids[1] ?? '');
    expect((await cog.listThreads({ archived: false })).threads).toHaveLength(3);
    await cog.close();
  });

  it('reads on past adapter pages holding archived threads only', async () => {
    const { cog, ids } = await withThreads(5);
    for (const id of ids.slice(2)) await cog.archiveThread(id);
    const memory = await memoryOf(cog);
    const listing = vi.spyOn(memory, 'listThreads');

    const first = await cog.listThreads({ archived: false, limit: 1 });
    expect(first.threads.map((thread) => thread.id)).toEqual([ids[1]]);
    expect(listing.mock.calls.length).toBeGreaterThan(1);
    expect(first.nextCursor).toBeDefined();

    const second = await cog.listThreads({ archived: false, limit: 1, cursor: first.nextCursor });
    expect(second.threads.map((thread) => thread.id)).toEqual([ids[0]]);

    const last = second.nextCursor
      ? await cog.listThreads({ archived: false, limit: 1, cursor: second.nextCursor })
      : { threads: [] };
    expect(last.threads).toEqual([]);
    expect('nextCursor' in last ? last.nextCursor : undefined).toBeUndefined();
    await cog.close();
  });

  it('refuses to archive a thread while a run goes on in it', async () => {
    const started = deferred();
    const release = deferred();
    const wait = tool({
      name: 'wait',
      description: 'Waits',
      parameters: z.object({}),
      execute: async () => {
        started.resolve();
        await release.promise;
        return 'waited';
      },
    });
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'wait', arguments: {} }]),
      answer('done'),
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: scripted.backend } },
    });
    const worker = new Agent({
      name: 'worker',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [wait],
    });
    const running = cog.run(worker, { input: 'go', threadId: 't-busy' });
    await started.promise;

    const refused = await cog.archiveThread('t-busy').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CogitatorError);
    expect((refused as CogitatorError).code).toBe(ErrorCode.THREAD_BUSY);
    await expect(cog.unarchiveThread('t-busy')).rejects.toMatchObject({
      code: ErrorCode.THREAD_BUSY,
    });

    release.resolve();
    await running;
    const archived = await cog.archiveThread('t-busy');
    expect(archived.metadata.archived).toBe(true);
    await cog.close();
  });

  it('refuses a thread that does not exist, and runs without memory', async () => {
    const { cog } = await withThreads(0);
    await expect(cog.archiveThread('nope')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    await cog.close();

    const bare = new Cogitator({ llm: { backends: { mock: scriptedBackend([]).backend } } });
    await expect(bare.listThreads()).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    await expect(bare.archiveThread('t')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    await bare.close();
  });

  it('keeps an archived thread usable for runs', async () => {
    const { cog } = await withThreads(0);
    await cog.run(agent, { input: 'hi', threadId: 't-archived' });
    await cog.archiveThread('t-archived');
    const result = await cog.run(agent, { input: 'again', threadId: 't-archived' });
    expect(result.output).toBe('ok');
    await cog.close();
  });
});
