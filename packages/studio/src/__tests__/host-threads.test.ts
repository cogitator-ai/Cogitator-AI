import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { FILE_CHECKPOINT_KEY, type MemoryEntry, type NewMemoryEntry } from '@cogitator-ai/types';
import type { HostEvent, ThreadReplay, ThreadTree } from '../protocol.js';
import { StudioHost } from '../host/runner.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('studio host threads', () => {
  it('lets chats asked for together wait for one whole replay of their thread', async () => {
    const studioDir = mkdtempSync(join(tmpdir(), 'studio-replay-'));
    dirs.push(studioDir);
    const ended = new Set<string>();
    const host = await StudioHost.create(FIXTURE, studioDir, (event: HostEvent) => {
      if (event.type === 'run.completed' || event.type === 'run.failed') ended.add(event.runId);
    });
    const used = new Set<InMemoryAdapter>();
    const add = InMemoryAdapter.prototype.addEntry;
    vi.spyOn(InMemoryAdapter.prototype, 'addEntry').mockImplementation(async function (
      this: InMemoryAdapter,
      entry: NewMemoryEntry
    ) {
      used.add(this);
      if (entry.activate === false) await new Promise((resolve) => setTimeout(resolve, 50));
      return add.call(this, entry);
    });
    const replay: ThreadReplay = {
      metadata: {},
      entries: [
        { id: 'entry_old_user', parentId: null, message: { role: 'user', content: 'earlier' } },
        {
          id: 'entry_old_answer',
          parentId: 'entry_old_user',
          message: { role: 'assistant', content: 'answered earlier' },
        },
      ],
      activeLeafId: 'entry_old_answer',
    };
    const ask = (input: string, requestId: string) =>
      host.handle({
        type: 'chat',
        requestId,
        agent: 'assistant',
        input,
        threadId: 'replayed',
        history: [],
        replay,
      }) as Promise<{ runId: string }>;
    try {
      const runs = await Promise.all([ask('three', 'r1'), ask('four', 'r2')]);
      await vi.waitFor(() => expect(runs.every((run) => ended.has(run.runId))).toBe(true), {
        timeout: 20_000,
      });
      const memory = [...used].at(-1)!;
      const read = await memory.getPath({ threadId: 'replayed' });
      if (!read.success) throw new Error(read.error);
      const said = read.data.map((entry: MemoryEntry) => entry.message.content);
      expect(said.slice(0, 2)).toEqual(['earlier', 'answered earlier']);
      expect(said).toContain('three');
      expect(said).toContain('four');
    } finally {
      await host.close();
    }
  }, 60_000);

  it('offers the files of an entry whenever the runtime can restore them there', async () => {
    const studioDir = mkdtempSync(join(tmpdir(), 'studio-files-'));
    dirs.push(studioDir);
    const host = await StudioHost.create(FIXTURE, studioDir, () => undefined);
    const checkpoint = { snapshotId: 'snap_a_12345678', workspaceId: 'w', root: '/w' };
    const replay: ThreadReplay = {
      metadata: {},
      entries: [
        { id: 'entry_first', parentId: null, message: { role: 'user', content: 'before' } },
        {
          id: 'entry_answer',
          parentId: 'entry_first',
          message: { role: 'assistant', content: 'answered before' },
        },
        {
          id: 'entry_later',
          parentId: 'entry_answer',
          message: { role: 'user', content: 'checkpoints on now' },
          metadata: { [FILE_CHECKPOINT_KEY]: checkpoint },
        },
        {
          id: 'entry_last',
          parentId: 'entry_later',
          message: { role: 'assistant', content: 'answered later' },
        },
      ],
      activeLeafId: 'entry_last',
    };
    try {
      const tree = (await host.handle({
        type: 'thread.tree',
        requestId: 't1',
        threadId: 'checkpointed',
        agent: 'assistant',
        history: [],
        replay,
      })) as ThreadTree;
      expect(tree.entries.map((entry) => [entry.id, entry.files])).toEqual([
        ['entry_first', undefined],
        ['entry_answer', 'exact'],
        ['entry_later', 'exact'],
        ['entry_last', 'before'],
      ]);
    } finally {
      await host.close();
    }
  }, 60_000);
});
