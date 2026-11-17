import { describe, it, expect } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import type { CheckpointStrategy, Workflow, WorkflowCheckpoint } from '@cogitator-ai/types';
import { WorkflowBuilder } from '../builder';
import { WorkflowExecutor } from '../executor';
import { InMemoryCheckpointStore } from '../checkpoint';
import { createWorkflowManager } from '../manager/workflow-manager';
import type { ExtendedNodeContext } from '../nodes/base';

const cogitator = {} as Cogitator;

const WORKFLOW_ID = 'wf-rounds';
const ROUNDS = 4;
const ROUND_NODES = ['draft', 'review', 'again'];
const FULL_RUN = [...Array.from({ length: ROUNDS }, () => ROUND_NODES).flat(), 'publish'];

type RoundsState = {
  round: number;
  drafts: number[];
  reviews: number[];
  published: number[];
};

interface Stop {
  node: 'draft' | 'review';
  round: number;
  how: 'throw' | 'abort';
}

interface NodeRun {
  node: string;
  round: number;
  key: string | undefined;
}

interface Rig {
  workflow: Workflow<RoundsState>;
  runs: NodeRun[];
  controller: AbortController;
  stopAt(stop: Stop): void;
}

function createRig(): Rig {
  const runs: NodeRun[] = [];
  const controller = new AbortController();
  let pendingStop: Stop | undefined;

  const enter = (node: string, round: number, key: string | undefined): void => {
    runs.push({ node, round, key });
    if (pendingStop?.node !== node || pendingStop.round !== round) return;
    const { how } = pendingStop;
    pendingStop = undefined;
    if (how === 'throw') throw new Error(`${node} stopped in round ${round}`);
    controller.abort();
  };

  const workflow = new WorkflowBuilder<RoundsState>('rounds')
    .initialState({ round: 0, drafts: [], reviews: [], published: [] })
    .addNode('draft', async (ctx) => {
      const round = ctx.state.round + 1;
      enter('draft', round, ctx.idempotencyKey);
      return { state: { round, drafts: [...ctx.state.drafts, round] }, output: `draft-${round}` };
    })
    .addNode(
      'review',
      async (ctx) => {
        const { round } = ctx.state;
        enter('review', round, ctx.idempotencyKey);
        return { state: { reviews: [...ctx.state.reviews, round] }, output: `review-${round}` };
      },
      { after: ['draft'] }
    )
    .addLoop('again', {
      condition: (state) => state.round < ROUNDS,
      back: 'draft',
      exit: 'publish',
      after: ['review'],
    })
    .addNode('publish', async (ctx) => {
      const { round } = ctx.state;
      enter('publish', round, ctx.idempotencyKey);
      return { state: { published: [...ctx.state.published, round] }, output: 'published' };
    })
    .build();

  return {
    workflow,
    runs,
    controller,
    stopAt: (stop) => {
      pendingStop = stop;
    },
  };
}

function visitKey(run: NodeRun): string {
  const visit = run.node === 'publish' ? 1 : run.round;
  return `workflow:${WORKFLOW_ID}:node:${run.node}:visit:${visit}`;
}

async function newestCheckpoint(store: InMemoryCheckpointStore): Promise<WorkflowCheckpoint> {
  const [newest] = await store.list('rounds');
  expect(newest).toBeDefined();
  return newest;
}

const stops: Stop[] = [
  { node: 'review', round: 1, how: 'throw' },
  { node: 'review', round: 1, how: 'abort' },
  { node: 'draft', round: 2, how: 'throw' },
  { node: 'draft', round: 2, how: 'abort' },
  { node: 'review', round: 2, how: 'throw' },
  { node: 'review', round: 2, how: 'abort' },
  { node: 'draft', round: 3, how: 'throw' },
  { node: 'draft', round: 3, how: 'abort' },
  { node: 'review', round: 3, how: 'throw' },
  { node: 'review', round: 3, how: 'abort' },
];

const strategies: CheckpointStrategy[] = ['per-node', 'per-iteration'];

describe.each(strategies)(
  'resuming a run that stopped inside a loop (%s checkpoints)',
  (strategy) => {
    it.each(stops)(
      'goes on from $node of round $round after a $how and reaches the exit node',
      async (stop) => {
        const rig = createRig();
        const store = new InMemoryCheckpointStore();
        const executor = new WorkflowExecutor(cogitator, store);
        const stoppedAt = (stop.round - 1) * ROUND_NODES.length + ROUND_NODES.indexOf(stop.node);

        const firstStarts: string[] = [];
        rig.stopAt(stop);
        const first = await executor.execute(
          rig.workflow,
          {},
          {
            workflowId: WORKFLOW_ID,
            checkpoint: true,
            checkpointStrategy: strategy,
            signal: rig.controller.signal,
            onNodeStart: (node) => firstStarts.push(node),
          }
        );

        expect(first.error).toBeDefined();
        expect(firstStarts).toEqual(FULL_RUN.slice(0, stoppedAt + 1));
        const firstRuns = [...rig.runs];
        rig.runs.length = 0;

        const checkpoint = await newestCheckpoint(store);
        expect(checkpoint.id).toBe(first.checkpointId);

        const resumedStarts: string[] = [];
        const resumed = await executor.resume(rig.workflow, checkpoint.id, {
          checkpoint: true,
          checkpointStrategy: strategy,
          onNodeStart: (node) => resumedStarts.push(node),
        });

        const rerunsStoppedNode = stop.how === 'throw';
        expect(resumed.error).toBeUndefined();
        expect(resumed.workflowId).toBe(WORKFLOW_ID);
        expect(resumedStarts).toEqual(
          FULL_RUN.slice(rerunsStoppedNode ? stoppedAt : stoppedAt + 1)
        );

        const everyRound = Array.from({ length: ROUNDS }, (_, index) => index + 1);
        expect(resumed.state).toEqual({
          round: ROUNDS,
          drafts: everyRound,
          reviews: everyRound,
          published: [ROUNDS],
        });
        expect(resumed.nodeResults.get('publish')?.output).toBe('published');

        for (const run of [...firstRuns, ...rig.runs]) {
          expect(run.key).toBe(visitKey(run));
        }
        if (rerunsStoppedNode) {
          expect(rig.runs[0]).toEqual(firstRuns.at(-1));
          expect(rig.runs[0].key).toBe(
            `workflow:${WORKFLOW_ID}:node:${stop.node}:visit:${stop.round}`
          );
        }

        const last = await store.load(resumed.checkpointId ?? '');
        expect(last?.nodeVisits).toEqual({
          draft: ROUNDS,
          review: ROUNDS,
          again: ROUNDS,
          publish: 1,
        });
      }
    );
  }
);

describe('resuming a step that several nodes share', () => {
  type FanState = {
    round: number;
    lefts: number[];
    rights: number[];
    merged: string[];
  };

  it('runs only the node that had not completed and holds the next step back for it', async () => {
    let failRight = true;
    const workflow = new WorkflowBuilder<FanState>('fan')
      .initialState({ round: 0, lefts: [], rights: [], merged: [] })
      .addNode('start', async (ctx) => ({ state: { round: ctx.state.round + 1 } }))
      .addNode(
        'left',
        async (ctx) => ({ state: { lefts: [...ctx.state.lefts, ctx.state.round] } }),
        { after: ['start'] }
      )
      .addNode(
        'right',
        async (ctx) => {
          if (failRight && ctx.state.round === 2) {
            failRight = false;
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error('right stopped');
          }
          return { state: { rights: [...ctx.state.rights, ctx.state.round] } };
        },
        { after: ['start'] }
      )
      .addNode(
        'merge',
        async (ctx) => ({
          state: {
            merged: [...ctx.state.merged, `${ctx.state.lefts.length}/${ctx.state.rights.length}`],
          },
        }),
        { after: ['left', 'right'] }
      )
      .addLoop('again', {
        condition: (state) => state.round < 3,
        back: 'start',
        exit: 'done',
        after: ['merge'],
      })
      .addNode('done', async () => ({ output: 'done' }))
      .build();

    const store = new InMemoryCheckpointStore();
    const executor = new WorkflowExecutor(cogitator, store);
    const first = await executor.execute(
      workflow,
      {},
      { checkpoint: true, checkpointStrategy: 'per-node' }
    );
    expect(first.error?.message).toBe('right stopped');

    const checkpoint = await store.load(first.checkpointId ?? '');
    expect(checkpoint?.frontier).toEqual({ current: ['right'], next: ['merge'] });

    const starts: string[] = [];
    const resumed = await executor.resume(workflow, first.checkpointId ?? '', {
      onNodeStart: (node) => starts.push(node),
    });

    expect(resumed.error).toBeUndefined();
    expect(starts).toEqual([
      'right',
      'merge',
      'again',
      'start',
      'left',
      'right',
      'merge',
      'again',
      'done',
    ]);
    expect(resumed.state).toEqual({
      round: 3,
      lefts: [1, 2, 3],
      rights: [1, 2, 3],
      merged: ['1/1', '2/2', '3/3'],
    });
  });
});

describe('resuming a cycle without an exit node', () => {
  it('does not take a run for finished because each of its nodes completed once', async () => {
    let failWork = true;
    const workflow = new WorkflowBuilder<{ round: number }>('cycle')
      .initialState({ round: 0 })
      .entryPoint('work')
      .addNode(
        'work',
        async (ctx) => {
          if (failWork && ctx.state.round === 1) {
            failWork = false;
            throw new Error('work stopped');
          }
          return { state: { round: ctx.state.round + 1 } };
        },
        { after: ['route'] }
      )
      .addConditional('route', (state) => (state.round < 3 ? 'work' : 'stop'), {
        after: ['work'],
      })
      .build();

    const store = new InMemoryCheckpointStore();
    const executor = new WorkflowExecutor(cogitator, store);
    const first = await executor.execute(workflow, {}, { checkpoint: true });
    expect(first.error?.message).toBe('work stopped');
    expect(first.state.round).toBe(1);

    const starts: string[] = [];
    const resumed = await executor.resume(workflow, first.checkpointId ?? '', {
      onNodeStart: (node) => starts.push(node),
    });

    expect(resumed.error).toBeUndefined();
    expect(starts).toEqual(['work', 'route', 'work', 'route']);
    expect(resumed.state.round).toBe(3);
  });

  it('returns the state of a checkpoint whose run had finished without running anything', async () => {
    const store = new InMemoryCheckpointStore();
    const executor = new WorkflowExecutor(cogitator, store);
    const rig = createRig();
    const first = await executor.execute(rig.workflow, {}, { checkpoint: true });
    expect(first.error).toBeUndefined();

    const starts: string[] = [];
    const resumed = await executor.resume(rig.workflow, first.checkpointId ?? '', {
      onNodeStart: (node) => starts.push(node),
    });

    expect(starts).toEqual([]);
    expect(resumed.error).toBeUndefined();
    expect(resumed.state).toEqual(first.state);
  });
});

describe('resuming a checkpoint saved before frontiers were recorded', () => {
  it('passes over the completed nodes by name, as it did before', async () => {
    let failShip = true;
    const calls: string[] = [];
    const workflow = new WorkflowBuilder<{ steps: string[] }>('linear')
      .initialState({ steps: [] })
      .addNode('pick', async (ctx) => {
        calls.push('pick');
        return { state: { steps: [...ctx.state.steps, 'pick'] }, output: 'picked' };
      })
      .addNode(
        'pack',
        async (ctx) => {
          calls.push('pack');
          return { state: { steps: [...ctx.state.steps, 'pack'] }, output: ctx.input };
        },
        { after: ['pick'] }
      )
      .addNode(
        'ship',
        async (ctx) => {
          calls.push('ship');
          if (failShip) {
            failShip = false;
            throw new Error('ship stopped');
          }
          return { state: { steps: [...ctx.state.steps, 'ship'] }, output: ctx.input };
        },
        { after: ['pack'] }
      )
      .build();

    const store = new InMemoryCheckpointStore();
    const executor = new WorkflowExecutor(cogitator, store);
    const first = await executor.execute(workflow, {}, { checkpoint: true });
    expect(first.error?.message).toBe('ship stopped');

    const saved = await store.load(first.checkpointId ?? '');
    expect(saved?.frontier).toEqual({ current: [], next: ['ship'] });
    const { frontier: _frontier, ...legacy } = saved!;
    await store.save({ ...legacy, id: 'ckpt_legacy' });
    calls.length = 0;

    const resumed = await executor.resume(workflow, 'ckpt_legacy');

    expect(resumed.error).toBeUndefined();
    expect(calls).toEqual(['ship']);
    expect(resumed.state.steps).toEqual(['pick', 'pack', 'ship']);
    expect(resumed.nodeResults.get('ship')?.output).toBe('picked');
  });
});

describe('WorkflowManager resuming a run paused inside a loop', () => {
  it('goes on in the round it was paused in and completes the run', async () => {
    const manager = createWorkflowManager({
      cogitator,
      checkpointStore: new InMemoryCheckpointStore(),
    });
    try {
      const calls: string[] = [];
      let gateOpen = false;
      const workflow = new WorkflowBuilder<{ round: number }>('paused-rounds')
        .initialState({ round: 0 })
        .addNode('draft', async (ctx) => {
          const round = ctx.state.round + 1;
          calls.push(`draft:${round}`);
          return { state: { round } };
        })
        .addNode(
          'review',
          (ctx) => {
            calls.push(`review:${ctx.state.round}`);
            if (gateOpen || ctx.state.round < 2) return Promise.resolve({});
            const { signal } = ctx as ExtendedNodeContext<{ round: number }>;
            return new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('stopped')), {
                once: true,
              });
            });
          },
          { after: ['draft'] }
        )
        .addLoop('again', {
          condition: (state) => state.round < 3,
          back: 'draft',
          exit: 'publish',
          after: ['review'],
        })
        .addNode('publish', async (ctx) => {
          calls.push(`publish:${ctx.state.round}`);
          return { output: 'published' };
        })
        .build();

      const running = manager.execute(workflow);
      while (!calls.includes('review:2')) await new Promise((resolve) => setTimeout(resolve, 2));
      const [{ id: runId }] = await manager.listRuns({ workflowName: 'paused-rounds' });

      await manager.pause(runId);
      await running;
      expect((await manager.getStatus(runId))?.status).toBe('paused');

      gateOpen = true;
      const completed = new Promise<void>((resolve) => {
        const unsubscribe = manager.onRunStateChange((run) => {
          if (run.id !== runId || run.status !== 'completed') return;
          unsubscribe();
          resolve();
        });
      });
      await manager.resume(runId);
      await completed;

      expect(calls).toEqual([
        'draft:1',
        'review:1',
        'draft:2',
        'review:2',
        'review:2',
        'draft:3',
        'review:3',
        'publish:3',
      ]);
      expect((await manager.getStatus(runId))?.state).toEqual({ round: 3 });
    } finally {
      manager.dispose();
    }
  });
});
