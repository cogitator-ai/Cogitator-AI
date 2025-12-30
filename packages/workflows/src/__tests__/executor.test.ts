import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../executor.js';
import { WorkflowBuilder } from '../builder.js';
import { InMemoryCheckpointStore } from '../checkpoint.js';
import type { Cogitator } from '@cogitator/core';

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
        .addConditional(
          'router',
          (state: TestState) => (state.value > 5 ? 'high' : 'low'),
          { after: ['start'] }
        )
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
      expect(onNodeComplete).toHaveBeenCalledWith(
        'step1',
        'result1',
        expect.any(Number)
      );
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
});
