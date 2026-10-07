import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InMemoryCheckpointStore } from '@cogitator-ai/core';
import type { ExecutionCheckpoint } from '@cogitator-ai/types';

type CheckpointStoreClass = typeof InMemoryCheckpointStore;

function revive(raw: string): ExecutionCheckpoint {
  const parsed = JSON.parse(raw) as ExecutionCheckpoint & { createdAt: string };
  return { ...parsed, createdAt: new Date(parsed.createdAt) };
}

/**
 * A time-travel checkpoint store that keeps every checkpoint as a JSON file in
 * `directory`, so the runs of earlier studio sessions can still be forked.
 * It extends the in-memory store of the project's @cogitator-ai/core, which
 * keeps the indexes and the queries.
 */
export async function openCheckpointStore(
  Base: CheckpointStoreClass,
  directory: string
): Promise<InMemoryCheckpointStore> {
  mkdirSync(directory, { recursive: true });
  const fileOf = (id: string) => join(directory, `${id.replace(/[^\w-]/g, '_')}.json`);

  class FileTimeTravelStore extends Base {
    override async save(checkpoint: ExecutionCheckpoint): Promise<void> {
      await super.save(checkpoint);
      writeFileSync(fileOf(checkpoint.id), JSON.stringify(checkpoint));
    }

    override async delete(id: string): Promise<boolean> {
      const deleted = await super.delete(id);
      rmSync(fileOf(id), { force: true });
      return deleted;
    }

    async restore(checkpoint: ExecutionCheckpoint): Promise<void> {
      await super.save(checkpoint);
    }
  }

  const store = new FileTimeTravelStore();
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    if (!name.endsWith('.json')) continue;
    try {
      await store.restore(revive(readFileSync(join(directory, name), 'utf-8')));
    } catch {
      rmSync(join(directory, name), { force: true });
    }
  }
  return store;
}
