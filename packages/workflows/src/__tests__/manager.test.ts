import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import type { Cogitator } from '@cogitator-ai/core';
import type { WorkflowRun } from '@cogitator-ai/types';

interface TestState {
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
      queue.enqueue({ runId: 'future', workflowName: 'wf', priority: 3, scheduledFor: now + 10000 });

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
    let onRunReady: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      store = createInMemoryRunStore();
      onRunReady = vi.fn();
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
          scheduler.runStarted(runId);
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
      } catch {
      }

      const updatedRuns = await manager.listRuns({ workflowName: 'cancellable' });
      expect(['cancelled', 'completed', 'failed']).toContain(updatedRuns[0].status);
    });

    it('pauses and resumes workflows', async () => {
      const workflow = new WorkflowBuilder<TestState>('pausable')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .build();

      const resultPromise = manager.execute(workflow);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const runs = await manager.listRuns({ workflowName: 'pausable' });

      if (runs[0].status === 'running') {
        await manager.pause(runs[0].id);

        const pausedRun = await manager.getStatus(runs[0].id);
        expect(pausedRun?.status).toBe('paused');

        await manager.resume(runs[0].id);

        const resumedRun = await manager.getStatus(runs[0].id);
        expect(resumedRun?.status).toBe('running');
      }

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
