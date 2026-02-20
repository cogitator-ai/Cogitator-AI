import { describe, it, expect, beforeAll } from 'vitest';
import {
  WorkflowBuilder,
  WorkflowExecutor,
  InMemoryCheckpointStore,
} from '@cogitator-ai/workflows';
import { createTestCogitator, isOllamaRunning } from '../../helpers/setup';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

interface TestState {
  steps: string[];
  value: number;
  counter: number;
  branch: string;
}

const defaultState: TestState = {
  steps: [],
  value: 0,
  counter: 0,
  branch: '',
};

describeE2E('Workflows: DAG Execution', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  it('sequential nodes execute in order', async () => {
    const workflow = new WorkflowBuilder<TestState>('sequential')
      .initialState({ ...defaultState })
      .addNode('a', async (ctx) => ({
        state: { steps: [...ctx.state.steps, 'a'] },
      }))
      .addNode(
        'b',
        async (ctx) => ({
          state: { steps: [...ctx.state.steps, 'b'] },
        }),
        { after: ['a'] }
      )
      .addNode(
        'c',
        async (ctx) => ({
          state: { steps: [...ctx.state.steps, 'c'] },
        }),
        { after: ['b'] }
      )
      .build();

    const executor = new WorkflowExecutor(cogitator);
    const result = await executor.execute(workflow);

    expect(result.error).toBeUndefined();
    expect(result.state.steps).toEqual(['a', 'b', 'c']);
  });

  it('conditional branches to correct path', async () => {
    const workflow = new WorkflowBuilder<TestState>('conditional')
      .initialState({ ...defaultState })
      .addNode('check', async (ctx) => ({
        state: { value: ctx.state.value },
      }))
      .addConditional('branch', (state) => (state.value > 50 ? 'high' : 'low'), {
        after: ['check'],
      })
      .addNode(
        'high',
        async (ctx) => ({
          state: { branch: 'high', steps: [...ctx.state.steps, 'high'] },
        }),
        { after: ['branch'] }
      )
      .addNode(
        'low',
        async (ctx) => ({
          state: { branch: 'low', steps: [...ctx.state.steps, 'low'] },
        }),
        { after: ['branch'] }
      )
      .build();

    const executor = new WorkflowExecutor(cogitator);
    const result = await executor.execute(workflow, { value: 75 });

    expect(result.error).toBeUndefined();
    expect(result.state.branch).toBe('high');
  });

  it('parallel nodes execute concurrently', async () => {
    const startTimes: Record<string, number> = {};

    const workflow = new WorkflowBuilder<TestState>('parallel')
      .initialState({ ...defaultState })
      .addNode('start', async () => ({
        output: 'started',
      }))
      .addParallel('fan-out', ['task-a', 'task-b'], { after: ['start'] })
      .addNode('task-a', async () => {
        startTimes['task-a'] = Date.now();
        await new Promise((r) => setTimeout(r, 30));
        return { output: 'result-a' };
      })
      .addNode('task-b', async () => {
        startTimes['task-b'] = Date.now();
        await new Promise((r) => setTimeout(r, 30));
        return { output: 'result-b' };
      })
      .build();

    const executor = new WorkflowExecutor(cogitator);
    const result = await executor.execute(workflow);

    expect(result.error).toBeUndefined();
    expect(result.nodeResults.get('task-a')?.output).toBe('result-a');
    expect(result.nodeResults.get('task-b')?.output).toBe('result-b');

    const startDiff = Math.abs(startTimes['task-a'] - startTimes['task-b']);
    expect(startDiff).toBeLessThan(20);
  });

  it('loop exits after condition met', async () => {
    const workflow = new WorkflowBuilder<TestState>('loop')
      .initialState({ ...defaultState })
      .addNode('increment', async (ctx) => ({
        state: {
          counter: ctx.state.counter + 1,
          steps: [...ctx.state.steps, 'loop'],
        },
      }))
      .addLoop('check-loop', {
        condition: (state) => state.counter < 3,
        back: 'increment',
        exit: 'done',
        after: ['increment'],
      })
      .addNode('done', async (ctx) => ({
        state: { steps: [...ctx.state.steps, 'done'] },
      }))
      .build();

    const executor = new WorkflowExecutor(cogitator);
    const result = await executor.execute(workflow);

    expect(result.error).toBeUndefined();
    expect(result.state.counter).toBe(3);
    expect(result.state.steps.filter((s) => s === 'loop')).toHaveLength(3);
    expect(result.state.steps).toContain('done');
  });

  it('error in node propagates to result', async () => {
    const workflow = new WorkflowBuilder<TestState>('error-propagation')
      .initialState({ ...defaultState })
      .addNode('fail', async () => {
        throw new Error('intentional failure');
      })
      .build();

    const executor = new WorkflowExecutor(cogitator);
    const result = await executor.execute(workflow);

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('intentional');
  });

  it('checkpoint saves workflow state', async () => {
    const checkpointStore = new InMemoryCheckpointStore();

    const workflow = new WorkflowBuilder<TestState>('checkpoint-test')
      .initialState({ ...defaultState })
      .addNode('step-1', async (ctx) => ({
        state: { value: ctx.state.value + 1, steps: [...ctx.state.steps, 'step-1'] },
      }))
      .addNode(
        'step-2',
        async (ctx) => ({
          state: { value: ctx.state.value + 10, steps: [...ctx.state.steps, 'step-2'] },
        }),
        { after: ['step-1'] }
      )
      .build();

    const executor = new WorkflowExecutor(cogitator, checkpointStore);
    const result = await executor.execute(workflow, undefined, { checkpoint: true });

    expect(result.error).toBeUndefined();
    expect(result.checkpointId).toBeDefined();

    const checkpoints = await checkpointStore.list('checkpoint-test');
    expect(checkpoints.length).toBeGreaterThan(0);
  });
});
