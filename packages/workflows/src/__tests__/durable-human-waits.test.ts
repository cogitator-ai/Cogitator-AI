import type { ApprovalRequest, WorkflowRun } from '@cogitator-ai/types';
import { describe, expect, it } from 'vitest';
import { WorkflowBuilder } from '../builder';
import { InMemoryCheckpointStore } from '../checkpoint';
import { InMemoryApprovalStore, approvalNode } from '../human';
import { InMemoryRunStore, createWorkflowManager } from '../manager';
import { humanWorkflowNode } from '../nodes/adapters';

interface EditionState {
  draft?: string;
  approved?: boolean;
  note?: string;
  round?: number;
  published?: string;
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pending = (store: InMemoryApprovalStore) => async (): Promise<ApprovalRequest | undefined> =>
  (await store.getPendingRequests())[0];

describe('human waits that survive a restart', () => {
  it('lets another process pick up the run and the same open request', async () => {
    const published: string[] = [];
    const workflow = new WorkflowBuilder<EditionState>('edition')
      .initialState({})
      .addNode('draft', async () => ({ state: { draft: 'Bridge strike leads' } }))
      .addNode(
        'editor',
        humanWorkflowNode<EditionState>(approvalNode('editor', { title: 'Approve the edition' }), {
          stateMapper: (result) => ({ approved: result.approved }),
        }),
        { after: ['draft'] }
      )
      .addNode(
        'publish',
        async ({ state }) => {
          published.push(state.draft ?? '?');
          return { state: { published: state.draft } };
        },
        { after: ['editor'] }
      )
      .build();

    const runStore = new InMemoryRunStore();
    const checkpointStore = new InMemoryCheckpointStore();

    const before = new InMemoryApprovalStore();
    const crashed = createWorkflowManager({ cogitator: {} as never, runStore, checkpointStore });
    void crashed.execute(workflow, undefined, { approvalStore: before });
    const asked = await until(pending(before));

    const durable = new InMemoryApprovalStore();
    await durable.createRequest(asked);

    const restarted = createWorkflowManager({ cogitator: {} as never, runStore, checkpointStore });
    restarted.registerWorkflow(workflow);
    const finished = new Promise<WorkflowRun>((resolve) => {
      restarted.onRunStateChange((run) => {
        if (run.status === 'completed') resolve(run);
      });
    });

    const recovered = await restarted.recoverRuns({ approvalStore: durable });
    expect(recovered.resumed).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const open = await durable.getPendingRequests();
    expect(open.map((r) => r.id)).toEqual([asked.id]);

    await durable.submitResponse({
      requestId: asked.id,
      decision: true,
      respondedBy: 'editor',
      respondedAt: Date.now(),
    });
    const run = await finished;

    expect(run.state).toMatchObject({ approved: true, published: 'Bridge strike leads' });
    expect(published).toEqual(['Bridge strike leads']);
  });

  it('asks again in every round of a rewrite loop instead of reusing the last answer', async () => {
    const workflow = new WorkflowBuilder<EditionState>('rewrite-loop')
      .initialState({ round: 0 })
      .addNode('write', async ({ state }) => ({
        state: { draft: `draft ${(state.round ?? 0) + 1}`, round: (state.round ?? 0) + 1 },
      }))
      .addNode(
        'editor',
        humanWorkflowNode<EditionState>(
          approvalNode('editor', { title: 'Approve the draft', description: (s) => s.draft ?? '' }),
          { stateMapper: (result) => ({ approved: result.approved }) }
        ),
        { after: ['write'] }
      )
      .addLoop('again', {
        condition: (state) => state.approved !== true,
        back: 'write',
        exit: 'done',
        after: ['editor'],
      })
      .addNode('done', async () => ({}))
      .build();

    const store = new InMemoryApprovalStore();
    const manager = createWorkflowManager({ cogitator: {} as never });
    const result = manager.execute(workflow, undefined, { approvalStore: store });

    const first = await until(pending(store));
    await store.submitResponse({
      requestId: first.id,
      decision: false,
      respondedBy: 'editor',
      respondedAt: Date.now(),
    });
    const second = await until(async () => {
      const [request] = await store.getPendingRequests();
      return request && request.id !== first.id ? request : undefined;
    });
    expect(second.description).toBe('draft 2');
    await store.submitResponse({
      requestId: second.id,
      decision: true,
      respondedBy: 'editor',
      respondedAt: Date.now(),
    });

    const done = await result;
    expect(done.state).toMatchObject({ round: 2, approved: true });
  });
});
