import { describe, it, expect } from 'vitest';
import { WorkflowScheduler } from '../scheduler.js';
import { WorkflowBuilder } from '../builder.js';

interface TestState {
  value: number;
}

describe('WorkflowScheduler', () => {
  const scheduler = new WorkflowScheduler();

  describe('buildDependencyGraph', () => {
    it('builds correct dependency graph', () => {
      const workflow = new WorkflowBuilder<TestState>('deps')
        .initialState({ value: 0 })
        .addNode('a', async () => ({}))
        .addNode('b', async () => ({}), { after: ['a'] })
        .addNode('c', async () => ({}), { after: ['a'] })
        .addNode('d', async () => ({}), { after: ['b', 'c'] })
        .build();

      const graph = scheduler.buildDependencyGraph(workflow);

      // Node a has no dependencies
      expect(graph.dependencies.get('a')?.size).toBe(0);

      // Node b depends on a
      expect(graph.dependencies.get('b')?.has('a')).toBe(true);

      // Node c depends on a
      expect(graph.dependencies.get('c')?.has('a')).toBe(true);

      // Node d depends on both b and c
      expect(graph.dependencies.get('d')?.has('b')).toBe(true);
      expect(graph.dependencies.get('d')?.has('c')).toBe(true);

      // Node a has dependents b and c
      expect(graph.dependents.get('a')?.has('b')).toBe(true);
      expect(graph.dependents.get('a')?.has('c')).toBe(true);
    });
  });

  describe('getReadyNodes', () => {
    it('returns nodes with all dependencies completed', () => {
      const workflow = new WorkflowBuilder<TestState>('ready')
        .initialState({ value: 0 })
        .addNode('a', async () => ({}))
        .addNode('b', async () => ({}), { after: ['a'] })
        .addNode('c', async () => ({}), { after: ['a'] })
        .build();

      const graph = scheduler.buildDependencyGraph(workflow);

      // Initially only 'a' is ready
      const pending1 = new Set(['a', 'b', 'c']);
      const ready1 = scheduler.getReadyNodes(graph, new Set(), pending1);
      expect(ready1).toEqual(['a']);

      // After 'a' completes, 'b' and 'c' are ready
      const completed = new Set(['a']);
      const pending2 = new Set(['b', 'c']);
      const ready2 = scheduler.getReadyNodes(graph, completed, pending2);
      expect(ready2).toContain('b');
      expect(ready2).toContain('c');
    });
  });

  describe('getExecutionLevels', () => {
    it('returns nodes grouped by execution level', () => {
      const workflow = new WorkflowBuilder<TestState>('levels')
        .initialState({ value: 0 })
        .addNode('a', async () => ({}))
        .addNode('b', async () => ({}), { after: ['a'] })
        .addNode('c', async () => ({}), { after: ['a'] })
        .addNode('d', async () => ({}), { after: ['b', 'c'] })
        .build();

      const levels = scheduler.getExecutionLevels(workflow);

      // Level 0: a
      expect(levels[0]).toEqual(['a']);

      // Level 1: b and c (parallel)
      expect(levels[1]).toContain('b');
      expect(levels[1]).toContain('c');
      expect(levels[1].length).toBe(2);

      // Level 2: d
      expect(levels[2]).toEqual(['d']);
    });
  });

  describe('getNextNodes', () => {
    it('returns next nodes for sequential edges', () => {
      const workflow = new WorkflowBuilder<TestState>('sequential')
        .initialState({ value: 0 })
        .addNode('a', async () => ({}))
        .addNode('b', async () => ({}), { after: ['a'] })
        .build();

      const nextNodes = scheduler.getNextNodes(workflow, 'a', { value: 0 });
      expect(nextNodes).toEqual(['b']);
    });

    it('returns correct node for conditional edges', () => {
      const workflow = new WorkflowBuilder<TestState>('conditional')
        .initialState({ value: 0 })
        .addNode('start', async () => ({}))
        .addConditional(
          'router',
          (state: TestState) => (state.value > 5 ? 'high' : 'low'),
          { after: ['start'] }
        )
        .addNode('high', async () => ({}), { after: ['router'] })
        .addNode('low', async () => ({}), { after: ['router'] })
        .build();

      // Low value -> low path
      const nextLow = scheduler.getNextNodes(workflow, 'router', { value: 3 });
      expect(nextLow).toEqual(['low']);

      // High value -> high path
      const nextHigh = scheduler.getNextNodes(workflow, 'router', { value: 10 });
      expect(nextHigh).toEqual(['high']);
    });

    it('handles loop edges correctly', () => {
      const workflow = new WorkflowBuilder<TestState>('loop')
        .initialState({ value: 0 })
        .addNode('process', async () => ({}))
        .addLoop('check', {
          condition: (state: TestState) => state.value < 5,
          back: 'process',
          exit: 'done',
          after: ['process'],
        })
        .addNode('done', async () => ({}))
        .build();

      // Should loop back
      const loopBack = scheduler.getNextNodes(workflow, 'check', { value: 3 });
      expect(loopBack).toEqual(['process']);

      // Should exit
      const loopExit = scheduler.getNextNodes(workflow, 'check', { value: 5 });
      expect(loopExit).toEqual(['done']);
    });
  });

  describe('runParallel', () => {
    it('runs tasks in parallel with concurrency limit', async () => {
      const results: number[] = [];
      const tasks = [1, 2, 3, 4, 5].map(
        (n) => async () => {
          await new Promise((r) => setTimeout(r, 10));
          results.push(n);
          return n;
        }
      );

      const output = await scheduler.runParallel(tasks, 2);

      expect(output).toHaveLength(5);
      expect(output.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('respects concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const tasks = [1, 2, 3, 4].map(
        () => async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return true;
        }
      );

      await scheduler.runParallel(tasks, 2);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });
});
