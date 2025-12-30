import { describe, it, expect } from 'vitest';
import { WorkflowBuilder } from '../builder.js';

interface TestState {
  value: number;
  result?: string;
}

describe('WorkflowBuilder', () => {
  describe('basic construction', () => {
    it('creates a simple workflow with one node', () => {
      const workflow = new WorkflowBuilder<TestState>('test-workflow')
        .initialState({ value: 0 })
        .addNode('start', async (ctx) => ({
          state: { value: ctx.state.value + 1 },
        }))
        .build();

      expect(workflow.name).toBe('test-workflow');
      expect(workflow.initialState).toEqual({ value: 0 });
      expect(workflow.nodes.size).toBe(1);
      expect(workflow.entryPoint).toBe('start');
    });

    it('creates workflow with sequential nodes', () => {
      const workflow = new WorkflowBuilder<TestState>('sequential')
        .initialState({ value: 0 })
        .addNode('first', async () => ({ state: { value: 1 } }))
        .addNode('second', async () => ({ state: { value: 2 } }), {
          after: ['first'],
        })
        .addNode('third', async () => ({ state: { value: 3 } }), {
          after: ['second'],
        })
        .build();

      expect(workflow.nodes.size).toBe(3);
      expect(workflow.edges.length).toBe(2);
      expect(workflow.entryPoint).toBe('first');
    });

    it('handles multiple dependencies', () => {
      const workflow = new WorkflowBuilder<TestState>('fan-in')
        .initialState({ value: 0 })
        .addNode('a', async () => ({ output: 'a' }))
        .addNode('b', async () => ({ output: 'b' }))
        .addNode('merge', async () => ({ output: 'merged' }), {
          after: ['a', 'b'],
        })
        .build();

      expect(workflow.nodes.size).toBe(3);
      // Should have 2 edges: a->merge and b->merge
      expect(workflow.edges.filter((e) => e.type === 'sequential').length).toBe(2);
    });
  });

  describe('conditional routing', () => {
    it('creates conditional edges', () => {
      const workflow = new WorkflowBuilder<TestState>('conditional')
        .initialState({ value: 0 })
        .addNode('start', async () => ({ state: { value: 10 } }))
        .addConditional(
          'router',
          (state) => (state.value > 5 ? 'high' : 'low'),
          { after: ['start'] }
        )
        .addNode('high', async () => ({ output: 'high path' }), {
          after: ['router'],
        })
        .addNode('low', async () => ({ output: 'low path' }), {
          after: ['router'],
        })
        .build();

      expect(workflow.nodes.size).toBe(4); // start, router, high, low
      const conditionalEdge = workflow.edges.find(
        (e) => e.type === 'conditional'
      );
      expect(conditionalEdge).toBeDefined();
      if (conditionalEdge?.type === 'conditional') {
        expect(conditionalEdge.targets).toContain('high');
        expect(conditionalEdge.targets).toContain('low');
      }
    });
  });

  describe('loop support', () => {
    it('creates loop edges', () => {
      const workflow = new WorkflowBuilder<TestState>('loop')
        .initialState({ value: 0 })
        .addNode('process', async (ctx) => ({
          state: { value: ctx.state.value + 1 },
        }))
        .addLoop('check', {
          condition: (state: TestState) => state.value < 5,
          back: 'process',
          exit: 'done',
          after: ['process'],
        })
        .addNode('done', async () => ({ output: 'complete' }))
        .build();

      const loopEdge = workflow.edges.find((e) => e.type === 'loop');
      expect(loopEdge).toBeDefined();
      if (loopEdge?.type === 'loop') {
        expect(loopEdge.back).toBe('process');
        expect(loopEdge.exit).toBe('done');
      }
    });
  });

  describe('validation', () => {
    it('throws error for empty workflow', () => {
      const builder = new WorkflowBuilder('empty').initialState({});

      expect(() => builder.build()).toThrow('Workflow has no nodes');
    });

    it('throws error for invalid entry point', () => {
      const builder = new WorkflowBuilder('invalid')
        .initialState({})
        .addNode('start', async () => ({}))
        .entryPoint('nonexistent');

      expect(() => builder.build()).toThrow("Entry point 'nonexistent' not found");
    });

    it('throws error for invalid edge reference', () => {
      const builder = new WorkflowBuilder('invalid-edge')
        .initialState({})
        .addNode('start', async () => ({}), { after: ['nonexistent'] });

      expect(() => builder.build()).toThrow("references unknown node 'nonexistent'");
    });
  });

  describe('entry point detection', () => {
    it('auto-detects entry point from root nodes', () => {
      const workflow = new WorkflowBuilder('auto-entry')
        .initialState({})
        .addNode('root1', async () => ({}))
        .addNode('child', async () => ({}), { after: ['root1'] })
        .build();

      expect(workflow.entryPoint).toBe('root1');
    });

    it('uses explicit entry point', () => {
      const workflow = new WorkflowBuilder('explicit-entry')
        .initialState({})
        .addNode('first', async () => ({}))
        .addNode('second', async () => ({}))
        .entryPoint('second')
        .build();

      expect(workflow.entryPoint).toBe('second');
    });
  });
});
