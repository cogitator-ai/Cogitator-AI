import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../executor';
import { WorkflowBuilder } from '../builder';
import type { Cogitator } from '@cogitator-ai/core';
import type { StreamingWorkflowEvent } from '@cogitator-ai/types';

interface TestState {
  value: number;
  steps: string[];
}

const mockCogitator = {} as Cogitator;

describe('WorkflowExecutor streaming', () => {
  it('emits workflow_started as first event', async () => {
    const workflow = new WorkflowBuilder<TestState>('streaming-test')
      .initialState({ value: 0, steps: [] })
      .addNode('step1', async () => ({ output: 'done' }))
      .build();

    const executor = new WorkflowExecutor(mockCogitator);
    const events: StreamingWorkflowEvent[] = [];

    for await (const event of executor.stream(workflow)) {
      events.push(event);
    }

    expect(events[0].type).toBe('workflow_started');
    expect(events[0]).toMatchObject({
      type: 'workflow_started',
      workflowName: 'streaming-test',
    });
    expect((events[0] as { workflowId: string }).workflowId).toMatch(/^wf_/);
  });

  it('emits node_started and node_completed events', async () => {
    const workflow = new WorkflowBuilder<TestState>('node-events')
      .initialState({ value: 0, steps: [] })
      .addNode('step1', async () => ({ output: 'result1' }))
      .build();

    const executor = new WorkflowExecutor(mockCogitator);
    const events: StreamingWorkflowEvent[] = [];

    for await (const event of executor.stream(workflow)) {
      events.push(event);
    }

    const nodeStarted = events.find((e) => e.type === 'node_started');
    const nodeCompleted = events.find((e) => e.type === 'node_completed');

    expect(nodeStarted).toMatchObject({
      type: 'node_started',
      nodeName: 'step1',
    });

    expect(nodeCompleted).toMatchObject({
      type: 'node_completed',
      nodeName: 'step1',
      output: 'result1',
    });
  });

  it('emits node_progress events when reportProgress is called', async () => {
    const workflow = new WorkflowBuilder<TestState>('progress-test')
      .initialState({ value: 0, steps: [] })
      .addNode('progressive', async (ctx) => {
        ctx.reportProgress?.(25);
        ctx.reportProgress?.(50);
        ctx.reportProgress?.(75);
        ctx.reportProgress?.(100);
        return { output: 'done' };
      })
      .build();

    const executor = new WorkflowExecutor(mockCogitator);
    const events: StreamingWorkflowEvent[] = [];

    for await (const event of executor.stream(workflow)) {
      events.push(event);
    }

    const progressEvents = events.filter((e) => e.type === 'node_progress');
    expect(progressEvents).toHaveLength(4);
    expect(progressEvents.map((e) => (e as { progress: number }).progress)).toEqual([
      25, 50, 75, 100,
    ]);
  });

  it('clamps progress values to 0-100', async () => {
    const workflow = new WorkflowBuilder<TestState>('clamp-test')
      .initialState({ value: 0, steps: [] })
      .addNode('clamped', async (ctx) => {
        ctx.reportProgress?.(-10);
        ctx.reportProgress?.(150);
        return { output: 'done' };
      })
      .build();

    const executor = new WorkflowExecutor(mockCogitator);
    const events: StreamingWorkflowEvent[] = [];

    for await (const event of executor.stream(workflow)) {
      events.push(event);
    }

    const progressEvents = events.filter((e) => e.type === 'node_progress');
    expect(progressEvents.map((e) => (e as { progress: number }).progress)).toEqual([0, 100]);
  });

  it('emits workflow_completed as last event with result', async () => {
    const workflow = new WorkflowBuilder<TestState>('complete-test')
      .initialState({ value: 0, steps: [] })
      .addNode('step1', async () => ({ state: { value: 42 } }))
      .build();

    const executor = new WorkflowExecutor(mockCogitator);
    const events: StreamingWorkflowEvent[] = [];

    for await (const event of executor.stream(workflow)) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('workflow_completed');
    expect(lastEvent).toMatchObject({
      type: 'workflow_completed',
    });

    const completed = lastEvent as {
      type: 'workflow_completed';
      workflowId: string;
      result: { state: TestState };
      duration: number;
    };
    expect(completed.result.state.value).toBe(42);
    expect(completed.duration).toBeGreaterThanOrEqual(0);
  });

  it('emits events in correct order', async () => {
    const workflow = new WorkflowBuilder<TestState>('order-test')
      .initialState({ value: 0, steps: [] })
      .addNode('step1', async (ctx) => {
        ctx.reportProgress?.(50);
        return { output: 'done' };
      })
      .build();

    const executor = new WorkflowExecutor(mockCogitator);
    const eventTypes: string[] = [];

    for await (const event of executor.stream(workflow)) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toEqual([
      'workflow_started',
      'node_started',
      'node_progress',
      'node_completed',
      'workflow_completed',
    ]);
  });

  it('emits node_error event on failure', async () => {
    const workflow = new WorkflowBuilder<TestState>('error-test')
      .initialState({ value: 0, steps: [] })
      .addNode('failing', async () => {
        throw new Error('Test error');
      })
      .build();

    const executor = new WorkflowExecutor(mockCogitator);
    const events: StreamingWorkflowEvent[] = [];

    for await (const event of executor.stream(workflow)) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === 'node_error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent).toMatchObject({
      type: 'node_error',
      nodeName: 'failing',
    });
    expect((errorEvent as { error: Error }).error.message).toBe('Test error');
  });

  it('calls onNodeProgress callback in execute()', async () => {
    const workflow = new WorkflowBuilder<TestState>('callback-test')
      .initialState({ value: 0, steps: [] })
      .addNode('progressive', async (ctx) => {
        ctx.reportProgress?.(25);
        ctx.reportProgress?.(75);
        return {};
      })
      .build();

    const onNodeProgress = vi.fn();
    const executor = new WorkflowExecutor(mockCogitator);

    await executor.execute(workflow, undefined, { onNodeProgress });

    expect(onNodeProgress).toHaveBeenCalledTimes(2);
    expect(onNodeProgress).toHaveBeenCalledWith('progressive', 25);
    expect(onNodeProgress).toHaveBeenCalledWith('progressive', 75);
  });

  it('handles multiple nodes with progress', async () => {
    const workflow = new WorkflowBuilder<TestState>('multi-progress')
      .initialState({ value: 0, steps: [] })
      .addNode('step1', async (ctx) => {
        ctx.reportProgress?.(50);
        ctx.reportProgress?.(100);
        return {};
      })
      .addNode(
        'step2',
        async (ctx) => {
          ctx.reportProgress?.(33);
          ctx.reportProgress?.(66);
          ctx.reportProgress?.(100);
          return {};
        },
        { after: ['step1'] }
      )
      .build();

    const executor = new WorkflowExecutor(mockCogitator);
    const events: StreamingWorkflowEvent[] = [];

    for await (const event of executor.stream(workflow)) {
      events.push(event);
    }

    const progressEvents = events.filter((e) => e.type === 'node_progress');
    expect(progressEvents).toHaveLength(5);

    const step1Progress = progressEvents.filter(
      (e) => (e as { nodeName: string }).nodeName === 'step1'
    );
    const step2Progress = progressEvents.filter(
      (e) => (e as { nodeName: string }).nodeName === 'step2'
    );

    expect(step1Progress).toHaveLength(2);
    expect(step2Progress).toHaveLength(3);
  });
});
