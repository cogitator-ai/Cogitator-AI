import { describe, expect, it } from 'vitest';
import { WorkflowBuilder } from '../builder';
import { InMemoryCheckpointStore } from '../checkpoint';
import { createWorkflowManager } from '../manager';
import { InMemoryDLQ } from '../saga';

interface State {
  fetched?: string;
  published?: string;
}

function flakyWorkflow(failures: { left: number }, calls: string[]) {
  return new WorkflowBuilder<State>('newsroom-publish')
    .initialState({})
    .addNode('fetch', async () => {
      calls.push('fetch');
      return { state: { fetched: 'story' } };
    })
    .addNode(
      'publish',
      async ({ state }) => {
        calls.push('publish');
        if (failures.left > 0) {
          failures.left--;
          throw new Error('CDN unreachable');
        }
        return { state: { published: `${state.fetched ?? '?'} online` } };
      },
      { after: ['fetch'] }
    )
    .build();
}

describe('WorkflowManager.retryDeadLetter', () => {
  it('runs the failed node again from its run, then drops the entry', async () => {
    const calls: string[] = [];
    const workflow = flakyWorkflow({ left: 1 }, calls);
    const dlq = new InMemoryDLQ();
    const manager = createWorkflowManager({
      cogitator: {} as never,
      checkpointStore: new InMemoryCheckpointStore(),
    });

    const failed = await manager.execute(workflow, undefined, { deadLetterQueue: dlq });
    expect(failed.error?.message).toContain('CDN unreachable');
    const [entry] = await dlq.list();
    expect(entry).toMatchObject({ nodeId: 'publish', workflowName: 'newsroom-publish' });

    calls.length = 0;
    const retried = await manager.retryDeadLetter<State>(dlq, entry!.id);

    expect(retried.error).toBeUndefined();
    expect(retried.state.published).toBe('story online');
    expect(calls).toEqual(['publish']);
    expect(await dlq.count()).toBe(0);
  });

  it('keeps an entry that fails again, with the attempt recorded', async () => {
    const workflow = flakyWorkflow({ left: 5 }, []);
    const dlq = new InMemoryDLQ();
    const manager = createWorkflowManager({
      cogitator: {} as never,
      checkpointStore: new InMemoryCheckpointStore(),
    });
    await manager.execute(workflow, undefined, { deadLetterQueue: dlq });
    const [entry] = await dlq.list();
    const attempts = entry!.attempts;

    const retried = await manager.retryDeadLetter(dlq, entry!.id);

    expect(retried.error?.message).toContain('CDN unreachable');
    expect((await dlq.get(entry!.id))?.attempts).toBe(attempts + 1);
  });

  it('runs the workflow again from its input when the first node failed', async () => {
    let left = 1;
    const workflow = new WorkflowBuilder<{ done?: boolean }>('first-node')
      .initialState({})
      .addNode('only', async () => {
        if (left-- > 0) throw new Error('boom');
        return { state: { done: true } };
      })
      .build();
    const dlq = new InMemoryDLQ();
    const manager = createWorkflowManager({
      cogitator: {} as never,
      checkpointStore: new InMemoryCheckpointStore(),
    });
    await manager.execute(workflow, undefined, { deadLetterQueue: dlq });
    const [entry] = await dlq.list();

    const retried = await manager.retryDeadLetter<{ done?: boolean }>(dlq, entry!.id);

    expect(retried.state.done).toBe(true);
    expect(await dlq.count()).toBe(0);
  });

  it('needs checkpoints to retry', async () => {
    const workflow = flakyWorkflow({ left: 1 }, []);
    const dlq = new InMemoryDLQ();
    const manager = createWorkflowManager({ cogitator: {} as never });
    await manager.execute(workflow, undefined, { deadLetterQueue: dlq });
    const [entry] = await dlq.list();

    await expect(manager.retryDeadLetter(dlq, entry!.id)).rejects.toThrow(
      'needs a manager with a checkpointStore'
    );
  });

  it('refuses entries it cannot run', async () => {
    const dlq = new InMemoryDLQ();
    const manager = createWorkflowManager({ cogitator: {} as never });
    await expect(manager.retryDeadLetter(dlq, 'missing')).rejects.toThrow(
      'Dead letter entry not found'
    );

    const id = await dlq.add({
      id: '',
      workflowId: 'w1',
      workflowName: 'unknown-workflow',
      nodeId: 'n',
      error: { message: 'x', name: 'Error' },
      state: {},
      attempts: 1,
      maxAttempts: 1,
      lastAttempt: 0,
      createdAt: 0,
    });
    await expect(manager.retryDeadLetter(dlq, id)).rejects.toThrow(
      'Register it with registerWorkflow()'
    );
  });
});
