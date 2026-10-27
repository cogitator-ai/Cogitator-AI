import { describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { CogitatorError, ErrorCode, FILE_CHECKPOINT_KEY } from '@cogitator-ai/types';
import { RunMemory, type TakenCheckpoint } from '../cogitator/run-memory';
import { deferred } from './helpers/scripted-backend';

async function setup() {
  const memory = new InMemoryAdapter();
  await memory.connect();
  const run = new RunMemory(
    () => memory,
    't',
    () => ({ input: 'hi' })
  );
  run.open();
  const discard = vi.fn(async () => undefined);
  const taking = deferred();
  const taken = deferred();
  run.checkpoints(async (entryId): Promise<TakenCheckpoint> => {
    taking.resolve();
    await taken.promise;
    return { ref: { snapshotId: `snap-${entryId}`, workspaceId: 'w', root: '/w' }, discard };
  });
  const entries = async () => {
    const read = await memory.getEntries({ threadId: 't' });
    if (!read.success) throw new Error(read.error);
    return read.data;
  };
  return { run, discard, taking, taken, entries };
}

const leased = () =>
  new CogitatorError({ message: 'Another process took the run over', code: ErrorCode.RUN_LEASED });

describe('RunMemory guards', () => {
  it('writes nothing, and drops the checkpoint, when the run is sealed while the checkpoint is taken', async () => {
    const { run, discard, taking, taken, entries } = await setup();
    const write = run.saveUser('agent', { role: 'user', content: 'hello' });
    await taking.promise;
    run.seal();
    taken.resolve();
    await write;
    expect(await entries()).toEqual([]);
    expect(discard).toHaveBeenCalledOnce();
  });

  it('fails the write, and drops the checkpoint, when the lease is lost while the checkpoint is taken', async () => {
    const { run, discard, taking, taken, entries } = await setup();
    let lost = false;
    run.guard(async () => {
      if (lost) throw leased();
    });
    const write = run.saveUser('agent', { role: 'user', content: 'hello' });
    await taking.promise;
    lost = true;
    taken.resolve();
    await expect(write).rejects.toMatchObject({ code: ErrorCode.RUN_LEASED });
    expect(await entries()).toEqual([]);
    expect(discard).toHaveBeenCalledOnce();
  });

  it('asks the guard right before an entry is added, and keeps the checkpoint of an entry written', async () => {
    const { run, discard, taken, entries } = await setup();
    const asked = vi.fn(async () => undefined);
    run.guard(asked);
    taken.resolve();
    await run.saveUser('agent', { role: 'user', content: 'hello' });
    await run.save('agent', { role: 'assistant', content: 'hi' });
    const written = await entries();
    expect(written.map((entry) => entry.message.content)).toEqual(['hello', 'hi']);
    expect(written[0]?.metadata?.[FILE_CHECKPOINT_KEY]).toMatchObject({ workspaceId: 'w' });
    expect(asked).toHaveBeenCalledTimes(3);
    expect(discard).not.toHaveBeenCalled();
  });
});
