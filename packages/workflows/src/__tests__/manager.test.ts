import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  type InMemoryRunStore,
  createInMemoryRunStore,
  PriorityQueue,
  type JobScheduler,
  createJobScheduler,
  type DefaultWorkflowManager,
  createWorkflowManager,
} from '../manager/index';
import { WorkflowBuilder } from '../builder';
import { InMemoryCheckpointStore } from '../checkpoint';
import { createMetricsCollector } from '../observability/metrics';
import type { ExtendedNodeContext } from '../nodes/base';
import type { Cogitator } from '@cogitator-ai/core';
import type { WorkflowRun, WorkflowState } from '@cogitator-ai/types';

interface TestState extends WorkflowState {
  value: number;
  steps: string[];
}

const mockCogitator = {} as Cogitator;

describe('Workflow Manager', () => {
  describe('InMemoryRunStore', () => {
    let store: InMemoryRunStore;

    beforeEach(() => {
      store = createInMemoryRunStore();
    });

    it('saves and retrieves runs', async () => {
      const run: WorkflowRun = {
        id: 'run-1',
        workflowName: 'test-workflow',
        status: 'pending',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: [],
      };

      await store.save(run);
      const retrieved = await store.get('run-1');

      expect(retrieved).toEqual(run);
    });

    function runFixture(id: string, startedAt?: number): WorkflowRun {
      return {
        id,
        workflowName: 'test-workflow',
        status: 'pending',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: [],
        ...(startedAt !== undefined && { startedAt }),
      };
    }

    it('hands out copies, so changing a returned run leaves the stored one alone', async () => {
      await store.save(runFixture('run-1'));

      const first = await store.get('run-1');
      first?.completedNodes.push('sneaky');
      const [listed] = await store.list();
      listed.tags.push('sneaky');

      const stored = await store.get('run-1');
      expect(stored?.completedNodes).toEqual([]);
      expect(stored?.tags).toEqual([]);
    });

    it('lists newest first with or without filters', async () => {
      await store.save(runFixture('old', 1000));
      await store.save(runFixture('new', 3000));
      await store.save(runFixture('mid', 2000));

      expect((await store.list()).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.list({})).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    });

    it('updates runs', async () => {
      const run: WorkflowRun = {
        id: 'run-2',
        workflowName: 'test',
        status: 'pending',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: [],
      };

      await store.save(run);
      await store.update('run-2', { status: 'running', startedAt: Date.now() });

      const updated = await store.get('run-2');
      expect(updated?.status).toBe('running');
      expect(updated?.startedAt).toBeDefined();
    });

    it('lists runs with filters', async () => {
      await store.save({
        id: 'run-1',
        workflowName: 'workflow-a',
        status: 'completed',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: ['test'],
      });

      await store.save({
        id: 'run-2',
        workflowName: 'workflow-b',
        status: 'running',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: ['prod'],
      });

      await store.save({
        id: 'run-3',
        workflowName: 'workflow-a',
        status: 'failed',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: ['test'],
      });

      const workflowARuns = await store.list({ workflowName: 'workflow-a' });
      expect(workflowARuns).toHaveLength(2);

      const completedRuns = await store.list({ status: ['completed'] });
      expect(completedRuns).toHaveLength(1);

      const testRuns = await store.list({ tags: ['test'] });
      expect(testRuns).toHaveLength(2);
    });

    it('provides statistics', async () => {
      const now = Date.now();

      await store.save({
        id: 'run-1',
        workflowName: 'test',
        status: 'completed',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        startedAt: now - 1000,
        completedAt: now,
        priority: 0,
        tags: [],
      });

      await store.save({
        id: 'run-2',
        workflowName: 'test',
        status: 'completed',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        startedAt: now - 2000,
        completedAt: now - 500,
        priority: 0,
        tags: [],
      });

      await store.save({
        id: 'run-3',
        workflowName: 'test',
        status: 'failed',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: [],
      });

      const stats = await store.getStats();

      expect(stats.total).toBe(3);
      expect(stats.byStatus.completed).toBe(2);
      expect(stats.byStatus.failed).toBe(1);
    });

    it('counts runs', async () => {
      await store.save({
        id: 'run-1',
        workflowName: 'test',
        status: 'running',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: [],
      });

      await store.save({
        id: 'run-2',
        workflowName: 'test',
        status: 'completed',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        priority: 0,
        tags: [],
      });

      const runningCount = await store.count({ status: ['running'] });
      expect(runningCount).toBe(1);

      const totalCount = await store.count();
      expect(totalCount).toBe(2);
    });

    it('cleans up old runs', async () => {
      const now = Date.now();
      const old = now - 86400000 * 10;

      await store.save({
        id: 'old-run',
        workflowName: 'test',
        status: 'completed',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        completedAt: old,
        priority: 0,
        tags: [],
      });

      await store.save({
        id: 'new-run',
        workflowName: 'test',
        status: 'completed',
        state: {},
        currentNodes: [],
        completedNodes: [],
        failedNodes: [],
        completedAt: now,
        priority: 0,
        tags: [],
      });

      const cleaned = await store.cleanup(86400000 * 7);
      expect(cleaned).toBe(1);

      const remaining = await store.count();
      expect(remaining).toBe(1);
    });
  });

  describe('PriorityQueue', () => {
    it('returns items in priority order (scheduled time first, then priority)', () => {
      const queue = new PriorityQueue();
      const now = Date.now();

      queue.enqueue({ runId: 'later', workflowName: 'wf', priority: 10, scheduledFor: now + 1000 });
      queue.enqueue({ runId: 'sooner', workflowName: 'wf', priority: 1, scheduledFor: now });
      queue.enqueue({ runId: 'also-now', workflowName: 'wf', priority: 5, scheduledFor: now });

      const first = queue.dequeue();
      expect(first?.runId).toBe('sooner');
    });

    it('peeks without removing', () => {
      const queue = new PriorityQueue();
      const now = Date.now();

      queue.enqueue({ runId: 'item', workflowName: 'wf', priority: 5, scheduledFor: now });

      expect(queue.peek()?.runId).toBe('item');
      expect(queue.size()).toBe(1);
    });

    it('reports correct size', () => {
      const queue = new PriorityQueue();
      const now = Date.now();

      expect(queue.size()).toBe(0);

      queue.enqueue({ runId: '1', workflowName: 'wf', priority: 1, scheduledFor: now });
      queue.enqueue({ runId: '2', workflowName: 'wf', priority: 2, scheduledFor: now });

      expect(queue.size()).toBe(2);
    });

    it('clears all items', () => {
      const queue = new PriorityQueue();
      const now = Date.now();

      queue.enqueue({ runId: '1', workflowName: 'wf', priority: 1, scheduledFor: now });
      queue.enqueue({ runId: '2', workflowName: 'wf', priority: 2, scheduledFor: now });

      queue.clear();

      expect(queue.size()).toBe(0);
    });

    it('gets ready items', () => {
      const queue = new PriorityQueue();
      const now = Date.now();

      queue.enqueue({ runId: 'past', workflowName: 'wf', priority: 1, scheduledFor: now - 1000 });
      queue.enqueue({ runId: 'now', workflowName: 'wf', priority: 2, scheduledFor: now });
      queue.enqueue({
        runId: 'future',
        workflowName: 'wf',
        priority: 3,
        scheduledFor: now + 10000,
      });

      const ready = queue.getReady(now);
      expect(ready).toHaveLength(2);
      expect(ready.map((i) => i.runId)).toContain('past');
      expect(ready.map((i) => i.runId)).toContain('now');
    });

    it('removes items by runId', () => {
      const queue = new PriorityQueue();
      const now = Date.now();

      queue.enqueue({ runId: '1', workflowName: 'wf', priority: 1, scheduledFor: now });
      queue.enqueue({ runId: '2', workflowName: 'wf', priority: 2, scheduledFor: now });
      queue.enqueue({ runId: '3', workflowName: 'wf', priority: 3, scheduledFor: now });

      const removed = queue.remove('2');
      expect(removed).toBe(true);
      expect(queue.size()).toBe(2);
    });
  });

  describe('JobScheduler', () => {
    let scheduler: JobScheduler;
    let store: InMemoryRunStore;
    let onRunReady: Mock<(runId: string) => void>;

    beforeEach(() => {
      store = createInMemoryRunStore();
      onRunReady = vi.fn<(runId: string) => void>();
      scheduler = createJobScheduler({
        runStore: store,
        maxConcurrency: 2,
        pollInterval: 10,
        onRunReady,
      });
    });

    afterEach(() => {
      scheduler.dispose();
    });

    it('starts and stops', () => {
      scheduler.start();
      expect(scheduler.getRunningCount()).toBe(0);

      scheduler.stop();
    });

    it('schedules runs for immediate execution', async () => {
      const workflow = new WorkflowBuilder<TestState>('test')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .build();

      scheduler.start();

      const runId = await scheduler.scheduleRun(workflow);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onRunReady).toHaveBeenCalledWith(runId);
    });

    it('schedules runs for future execution', async () => {
      const workflow = new WorkflowBuilder<TestState>('test')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .build();

      scheduler.start();

      const futureTime = Date.now() + 100;
      const runId = await scheduler.scheduleRun(workflow, { at: futureTime });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onRunReady).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(onRunReady).toHaveBeenCalledWith(runId);
    });

    it('respects max concurrency', async () => {
      const workflow = new WorkflowBuilder<TestState>('test')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .build();

      const startedRuns: string[] = [];

      scheduler.dispose();
      scheduler = createJobScheduler({
        runStore: store,
        maxConcurrency: 2,
        pollInterval: 10,
        onRunReady: (runId) => {
          onRunReady(runId);
          startedRuns.push(runId);
        },
      });

      scheduler.start();

      await scheduler.scheduleRun(workflow);
      await scheduler.scheduleRun(workflow);
      await scheduler.scheduleRun(workflow);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onRunReady).toHaveBeenCalledTimes(2);
      expect(startedRuns).toHaveLength(2);

      scheduler.runCompleted(startedRuns[0]);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onRunReady).toHaveBeenCalledTimes(3);
    });

    it('cancels runs', async () => {
      const workflow = new WorkflowBuilder<TestState>('test')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .build();

      const futureTime = Date.now() + 500;
      const runId = await scheduler.scheduleRun(workflow, { at: futureTime });

      await scheduler.cancelRun(runId, 'Test cancellation');

      const run = await store.get(runId);
      expect(run?.status).toBe('cancelled');
    });
  });

  describe('DefaultWorkflowManager', () => {
    let manager: DefaultWorkflowManager;

    beforeEach(() => {
      manager = createWorkflowManager({ cogitator: mockCogitator });
      manager.start();
    });

    afterEach(() => {
      manager.dispose();
    });

    it('executes workflows immediately', async () => {
      const workflow = new WorkflowBuilder<TestState>('immediate')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async (ctx) => ({
          state: { value: ctx.state.value + 10, steps: [...ctx.state.steps, 'step1'] },
        }))
        .build();

      const result = await manager.execute(workflow);

      expect(result.state.value).toBe(10);
      expect(result.state.steps).toEqual(['step1']);
    });

    it('tracks run status', async () => {
      const workflow = new WorkflowBuilder<TestState>('tracked')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async (ctx) => ({
          state: { value: ctx.state.value + 1 },
        }))
        .build();

      await manager.execute(workflow);

      const runs = await manager.listRuns({ workflowName: 'tracked' });
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('completed');
    });

    it('records every completed node by the time execute resolves', async () => {
      const workflow = new WorkflowBuilder<TestState>('recorded')
        .initialState({ value: 0, steps: [] })
        .addNode('first', async () => ({ state: { value: 1 } }))
        .addNode('second', async () => ({ state: { value: 2 } }), { after: ['first'] })
        .build();

      await manager.execute(workflow);

      const [run] = await manager.listRuns({ workflowName: 'recorded' });
      expect(run.completedNodes).toEqual(['first', 'second']);
      expect(run.currentNodes).toEqual([]);
    });

    it('records the nodes of scheduled runs', async () => {
      const workflow = new WorkflowBuilder<TestState>('scheduled-nodes')
        .initialState({ value: 0, steps: [] })
        .addNode('only', async () => ({ state: { value: 1 } }))
        .build();

      const runId = await manager.schedule(workflow, { at: Date.now() });

      await vi.waitFor(
        async () => {
          const runs = await manager.listRuns({ workflowName: 'scheduled-nodes' });
          expect(runs.find((r) => r.id === runId)?.status).toBe('completed');
        },
        { timeout: 5000 }
      );
      const [run] = await manager.listRuns({ workflowName: 'scheduled-nodes' });
      expect(run.completedNodes).toEqual(['only']);
    });

    it('handles workflow errors', async () => {
      const workflow = new WorkflowBuilder<TestState>('failing')
        .initialState({ value: 0, steps: [] })
        .addNode('fail', async () => {
          throw new Error('Intentional failure');
        })
        .build();

      const result = await manager.execute(workflow);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toBe('Intentional failure');

      const runs = await manager.listRuns({ workflowName: 'failing' });
      expect(runs[0].status).toBe('failed');
      expect(runs[0].error?.message).toBe('Intentional failure');
    });

    it('cancels running workflows', async () => {
      const workflow = new WorkflowBuilder<TestState>('cancellable')
        .initialState({ value: 0, steps: [] })
        .addNode('slow', async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return { state: { value: 1 } };
        })
        .build();

      const resultPromise = manager.execute(workflow);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runs = await manager.listRuns({ workflowName: 'cancellable' });
      await manager.cancel(runs[0].id, 'Test cancellation');

      try {
        await resultPromise;
      } catch {}

      const updatedRuns = await manager.listRuns({ workflowName: 'cancellable' });
      expect(['cancelled', 'completed', 'failed']).toContain(updatedRuns[0].status);
    });

    it('refuses to pause without a checkpoint store to resume from', async () => {
      let release!: () => void;
      const workflow = new WorkflowBuilder<TestState>('unpausable')
        .initialState({ value: 0, steps: [] })
        .addNode('wait', () => new Promise((resolve) => (release = () => resolve({}))))
        .build();

      const resultPromise = manager.execute(workflow);
      const runId = await waitForRun(manager, 'unpausable', 'running');

      await expect(manager.pause(runId)).rejects.toThrow('no checkpointStore');
      expect((await manager.getStatus(runId))?.status).toBe('running');

      release();
      await resultPromise;
    });

    it('retries failed workflows', async () => {
      let attempts = 0;

      const workflow = new WorkflowBuilder<TestState>('retryable')
        .initialState({ value: 0, steps: [] })
        .addNode('maybe-fail', async () => {
          attempts++;
          if (attempts === 1) throw new Error('First attempt fails');
          return { state: { value: 1 } };
        })
        .build();

      const result = await manager.execute(workflow);
      expect(result.error).toBeDefined();

      const failedRuns = await manager.listRuns({ status: ['failed'] });
      const failedRunId = failedRuns[0].id;

      const newRunId = await manager.retry(failedRunId);
      expect(newRunId).not.toBe(failedRunId);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const retryRun = await manager.getStatus(newRunId);
      expect(retryRun).toBeDefined();
    });

    it('notifies on state changes', async () => {
      const stateChanges: WorkflowRun[] = [];
      manager.onRunStateChange((run) => {
        stateChanges.push({ ...run });
      });

      const workflow = new WorkflowBuilder<TestState>('observable')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .build();

      await manager.execute(workflow);

      expect(stateChanges.length).toBeGreaterThanOrEqual(1);
    });

    it('provides statistics', async () => {
      const workflow = new WorkflowBuilder<TestState>('stats-test')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .build();

      await manager.execute(workflow);

      const stats = await manager.getStats();
      expect(stats.total).toBeGreaterThanOrEqual(1);
    });

    it('cleans up old runs', async () => {
      const workflow = new WorkflowBuilder<TestState>('cleanup-test')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .build();

      await manager.execute(workflow);

      const cleaned = await manager.cleanup(86400000);
      expect(cleaned).toBe(0);
    });

    it('counts active runs', async () => {
      const workflow = new WorkflowBuilder<TestState>('active-test')
        .initialState({ value: 0, steps: [] })
        .addNode('slow', async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { state: { value: 1 } };
        })
        .build();

      const resultPromise = manager.execute(workflow);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const activeCount = await manager.getActiveCount();
      expect(activeCount).toBeGreaterThanOrEqual(0);

      await resultPromise;
    });
  });
});

async function waitForRun(
  manager: DefaultWorkflowManager,
  workflowName: string,
  status: WorkflowRun['status'],
  count = 1
): Promise<string> {
  for (;;) {
    const runs = await manager.listRuns({ workflowName, status });
    if (runs.length >= count) return runs[0].id;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function untilRun(
  manager: DefaultWorkflowManager,
  runId: string,
  status: WorkflowRun['status']
): Promise<WorkflowRun> {
  return new Promise((resolve) => {
    const unsubscribe = manager.onRunStateChange((run) => {
      if (run.id === runId && run.status === status) {
        unsubscribe();
        resolve(run);
      }
    });
  });
}

describe('Workflow Manager run lifecycle', () => {
  let manager: DefaultWorkflowManager;

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  function gatedWorkflow(name: string, calls: string[]) {
    let gateOpen = false;
    const workflow = new WorkflowBuilder<TestState>(name)
      .initialState({ value: 0, steps: [] })
      .addNode('a', async () => {
        calls.push('a');
        return { output: 'a-out' };
      })
      .addNode(
        'b',
        (ctx) => {
          calls.push('b');
          if (gateOpen) return Promise.resolve({ output: `b saw ${String(ctx.input)}` });
          const signal = (ctx as ExtendedNodeContext<TestState>).signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
          });
        },
        { after: ['a'] }
      )
      .addNode(
        'c',
        async (ctx) => {
          calls.push('c');
          return { output: ctx.input, state: { value: 1 } };
        },
        { after: ['b'] }
      )
      .build();
    return { workflow, open: () => (gateOpen = true) };
  }

  it('keeps a paused run paused and resumes it from its last checkpoint', async () => {
    manager = createWorkflowManager({
      cogitator: mockCogitator,
      checkpointStore: new InMemoryCheckpointStore(),
    });
    const calls: string[] = [];
    const completed: string[] = [];
    const { workflow, open } = gatedWorkflow('pausable', calls);

    const resultPromise = manager.execute(workflow, undefined, {
      onNodeComplete: (node) => completed.push(node),
    });
    const runId = await waitForRun(manager, 'pausable', 'running');
    while (!calls.includes('b')) await new Promise((resolve) => setTimeout(resolve, 2));

    await manager.pause(runId);
    const result = await resultPromise;

    expect(result.error?.message).toBe(`Workflow run '${runId}' was paused`);
    const paused = await manager.getStatus(runId);
    expect(paused?.status).toBe('paused');
    expect(paused?.checkpointId).toBeDefined();

    open();
    const done = untilRun(manager, runId, 'completed');
    await manager.resume(runId);
    const finished = await done;

    expect(calls).toEqual(['a', 'b', 'b', 'c']);
    expect(completed).toEqual(['a', 'b', 'c']);
    expect(finished.state).toMatchObject({ value: 1 });
    expect(finished.output).toMatchObject({ value: 1 });
    expect(finished.completedNodes).toEqual(['a', 'b', 'c']);
  });

  it('keeps a cancelled run cancelled with its reason', async () => {
    manager = createWorkflowManager({ cogitator: mockCogitator });
    const { workflow } = gatedWorkflow('cancellable-run', []);

    const resultPromise = manager.execute(workflow);
    const runId = await waitForRun(manager, 'cancellable-run', 'running');
    await new Promise((resolve) => setTimeout(resolve, 5));

    await manager.cancel(runId, 'not needed');
    const result = await resultPromise;

    expect(result.error?.message).toBe(`Workflow run '${runId}' was cancelled`);
    const run = await manager.getStatus(runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.error).toEqual({ name: 'CancelError', message: 'not needed' });
  });

  it('gives scheduled runs the checkpoint store, metrics and their timeout', async () => {
    const metrics = createMetricsCollector();
    manager = createWorkflowManager({
      cogitator: mockCogitator,
      checkpointStore: new InMemoryCheckpointStore(),
      metrics,
      defaultTimeout: 10_000,
    });
    manager.start();
    const quick = new WorkflowBuilder<TestState>('scheduled-quick')
      .initialState({ value: 0, steps: [] })
      .addNode('step', async () => ({ state: { value: 1 } }))
      .build();
    const slow = new WorkflowBuilder<TestState>('scheduled-slow')
      .initialState({ value: 0, steps: [] })
      .addNode('step', () => new Promise((resolve) => setTimeout(() => resolve({}), 500)))
      .build();

    const quickId = await manager.schedule(quick);
    const slowId = await manager.schedule(slow, { timeout: 20 });
    const quickRun = await untilRun(manager, quickId, 'completed');
    const slowRun = await untilRun(manager, slowId, 'failed');

    expect(quickRun.checkpointId).toBeDefined();
    expect(metrics.getWorkflowMetrics('scheduled-quick')?.executionCount).toBe(1);
    expect(slowRun.error?.message).toContain('timed out after 20ms');
  });

  it('retries a failed scheduled run up to maxRetries times', async () => {
    manager = createWorkflowManager({ cogitator: mockCogitator });
    manager.start();
    let attempts = 0;
    const flaky = new WorkflowBuilder<TestState>('flaky')
      .initialState({ value: 0, steps: [] })
      .addNode('step', async () => {
        attempts++;
        throw new Error(`attempt ${attempts} failed`);
      })
      .build();

    await manager.schedule(flaky, { maxRetries: 2 });
    await waitForRun(manager, 'flaky', 'failed', 3);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(attempts).toBe(3);
    const runs = await manager.listRuns({ workflowName: 'flaky' });
    expect(runs.map((r) => r.metadata?.retryAttempt ?? 0).sort()).toEqual([0, 1, 2]);
  });

  it('runs registered cron jobs on every occurrence', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:30Z') });
    manager = createWorkflowManager({ cogitator: mockCogitator });
    manager.start();
    let runs = 0;
    const tick = new WorkflowBuilder<TestState>('every-minute')
      .initialState({ value: 0, steps: [] })
      .addNode('step', async () => {
        runs++;
        return {};
      })
      .build();

    const jobId = manager.registerCronJob(tick, '* * * * *');
    expect(manager.getCronJobs().map((job) => job.id)).toEqual([jobId]);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(runs).toBe(3);

    expect(manager.unregisterCronJob(jobId)).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(runs).toBe(3);
  });
});
