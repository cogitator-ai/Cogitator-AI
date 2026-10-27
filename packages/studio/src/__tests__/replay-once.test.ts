import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import type { MemoryEntry, NewMemoryEntry } from '@cogitator-ai/types';
import type { HostEvent, ThreadReplay } from '../protocol.js';
import { StudioHost } from '../host/runner.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('studio replay after a restart', () => {
  it('lets chats asked for together wait for one whole replay of their thread', async () => {
    const studioDir = mkdtempSync(join(tmpdir(), 'studio-replay-'));
    dirs.push(studioDir);
    const ended = new Set<string>();
    const host = await StudioHost.create(FIXTURE, studioDir, (event: HostEvent) => {
      if (event.type === 'run.completed' || event.type === 'run.failed') ended.add(event.runId);
    });
    let memory: InMemoryAdapter | undefined;
    const add = InMemoryAdapter.prototype.addEntry;
    vi.spyOn(InMemoryAdapter.prototype, 'addEntry').mockImplementation(async function (
      this: InMemoryAdapter,
      entry: NewMemoryEntry
    ) {
      memory = this;
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
      const read = await memory!.getPath({ threadId: 'replayed' });
      if (!read.success) throw new Error(read.error);
      const said = read.data.map((entry: MemoryEntry) => entry.message.content);
      expect(said.slice(0, 2)).toEqual(['earlier', 'answered earlier']);
      expect(said).toContain('three');
      expect(said).toContain('four');
    } finally {
      await host.close();
    }
  }, 60_000);
});
