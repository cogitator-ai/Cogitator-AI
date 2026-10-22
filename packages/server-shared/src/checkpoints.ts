import { ErrorCode } from '@cogitator-ai/types';
import type { CheckpointStore, WorkflowCheckpoint } from '@cogitator-ai/types';
import type { HttpErrorDescription } from './contract.js';

function withOwner(checkpoint: WorkflowCheckpoint, owner: string | undefined): WorkflowCheckpoint {
  const { owner: _previous, ...rest } = checkpoint;
  return owner === undefined ? rest : { ...rest, owner };
}

/**
 * The checkpoints of one user in a store that servers share between users: what is saved
 * through it belongs to `owner`, and only checkpoints of `owner` can be loaded, listed or
 * deleted through it. A caller without a user id (`owner` undefined) owns only the checkpoints
 * saved without one, so an anonymous caller never reaches a checkpoint of a signed-in user and
 * a signed-in user never reaches an anonymous one.
 *
 * @example
 * ```ts
 * const executor = new WorkflowExecutor(cogitator, ownedCheckpoints(store, auth?.userId));
 * ```
 */
export function ownedCheckpoints(
  store: CheckpointStore,
  owner: string | undefined
): CheckpointStore {
  const owned = (checkpoint: WorkflowCheckpoint | null): WorkflowCheckpoint | null =>
    checkpoint && checkpoint.owner === owner ? checkpoint : null;

  return {
    save: (checkpoint) => store.save(withOwner(checkpoint, owner)),
    load: async (id) => owned(await store.load(id)),
    list: async (workflowName) =>
      (await store.list(workflowName)).filter((checkpoint) => checkpoint.owner === owner),
    delete: async (id) => {
      if (owned(await store.load(id))) await store.delete(id);
    },
  };
}

/**
 * The checkpoint a workflow resume names, when it is one of `workflowName` that belongs to
 * `owner`; `undefined` when the server keeps no store, the checkpoint is missing, belongs to
 * another user or to another workflow. Servers answer all of those the same way, with
 * {@link checkpointNotFound}, so a client cannot tell a checkpoint of another user from one
 * that does not exist.
 */
export async function findOwnedCheckpoint(
  store: CheckpointStore | undefined,
  owner: string | undefined,
  workflowName: string,
  checkpointId: string
): Promise<WorkflowCheckpoint | undefined> {
  if (!store) return undefined;
  const checkpoint = await ownedCheckpoints(store, owner).load(checkpointId);
  return checkpoint?.workflowName === workflowName ? checkpoint : undefined;
}

/** The refusal of a workflow resume whose checkpoint {@link findOwnedCheckpoint} did not find */
export function checkpointNotFound(checkpointId: string): HttpErrorDescription {
  return {
    status: 404,
    code: ErrorCode.CHECKPOINT_NOT_FOUND,
    message: `Checkpoint '${checkpointId}' not found`,
  };
}
