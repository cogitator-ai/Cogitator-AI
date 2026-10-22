import { describe, it, expect } from 'vitest';
import type { CheckpointStore, WorkflowCheckpoint } from '@cogitator-ai/types';
import { checkpointNotFound, findOwnedCheckpoint, ownedCheckpoints } from '../index';

class MemoryStore implements CheckpointStore {
  readonly checkpoints = new Map<string, WorkflowCheckpoint>();

  save(checkpoint: WorkflowCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, checkpoint);
    return Promise.resolve();
  }

  load(id: string): Promise<WorkflowCheckpoint | null> {
    return Promise.resolve(this.checkpoints.get(id) ?? null);
  }

  list(workflowName: string): Promise<WorkflowCheckpoint[]> {
    return Promise.resolve(
      [...this.checkpoints.values()].filter(
        (checkpoint) => checkpoint.workflowName === workflowName
      )
    );
  }

  delete(id: string): Promise<void> {
    this.checkpoints.delete(id);
    return Promise.resolve();
  }
}

function checkpoint(id: string, extra: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    id,
    workflowId: 'wf_1',
    workflowName: 'flow',
    state: {},
    completedNodes: ['a'],
    nodeResults: { a: 1 },
    timestamp: 1,
    ...extra,
  };
}

describe('ownedCheckpoints', () => {
  it('saves a checkpoint as the owner, over any owner it carried', async () => {
    const store = new MemoryStore();
    await ownedCheckpoints(store, 'alice').save(checkpoint('cp_1', { owner: 'mallory' }));
    expect(store.checkpoints.get('cp_1')?.owner).toBe('alice');
  });

  it('saves a checkpoint of an anonymous caller without an owner key', async () => {
    const store = new MemoryStore();
    await ownedCheckpoints(store, undefined).save(checkpoint('cp_1', { owner: 'alice' }));
    expect(store.checkpoints.get('cp_1')).not.toHaveProperty('owner');
  });

  it('loads only the checkpoints of the owner', async () => {
    const store = new MemoryStore();
    await ownedCheckpoints(store, 'alice').save(checkpoint('cp_alice'));
    await ownedCheckpoints(store, undefined).save(checkpoint('cp_anonymous'));

    expect(await ownedCheckpoints(store, 'alice').load('cp_alice')).toMatchObject({
      id: 'cp_alice',
      owner: 'alice',
    });
    expect(await ownedCheckpoints(store, 'bob').load('cp_alice')).toBeNull();
    expect(await ownedCheckpoints(store, undefined).load('cp_alice')).toBeNull();
    expect(await ownedCheckpoints(store, 'alice').load('cp_anonymous')).toBeNull();
    expect(await ownedCheckpoints(store, undefined).load('cp_anonymous')).toMatchObject({
      id: 'cp_anonymous',
    });
    expect(await ownedCheckpoints(store, 'alice').load('cp_missing')).toBeNull();
  });

  it('lists only the checkpoints of the owner', async () => {
    const store = new MemoryStore();
    await ownedCheckpoints(store, 'alice').save(checkpoint('cp_1'));
    await ownedCheckpoints(store, 'bob').save(checkpoint('cp_2'));
    await ownedCheckpoints(store, undefined).save(checkpoint('cp_3'));

    const ids = async (owner: string | undefined) =>
      (await ownedCheckpoints(store, owner).list('flow')).map(({ id }) => id);
    expect(await ids('alice')).toEqual(['cp_1']);
    expect(await ids('bob')).toEqual(['cp_2']);
    expect(await ids(undefined)).toEqual(['cp_3']);
  });

  it('deletes only a checkpoint of the owner', async () => {
    const store = new MemoryStore();
    await ownedCheckpoints(store, 'alice').save(checkpoint('cp_1'));

    await ownedCheckpoints(store, 'bob').delete('cp_1');
    await ownedCheckpoints(store, undefined).delete('cp_1');
    expect(store.checkpoints.has('cp_1')).toBe(true);

    await ownedCheckpoints(store, 'alice').delete('cp_1');
    expect(store.checkpoints.has('cp_1')).toBe(false);
  });
});

describe('findOwnedCheckpoint', () => {
  it('finds a checkpoint of the workflow that belongs to the caller', async () => {
    const store = new MemoryStore();
    await ownedCheckpoints(store, 'alice').save(checkpoint('cp_1'));
    expect(await findOwnedCheckpoint(store, 'alice', 'flow', 'cp_1')).toMatchObject({
      id: 'cp_1',
    });
  });

  it('finds nothing without a store, for another user or another workflow', async () => {
    const store = new MemoryStore();
    await ownedCheckpoints(store, 'alice').save(checkpoint('cp_1'));
    expect(await findOwnedCheckpoint(undefined, 'alice', 'flow', 'cp_1')).toBeUndefined();
    expect(await findOwnedCheckpoint(store, 'bob', 'flow', 'cp_1')).toBeUndefined();
    expect(await findOwnedCheckpoint(store, 'alice', 'other', 'cp_1')).toBeUndefined();
    expect(await findOwnedCheckpoint(store, 'alice', 'flow', 'cp_2')).toBeUndefined();
  });

  it('is refused with 404 CHECKPOINT_NOT_FOUND', () => {
    expect(checkpointNotFound('cp_1')).toEqual({
      status: 404,
      code: 'CHECKPOINT_NOT_FOUND',
      message: "Checkpoint 'cp_1' not found",
    });
  });
});
