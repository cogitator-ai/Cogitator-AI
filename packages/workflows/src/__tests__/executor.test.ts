import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../executor';
import { WorkflowBuilder } from '../builder';
import { InMemoryCheckpointStore } from '../checkpoint';
import type { Cogitator } from '@cogitator-ai/core';

interface TestState {
  value: number;
  steps: string[];
}

const mockCogitator = {} as Cogitator;

describe('WorkflowExecutor', () => {
  describe('execute', () => {
    it('executes a simple sequential workflow', async () => {
      const workflow = new WorkflowBuilder<TestState>('simple')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async (ctx) => ({
          state: {
            value: ctx.state.value + 1,
            steps: [...ctx.state.steps, 'step1'],
          },
        }))
        .addNode(
          'step2',
          async (ctx) => ({
            state: {
              value: ctx.state.value + 10,
              steps: [...ctx.state.steps, 'step2'],
            },
          }),
          { after: ['step1'] }
        )
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      const result = await executor.execute(workflow);

      expect(result.error).toBeUndefined();
      expect(result.state.value).toBe(11);
      expect(result.state.steps).toEqual(['step1', 'step2']);
    });

    it('passes input to initial state', async () => {
      const workflow = new WorkflowBuilder<TestState>('with-input')
        .initialState({ value: 0, steps: [] })
        .addNode('check', async (ctx) => ({
          output: ctx.state.value,
        }))
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      const result = await executor.execute(workflow, { value: 42 });

      expect(result.state.value).toBe(42);
      expect(result.nodeResults.get('check')?.output).toBe(42);
    });

    it('handles conditional routing', async () => {
      const workflow = new WorkflowBuilder<TestState>('conditional')
        .initialState({ value: 0, steps: [] })
        .addNode('start', async () => ({ state: { value: 10 } }))
        .addConditional('router', (state: TestState) => (state.value > 5 ? 'high' : 'low'), {
          after: ['start'],
        })
        .addNode(
          'high',
          async (ctx) => ({
            state: { steps: [...ctx.state.steps, 'high'] },
          }),
          { after: ['router'] }
        )
        .addNode(
          'low',
          async (ctx) => ({
            state: { steps: [...ctx.state.steps, 'low'] },
          }),
          { after: ['router'] }
        )
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      const result = await executor.execute(workflow);

      expect(result.state.steps).toContain('high');
      expect(result.state.steps).not.toContain('low');
    });

    it('handles loops with max iterations', async () => {
      const workflow = new WorkflowBuilder<TestState>('loop')
        .initialState({ value: 0, steps: [] })
        .addNode('increment', async (ctx) => ({
          state: { value: ctx.state.value + 1 },
        }))
        .addLoop('check', {
          condition: (state: TestState) => state.value < 3,
          back: 'increment',
          exit: 'done',
          after: ['increment'],
        })
        .addNode('done', async (ctx) => ({
          state: { steps: [...ctx.state.steps, 'done'] },
        }))
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      const result = await executor.execute(workflow);

      expect(result.state.value).toBe(3);
      expect(result.state.steps).toContain('done');
    });

    it('enforces max iterations', async () => {
      const workflow = new WorkflowBuilder<TestState>('infinite-loop')
        .initialState({ value: 0, steps: [] })
        .addNode('increment', async (ctx) => ({
          state: { value: ctx.state.value + 1 },
        }))
        .addLoop('check', {
          condition: () => true,
          back: 'increment',
          exit: 'done',
          after: ['increment'],
        })
        .addNode('done', async () => ({}))
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      const result = await executor.execute(workflow, undefined, {
        maxIterations: 10,
      });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('max iterations');
      expect(result.state.value).toBe(5);
    });

    it('calls event callbacks', async () => {
      const workflow = new WorkflowBuilder<TestState>('events')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ output: 'result1' }))
        .build();

      const onNodeStart = vi.fn();
      const onNodeComplete = vi.fn();

      const executor = new WorkflowExecutor(mockCogitator);
      await executor.execute(workflow, undefined, {
        onNodeStart,
        onNodeComplete,
      });

      expect(onNodeStart).toHaveBeenCalledWith('step1');
      expect(onNodeComplete).toHaveBeenCalledWith('step1', 'result1', expect.any(Number));
    });

    it('handles node errors', async () => {
      const workflow = new WorkflowBuilder<TestState>('error')
        .initialState({ value: 0, steps: [] })
        .addNode('failing', async () => {
          throw new Error('Node failed');
        })
        .build();

      const onNodeError = vi.fn();

      const executor = new WorkflowExecutor(mockCogitator);
      const result = await executor.execute(workflow, undefined, {
        onNodeError,
      });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toBe('Node failed');
      expect(onNodeError).toHaveBeenCalled();
    });
  });

  describe('checkpointing', () => {
    it('saves checkpoints when enabled', async () => {
      const checkpointStore = new InMemoryCheckpointStore();

      const workflow = new WorkflowBuilder<TestState>('checkpoint')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .addNode('step2', async () => ({ state: { value: 2 } }), {
          after: ['step1'],
        })
        .build();

      const executor = new WorkflowExecutor(mockCogitator, checkpointStore);
      const result = await executor.execute(workflow, undefined, {
        checkpoint: true,
      });

      expect(result.checkpointId).toBeDefined();

      const checkpoints = await checkpointStore.list('checkpoint');
      expect(checkpoints.length).toBeGreaterThan(0);
    });

    it('saves checkpoint per-iteration by default', async () => {
      const checkpointStore = new InMemoryCheckpointStore();

      const workflow = new WorkflowBuilder<TestState>('per-iteration')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .addNode('step2', async () => ({ state: { value: 2 } }), { after: ['step1'] })
        .addNode('step3', async () => ({ state: { value: 3 } }), { after: ['step2'] })
        .build();

      const executor = new WorkflowExecutor(mockCogitator, checkpointStore);
      await executor.execute(workflow, undefined, {
        checkpoint: true,
        checkpointStrategy: 'per-iteration',
      });

      const checkpoints = await checkpointStore.list('per-iteration');
      expect(checkpoints.length).toBe(3);
    });

    it('saves checkpoint per-node when strategy is per-node', async () => {
      const checkpointStore = new InMemoryCheckpointStore();

      const workflow = new WorkflowBuilder<TestState>('per-node')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => ({ state: { value: 1 } }))
        .addNode('step2', async () => ({ state: { value: 2 } }), { after: ['step1'] })
        .addNode('step3', async () => ({ state: { value: 3 } }), { after: ['step2'] })
        .build();

      const executor = new WorkflowExecutor(mockCogitator, checkpointStore);
      await executor.execute(workflow, undefined, {
        checkpoint: true,
        checkpointStrategy: 'per-node',
      });

      const checkpoints = await checkpointStore.list('per-node');
      expect(checkpoints.length).toBe(3);
    });

    it('per-node saves more checkpoints than per-iteration for parallel nodes', async () => {
      const perIterationStore = new InMemoryCheckpointStore();
      const perNodeStore = new InMemoryCheckpointStore();

      const buildWorkflow = (name: string) =>
        new WorkflowBuilder<TestState>(name)
          .initialState({ value: 0, steps: [] })
          .addNode('start', async () => ({}))
          .addParallel('fanout', ['a', 'b', 'c'], { after: ['start'] })
          .addNode('a', async () => ({ output: 'a' }))
          .addNode('b', async () => ({ output: 'b' }))
          .addNode('c', async () => ({ output: 'c' }))
          .build();

      const executor1 = new WorkflowExecutor(mockCogitator, perIterationStore);
      await executor1.execute(buildWorkflow('per-iter-parallel'), undefined, {
        checkpoint: true,
        checkpointStrategy: 'per-iteration',
      });

      const executor2 = new WorkflowExecutor(mockCogitator, perNodeStore);
      await executor2.execute(buildWorkflow('per-node-parallel'), undefined, {
        checkpoint: true,
        checkpointStrategy: 'per-node',
      });

      const perIterCheckpoints = await perIterationStore.list('per-iter-parallel');
      const perNodeCheckpoints = await perNodeStore.list('per-node-parallel');

      expect(perNodeCheckpoints.length).toBeGreaterThan(perIterCheckpoints.length);
    });

    it('per-node checkpoints capture incremental progress', async () => {
      const checkpointStore = new InMemoryCheckpointStore();
      const completionOrder: string[] = [];

      const workflow = new WorkflowBuilder<TestState>('incremental')
        .initialState({ value: 0, steps: [] })
        .addNode('start', async () => ({}))
        .addParallel('fanout', ['a', 'b'], { after: ['start'] })
        .addNode('a', async () => {
          completionOrder.push('a');
          return { output: 'result-a' };
        })
        .addNode('b', async () => {
          await new Promise((r) => setTimeout(r, 20));
          completionOrder.push('b');
          return { output: 'result-b' };
        })
        .build();

      const executor = new WorkflowExecutor(mockCogitator, checkpointStore);
      await executor.execute(workflow, undefined, {
        checkpoint: true,
        checkpointStrategy: 'per-node',
      });

      const checkpoints = await checkpointStore.list('incremental');
      checkpoints.sort((a, b) => a.timestamp - b.timestamp);

      const secondCheckpoint = checkpoints[1];
      expect(secondCheckpoint.completedNodes).toContain('start');
      expect(secondCheckpoint.completedNodes.length).toBe(2);

      const thirdCheckpoint = checkpoints[2];
      expect(thirdCheckpoint.completedNodes.length).toBe(3);
    });

    it('per-node checkpoint stores completed nodes incrementally', async () => {
      const checkpointStore = new InMemoryCheckpointStore();

      const workflow = new WorkflowBuilder<TestState>('incremental-store')
        .initialState({ value: 0, steps: [] })
        .addNode('start', async () => ({}))
        .addParallel('fanout', ['a', 'b'], { after: ['start'] })
        .addNode('a', async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { output: 'result-a' };
        })
        .addNode('b', async () => {
          await new Promise((r) => setTimeout(r, 30));
          return { output: 'result-b' };
        })
        .build();

      const executor = new WorkflowExecutor(mockCogitator, checkpointStore);
      await executor.execute(workflow, undefined, {
        checkpoint: true,
        checkpointStrategy: 'per-node',
      });

      const checkpoints = await checkpointStore.list('incremental-store');
      checkpoints.sort((a, b) => a.timestamp - b.timestamp);

      expect(checkpoints[0].completedNodes).toEqual(['start']);

      const secondCheckpoint = checkpoints[1];
      expect(secondCheckpoint.completedNodes).toContain('start');
      expect(secondCheckpoint.completedNodes.length).toBe(2);

      const lastCheckpoint = checkpoints[checkpoints.length - 1];
      expect(lastCheckpoint.completedNodes).toContain('start');
      expect(lastCheckpoint.completedNodes).toContain('a');
      expect(lastCheckpoint.completedNodes).toContain('b');
    });
  });

  describe('parallel execution', () => {
    it('executes independent nodes in parallel', async () => {
      const startTimes: Record<string, number> = {};
      const endTimes: Record<string, number> = {};

      const workflow = new WorkflowBuilder<TestState>('parallel')
        .initialState({ value: 0, steps: [] })
        .addNode('start', async () => ({ output: 'started' }))
        .addNode(
          'a',
          async () => {
            startTimes.a = Date.now();
            await new Promise((r) => setTimeout(r, 50));
            endTimes.a = Date.now();
            return { output: 'a' };
          },
          { after: ['start'] }
        )
        .addNode(
          'b',
          async () => {
            startTimes.b = Date.now();
            await new Promise((r) => setTimeout(r, 50));
            endTimes.b = Date.now();
            return { output: 'b' };
          },
          { after: ['start'] }
        )
        .addNode('merge', async () => ({ output: 'merged' }), {
          after: ['a', 'b'],
        })
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      await executor.execute(workflow);

      const startDiff = Math.abs(startTimes.a - startTimes.b);
      expect(startDiff).toBeLessThan(30);
    });
  });

  describe('parallel edge execution', () => {
    it('executes parallel targets via ParallelEdge', async () => {
      const startTimes: Record<string, number> = {};

      const workflow = new WorkflowBuilder<TestState>('parallel-edge')
        .initialState({ value: 0, steps: [] })
        .addNode('start', async () => ({ output: 'started' }))
        .addParallel('fanout', ['a', 'b', 'c'], { after: ['start'] })
        .addNode('a', async () => {
          startTimes.a = Date.now();
          await new Promise((r) => setTimeout(r, 30));
          return { output: 'a' };
        })
        .addNode('b', async () => {
          startTimes.b = Date.now();
          await new Promise((r) => setTimeout(r, 30));
          return { output: 'b' };
        })
        .addNode('c', async () => {
          startTimes.c = Date.now();
          await new Promise((r) => setTimeout(r, 30));
          return { output: 'c' };
        })
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      const result = await executor.execute(workflow);

      expect(result.error).toBeUndefined();
      expect(result.nodeResults.get('a')?.output).toBe('a');
      expect(result.nodeResults.get('b')?.output).toBe('b');
      expect(result.nodeResults.get('c')?.output).toBe('c');

      const startDiff_ab = Math.abs(startTimes.a - startTimes.b);
      const startDiff_bc = Math.abs(startTimes.b - startTimes.c);
      expect(startDiff_ab).toBeLessThan(20);
      expect(startDiff_bc).toBeLessThan(20);
    });

    it('respects maxConcurrency with parallel edges', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const workflow = new WorkflowBuilder<TestState>('concurrency')
        .initialState({ value: 0, steps: [] })
        .addNode('start', async () => ({}))
        .addParallel('fanout', ['a', 'b', 'c', 'd'], { after: ['start'] })
        .addNode('a', async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { output: 'a' };
        })
        .addNode('b', async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { output: 'b' };
        })
        .addNode('c', async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { output: 'c' };
        })
        .addNode('d', async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { output: 'd' };
        })
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      await executor.execute(workflow, undefined, { maxConcurrency: 2 });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('handles fan-in after parallel with merged inputs', async () => {
      const workflow = new WorkflowBuilder<TestState>('fan-in')
        .initialState({ value: 0, steps: [] })
        .addNode('start', async () => ({ output: 'started' }))
        .addParallel('fanout', ['a', 'b'], { after: ['start'] })
        .addNode('a', async () => ({ output: 'result-a' }))
        .addNode('b', async () => ({ output: 'result-b' }))
        .addNode(
          'merge',
          async (ctx) => {
            return { output: ctx.input };
          },
          { after: ['a', 'b'] }
        )
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      const result = await executor.execute(workflow);

      expect(result.error).toBeUndefined();
      const mergeOutput = result.nodeResults.get('merge')?.output as unknown[];
      expect(mergeOutput).toContain('result-a');
      expect(mergeOutput).toContain('result-b');
    });

    it('handles mixed sequential and parallel workflow', async () => {
      const executionOrder: string[] = [];

      const workflow = new WorkflowBuilder<TestState>('mixed')
        .initialState({ value: 0, steps: [] })
        .addNode('step1', async () => {
          executionOrder.push('step1');
          return {};
        })
        .addNode(
          'step2',
          async () => {
            executionOrder.push('step2');
            return {};
          },
          { after: ['step1'] }
        )
        .addParallel('fanout', ['a', 'b'], { after: ['step2'] })
        .addNode('a', async () => {
          executionOrder.push('a');
          return { output: 'a' };
        })
        .addNode('b', async () => {
          executionOrder.push('b');
          return { output: 'b' };
        })
        .addNode(
          'step3',
          async () => {
            executionOrder.push('step3');
            return {};
          },
          { after: ['a', 'b'] }
        )
        .build();

      const executor = new WorkflowExecutor(mockCogitator);
      await executor.execute(workflow);

      expect(executionOrder.indexOf('step1')).toBe(0);
      expect(executionOrder.indexOf('step2')).toBe(1);
      expect(executionOrder.indexOf('a')).toBeGreaterThan(executionOrder.indexOf('step2'));
      expect(executionOrder.indexOf('b')).toBeGreaterThan(executionOrder.indexOf('step2'));
      expect(executionOrder.indexOf('step3')).toBe(executionOrder.length - 1);
    });
  });
});
