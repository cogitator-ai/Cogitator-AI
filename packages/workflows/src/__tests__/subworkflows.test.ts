import { describe, it, expect, vi } from 'vitest';
import { WorkflowBuilder } from '../index';
import {
  executeSubworkflow,
  subworkflowNode,
  simpleSubworkflow,
  nestedSubworkflow,
  MaxDepthExceededError,
  executeParallelSubworkflows,
  raceSubworkflows,
  fallbackSubworkflows,
  fanOutFanIn,
  scatterGather,
} from '../index';
import type { SubworkflowContext, SubworkflowConfig } from '../index';
import type { Cogitator } from '@cogitator-ai/core';

interface TestState {
  value: number;
  items?: string[];
}

interface ChildState {
  result: number;
}

const mockCogitator = {} as Cogitator;

function createContext(overrides: Partial<SubworkflowContext> = {}): SubworkflowContext {
  return {
    cogitator: mockCogitator,
    parentWorkflowId: 'parent-wf',
    parentRunId: 'parent-run',
    parentNodeId: 'parent-node',
    depth: 0,
    ...overrides,
  };
}

function buildChildWorkflow(multiplier = 10) {
  return new WorkflowBuilder<ChildState>('child')
    .initialState({ result: 0 })
    .addNode('compute', async (ctx) => ({
      state: { result: (ctx.state.result || 1) * multiplier },
    }))
    .build();
}

function buildPassthroughWorkflow() {
  return new WorkflowBuilder<TestState>('passthrough')
    .initialState({ value: 0 })
    .addNode('step', async (ctx) => ({
      state: { value: ctx.state.value + 1 },
    }))
    .build();
}

describe('Subworkflows', () => {
  describe('executeSubworkflow', () => {
    it('executes a child workflow and maps state', async () => {
      const childWorkflow = buildChildWorkflow();

      const config: SubworkflowConfig<TestState, ChildState> = {
        name: 'test-sub',
        workflow: childWorkflow,
        inputMapper: (parentState) => ({ result: parentState.value }),
        outputMapper: (childResult, parentState) => ({
          ...parentState,
          value: childResult.state.result,
        }),
      };

      const result = await executeSubworkflow({ value: 5 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.parentState.value).toBe(50);
      expect(result.childResult).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.depth).toBe(0);
    });

    it('skips execution when condition returns false', async () => {
      const childWorkflow = buildChildWorkflow();

      const config: SubworkflowConfig<TestState, ChildState> = {
        name: 'conditional',
        workflow: childWorkflow,
        inputMapper: (s) => ({ result: s.value }),
        outputMapper: (r, s) => ({ ...s, value: r.state.result }),
        condition: (state) => state.value > 100,
      };

      const result = await executeSubworkflow({ value: 5 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.parentState.value).toBe(5);
      expect(result.childResult).toBeUndefined();
    });

    it('calls onStart and onComplete callbacks', async () => {
      const onStart = vi.fn();
      const onComplete = vi.fn();
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'callbacks',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: (r) => r.state,
        onStart,
        onComplete,
      };

      await executeSubworkflow({ value: 0 }, config, createContext());

      expect(onStart).toHaveBeenCalledOnce();
      expect(onComplete).toHaveBeenCalledOnce();
    });

    it('propagates errors by default when outputMapper throws', async () => {
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'propagate',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: () => {
          throw new Error('mapper exploded');
        },
      };

      await expect(executeSubworkflow({ value: 1 }, config, createContext())).rejects.toThrow(
        'mapper exploded'
      );
    });

    it('catches errors with onError=catch', async () => {
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'catch',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: () => {
          throw new Error('mapper error');
        },
        onError: 'catch',
      };

      const result = await executeSubworkflow({ value: 1 }, config, createContext());

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toBe('mapper error');
      expect(result.parentState.value).toBe(1);
    });

    it('ignores errors with onError=ignore', async () => {
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'ignore',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: () => {
          throw new Error('ignored error');
        },
        onError: 'ignore',
      };

      const result = await executeSubworkflow({ value: 1 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.error).toBeDefined();
      expect(result.parentState.value).toBe(1);
    });

    it('calls onChildError on failure', async () => {
      const onChildError = vi.fn();
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'error-cb',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: () => {
          throw new Error('output fail');
        },
        onError: 'catch',
        onChildError,
      };

      await executeSubworkflow({ value: 0 }, config, createContext());

      expect(onChildError).toHaveBeenCalledOnce();
      expect(onChildError.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(onChildError.mock.calls[0][0].message).toBe('output fail');
    });

    it('retries on error with retry config', async () => {
      let attempts = 0;

      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'retry',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: (r) => {
          attempts++;
          if (attempts < 3) throw new Error('not yet');
          return r.state;
        },
        onError: 'retry',
        retryConfig: { maxAttempts: 3, delay: 10 },
      };

      const result = await executeSubworkflow({ value: 0 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.parentState.value).toBe(1);
      expect(attempts).toBe(3);
    });

    it('handles timeout via config.timeout', async () => {
      const slowWorkflow = new WorkflowBuilder<TestState>('slow')
        .initialState({ value: 0 })
        .addNode('slow-step', async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return { state: { value: 999 } };
        })
        .build();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'timeout-sub',
        workflow: slowWorkflow,
        inputMapper: (s) => s,
        outputMapper: (r) => r.state,
        timeout: 50,
        onError: 'catch',
      };

      const result = await executeSubworkflow({ value: 0 }, config, createContext());

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('timeout');
    });

    it('passes metadata to executor options', async () => {
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'metadata',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: (r) => r.state,
      };

      const ctx = createContext({
        metadata: { customKey: 'customValue' },
      });

      const result = await executeSubworkflow({ value: 0 }, config, ctx);
      expect(result.success).toBe(true);
    });

    it('runs condition when provided and passes when true', async () => {
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'cond-pass',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: (r) => r.state,
        condition: (state) => state.value > 0,
      };

      const result = await executeSubworkflow({ value: 5 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.parentState.value).toBe(6);
    });
  });

  describe('MaxDepthExceededError', () => {
    it('is thrown when depth exceeds maxDepth', async () => {
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'deep',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: (r) => r.state,
        maxDepth: 3,
      };

      const ctx = createContext({ depth: 4 });

      await expect(executeSubworkflow({ value: 0 }, config, ctx)).rejects.toThrow(
        MaxDepthExceededError
      );
    });

    it('stores depth and maxDepth on the error', () => {
      const err = new MaxDepthExceededError(5, 3);

      expect(err.depth).toBe(5);
      expect(err.maxDepth).toBe(3);
      expect(err.name).toBe('MaxDepthExceededError');
      expect(err.message).toContain('5');
      expect(err.message).toContain('3');
    });

    it('uses default maxDepth of 10', async () => {
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'default-depth',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: (r) => r.state,
      };

      await expect(
        executeSubworkflow({ value: 0 }, config, createContext({ depth: 11 }))
      ).rejects.toThrow(MaxDepthExceededError);

      const result = await executeSubworkflow({ value: 0 }, config, createContext({ depth: 9 }));
      expect(result.success).toBe(true);
    });

    it('depth equal to maxDepth is allowed', async () => {
      const childWorkflow = buildPassthroughWorkflow();

      const config: SubworkflowConfig<TestState, TestState> = {
        name: 'boundary',
        workflow: childWorkflow,
        inputMapper: (s) => s,
        outputMapper: (r) => r.state,
        maxDepth: 5,
      };

      const result = await executeSubworkflow({ value: 0 }, config, createContext({ depth: 5 }));
      expect(result.success).toBe(true);

      await expect(
        executeSubworkflow({ value: 0 }, config, createContext({ depth: 6 }))
      ).rejects.toThrow(MaxDepthExceededError);
    });
  });

  describe('subworkflowNode', () => {
    it('creates a SubworkflowConfig with the given name', () => {
      const childWorkflow = buildChildWorkflow();
      const inputMapper = (s: TestState) => ({ result: s.value });
      const outputMapper = (r: { state: ChildState }, s: TestState) => ({
        ...s,
        value: r.state.result,
      });

      const config = subworkflowNode<TestState, ChildState>('my-sub', {
        workflow: childWorkflow,
        inputMapper,
        outputMapper,
        maxDepth: 5,
      });

      expect(config.name).toBe('my-sub');
      expect(config.workflow).toBe(childWorkflow);
      expect(config.inputMapper).toBe(inputMapper);
      expect(config.outputMapper).toBe(outputMapper);
      expect(config.maxDepth).toBe(5);
    });

    it('preserves all optional fields', () => {
      const childWorkflow = buildChildWorkflow();
      const onStart = vi.fn();
      const condition = () => true;

      const config = subworkflowNode<TestState, ChildState>('full', {
        workflow: childWorkflow,
        inputMapper: () => ({ result: 0 }),
        outputMapper: (_r, s) => s,
        onError: 'retry',
        retryConfig: { maxAttempts: 2, delay: 100, backoff: 'exponential' },
        maxDepth: 7,
        timeout: 5000,
        shareCheckpoints: false,
        onStart,
        condition,
      });

      expect(config.onError).toBe('retry');
      expect(config.retryConfig).toEqual({ maxAttempts: 2, delay: 100, backoff: 'exponential' });
      expect(config.timeout).toBe(5000);
      expect(config.shareCheckpoints).toBe(false);
      expect(config.onStart).toBe(onStart);
      expect(config.condition).toBe(condition);
    });
  });

  describe('simpleSubworkflow', () => {
    it('passes state through with identity mappers', async () => {
      const childWorkflow = buildPassthroughWorkflow();
      const config = simpleSubworkflow('simple', childWorkflow);

      expect(config.name).toBe('simple');

      const result = await executeSubworkflow({ value: 10 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.parentState.value).toBe(11);
    });

    it('accepts additional options', () => {
      const childWorkflow = buildPassthroughWorkflow();
      const config = simpleSubworkflow('with-opts', childWorkflow, {
        maxDepth: 3,
        onError: 'catch',
      });

      expect(config.maxDepth).toBe(3);
      expect(config.onError).toBe('catch');
    });
  });

  describe('nestedSubworkflow', () => {
    interface ParentState {
      nested: ChildState;
      label: string;
    }

    it('extracts and maps a nested state key', async () => {
      const childWorkflow = buildChildWorkflow(2);
      const config = nestedSubworkflow<ParentState, 'nested', ChildState>(
        'nested-sub',
        childWorkflow,
        'nested'
      );

      expect(config.name).toBe('nested-sub');

      const parentState: ParentState = { nested: { result: 5 }, label: 'test' };
      const result = await executeSubworkflow(parentState, config, createContext());

      expect(result.success).toBe(true);
      expect(result.parentState.label).toBe('test');
      expect(result.parentState.nested.result).toBe(10);
    });

    it('tracks depth via context', async () => {
      const childWorkflow = buildChildWorkflow(1);
      const config = nestedSubworkflow<ParentState, 'nested', ChildState>(
        'depth-track',
        childWorkflow,
        'nested'
      );

      const parentState: ParentState = { nested: { result: 1 }, label: 'x' };
      const ctx = createContext({ depth: 7 });
      const result = await executeSubworkflow(parentState, config, ctx);

      expect(result.depth).toBe(7);
    });

    it('preserves other parent state keys on output', async () => {
      const childWorkflow = buildChildWorkflow(3);
      const config = nestedSubworkflow<ParentState, 'nested', ChildState>(
        'preserve',
        childWorkflow,
        'nested'
      );

      const parentState: ParentState = { nested: { result: 4 }, label: 'preserved' };
      const result = await executeSubworkflow(parentState, config, createContext());

      expect(result.parentState.label).toBe('preserved');
      expect(result.parentState.nested.result).toBe(12);
    });
  });

  describe('executeParallelSubworkflows', () => {
    it('runs multiple subworkflows concurrently', async () => {
      const wfA = buildPassthroughWorkflow();
      const wfB = buildPassthroughWorkflow();

      const result = await executeParallelSubworkflows(
        { value: 0 },
        {
          name: 'parallel',
          subworkflows: [
            {
              id: 'a',
              config: {
                name: 'sub-a',
                workflow: wfA,
                inputMapper: (s: TestState) => ({ value: s.value + 10 }),
                outputMapper: (_r, s) => s,
              },
            },
            {
              id: 'b',
              config: {
                name: 'sub-b',
                workflow: wfB,
                inputMapper: (s: TestState) => ({ value: s.value + 20 }),
                outputMapper: (_r, s) => s,
              },
            },
          ],
          aggregator: (results, state) => {
            let total = 0;
            for (const [, r] of results) {
              if (r.childResult) {
                total += (r.childResult.state as TestState).value;
              }
            }
            return { ...state, value: total };
          },
        },
        createContext()
      );

      expect(result.success).toBe(true);
      expect(result.stats.total).toBe(2);
      expect(result.stats.successful).toBe(2);
      expect(result.stats.failed).toBe(0);
      expect(result.parentState.value).toBe(11 + 21);
    });

    it('handles dynamic subworkflow definitions', async () => {
      const wf = buildPassthroughWorkflow();

      const result = await executeParallelSubworkflows(
        { value: 3 },
        {
          name: 'dynamic',
          subworkflows: (state) =>
            Array.from({ length: state.value }, (_, i) => ({
              id: `sub-${i}`,
              config: {
                name: `sub-${i}`,
                workflow: wf,
                inputMapper: () => ({ value: i }),
                outputMapper: (_r: { state: TestState }, s: TestState) => s,
              },
            })),
          aggregator: (_results, state) => state,
        },
        createContext()
      );

      expect(result.success).toBe(true);
      expect(result.stats.total).toBe(3);
    });

    it('continues on error when configured', async () => {
      const goodWf = buildPassthroughWorkflow();

      const result = await executeParallelSubworkflows(
        { value: 0 },
        {
          name: 'continue-error',
          subworkflows: [
            {
              id: 'good',
              config: {
                name: 'good-sub',
                workflow: goodWf,
                inputMapper: (s: TestState) => s,
                outputMapper: (_r, s) => s,
              },
            },
            {
              id: 'bad',
              config: {
                name: 'bad-sub',
                workflow: goodWf,
                inputMapper: (s: TestState) => s,
                outputMapper: () => {
                  throw new Error('bad output');
                },
                onError: 'propagate',
              },
            },
          ],
          continueOnError: true,
          aggregator: (results, state) => {
            let count = 0;
            for (const [, r] of results) {
              if (r.success) count++;
            }
            return { ...state, value: count };
          },
        },
        createContext()
      );

      expect(result.success).toBe(true);
      expect(result.errors.size).toBeGreaterThanOrEqual(1);
    });

    it('reports progress events', async () => {
      const wf = buildPassthroughWorkflow();
      const progressEvents: { completed: number; total: number }[] = [];

      await executeParallelSubworkflows(
        { value: 0 },
        {
          name: 'progress',
          subworkflows: [
            {
              id: 'a',
              config: {
                name: 'sub-a',
                workflow: wf,
                inputMapper: (s: TestState) => s,
                outputMapper: (_r, s) => s,
              },
            },
          ],
          aggregator: (_r, s) => s,
          onProgress: (p) => progressEvents.push({ completed: p.completed, total: p.total }),
        },
        createContext()
      );

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0].total).toBe(1);
    });

    it('increments depth for child subworkflows', async () => {
      const wf = buildPassthroughWorkflow();
      const depths: number[] = [];

      await executeParallelSubworkflows(
        { value: 0 },
        {
          name: 'depth-check',
          subworkflows: [
            {
              id: 'a',
              config: {
                name: 'sub-a',
                workflow: wf,
                inputMapper: (s: TestState) => s,
                outputMapper: (_r, s) => s,
              },
            },
          ],
          aggregator: (results, state) => {
            for (const [, r] of results) {
              depths.push(r.depth);
            }
            return state;
          },
        },
        createContext({ depth: 2 })
      );

      expect(depths[0]).toBe(3);
    });

    it('calls onSubworkflowStart and onSubworkflowComplete', async () => {
      const wf = buildPassthroughWorkflow();
      const started: string[] = [];
      const completed: string[] = [];

      await executeParallelSubworkflows(
        { value: 0 },
        {
          name: 'lifecycle',
          subworkflows: [
            {
              id: 'x',
              config: {
                name: 'sub-x',
                workflow: wf,
                inputMapper: (s: TestState) => s,
                outputMapper: (_r, s) => s,
              },
            },
          ],
          aggregator: (_r, s) => s,
          onSubworkflowStart: (id) => started.push(id),
          onSubworkflowComplete: (id) => completed.push(id),
        },
        createContext()
      );

      expect(started).toContain('x');
      expect(completed).toContain('x');
    });
  });

  describe('raceSubworkflows', () => {
    it('returns the first successful result', async () => {
      const fastWf = new WorkflowBuilder<TestState>('fast')
        .initialState({ value: 0 })
        .addNode('fast-step', async () => ({
          state: { value: 1 },
        }))
        .build();

      const slowWf = new WorkflowBuilder<TestState>('slow')
        .initialState({ value: 0 })
        .addNode('slow-step', async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { state: { value: 2 } };
        })
        .build();

      const configs: SubworkflowConfig<TestState, TestState>[] = [
        {
          name: 'fast',
          workflow: fastWf,
          inputMapper: (s) => s,
          outputMapper: (r) => r.state,
        },
        {
          name: 'slow',
          workflow: slowWf,
          inputMapper: (s) => s,
          outputMapper: (r) => r.state,
        },
      ];

      const result = await raceSubworkflows({ value: 0 }, configs, createContext());

      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.parentState.value).toBe(1);
    });

    it('returns null when all subworkflows produce unsuccessful results', async () => {
      const wf = buildPassthroughWorkflow();

      const configs: SubworkflowConfig<TestState, TestState>[] = [
        {
          name: 'skip-1',
          workflow: wf,
          inputMapper: (s) => s,
          outputMapper: (r) => r.state,
          condition: () => false,
        },
        {
          name: 'skip-2',
          workflow: wf,
          inputMapper: (s) => s,
          outputMapper: (r) => r.state,
          condition: () => false,
        },
      ];

      const result = await raceSubworkflows({ value: 0 }, configs, createContext());

      expect(result).toBeNull();
    });

    it('returns null when all subworkflows throw', async () => {
      const wf = buildPassthroughWorkflow();

      const configs: SubworkflowConfig<TestState, TestState>[] = [
        {
          name: 'fail-1',
          workflow: wf,
          inputMapper: (s) => s,
          outputMapper: () => {
            throw new Error('fail 1');
          },
        },
        {
          name: 'fail-2',
          workflow: wf,
          inputMapper: (s) => s,
          outputMapper: () => {
            throw new Error('fail 2');
          },
        },
      ];

      const result = await raceSubworkflows({ value: 0 }, configs, createContext());

      expect(result).toBeNull();
    });
  });

  describe('fallbackSubworkflows', () => {
    it('returns result from first successful workflow', async () => {
      const goodWf = buildPassthroughWorkflow();

      const configs: SubworkflowConfig<TestState, TestState>[] = [
        {
          name: 'primary',
          workflow: goodWf,
          inputMapper: (s) => ({ value: s.value + 100 }),
          outputMapper: (r) => r.state,
        },
        {
          name: 'fallback',
          workflow: goodWf,
          inputMapper: (s) => ({ value: s.value + 200 }),
          outputMapper: (r) => r.state,
        },
      ];

      const result = await fallbackSubworkflows({ value: 0 }, configs, createContext());

      expect(result.success).toBe(true);
      expect(result.parentState.value).toBe(101);
    });

    it('falls back to next workflow when first throws', async () => {
      const goodWf = buildPassthroughWorkflow();

      const configs: SubworkflowConfig<TestState, TestState>[] = [
        {
          name: 'primary',
          workflow: goodWf,
          inputMapper: (s) => s,
          outputMapper: () => {
            throw new Error('primary failed');
          },
        },
        {
          name: 'fallback',
          workflow: goodWf,
          inputMapper: (s) => ({ value: s.value + 50 }),
          outputMapper: (r) => r.state,
        },
      ];

      const result = await fallbackSubworkflows({ value: 0 }, configs, createContext());

      expect(result.success).toBe(true);
      expect(result.parentState.value).toBe(51);
    });

    it('skips workflows that are skipped (condition=false) and continues', async () => {
      const wf = buildPassthroughWorkflow();

      const configs: SubworkflowConfig<TestState, TestState>[] = [
        {
          name: 'skip-me',
          workflow: wf,
          inputMapper: (s) => s,
          outputMapper: (r) => r.state,
          condition: () => false,
        },
        {
          name: 'run-me',
          workflow: wf,
          inputMapper: (s) => ({ value: s.value + 10 }),
          outputMapper: (r) => r.state,
        },
      ];

      const result = await fallbackSubworkflows({ value: 0 }, configs, createContext());

      expect(result.success).toBe(true);
      expect(result.parentState.value).toBe(11);
    });

    it('throws when all subworkflows throw', async () => {
      const wf = buildPassthroughWorkflow();

      const configs: SubworkflowConfig<TestState, TestState>[] = [
        {
          name: 'a',
          workflow: wf,
          inputMapper: (s) => s,
          outputMapper: () => {
            throw new Error('a failed');
          },
        },
        {
          name: 'b',
          workflow: wf,
          inputMapper: (s) => s,
          outputMapper: () => {
            throw new Error('b failed');
          },
        },
      ];

      await expect(fallbackSubworkflows({ value: 0 }, configs, createContext())).rejects.toThrow(
        'b failed'
      );
    });
  });

  describe('fanOutFanIn', () => {
    it('fans out to multiple inputs and aggregates results', async () => {
      const childWf = new WorkflowBuilder<{ result: number }>('fan-child')
        .initialState({ result: 0 })
        .addNode('double', async (ctx) => ({
          state: { result: ctx.state.result * 2 },
        }))
        .build();

      const config = fanOutFanIn<TestState, { result: number }>('fan-test', {
        workflow: childWf,
        getInputs: (state) =>
          (state.items ?? []).map((item, i) => ({
            id: `item-${i}`,
            input: { result: parseInt(item) },
          })),
        aggregator: (results, state) => {
          let sum = 0;
          for (const [, r] of results) {
            sum += r.state.result;
          }
          return { ...state, value: sum };
        },
      });

      const parentState: TestState = { value: 0, items: ['3', '5', '7'] };
      const result = await executeParallelSubworkflows(parentState, config, createContext());

      expect(result.success).toBe(true);
      expect(result.parentState.value).toBe(6 + 10 + 14);
      expect(result.stats.total).toBe(3);
    });

    it('returns empty results when no inputs', async () => {
      const childWf = buildChildWorkflow();

      const config = fanOutFanIn<TestState, ChildState>('empty-fan', {
        workflow: childWf,
        getInputs: () => [],
        aggregator: (_results, state) => state,
      });

      const result = await executeParallelSubworkflows({ value: 99 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.stats.total).toBe(0);
      expect(result.parentState.value).toBe(99);
    });

    it('respects concurrency setting', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const slowWf = new WorkflowBuilder<{ result: number }>('slow-fan')
        .initialState({ result: 0 })
        .addNode('work', async (ctx) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { state: { result: ctx.state.result } };
        })
        .build();

      const config = fanOutFanIn<TestState, { result: number }>('conc-fan', {
        workflow: slowWf,
        getInputs: () => [
          { id: 'a', input: { result: 1 } },
          { id: 'b', input: { result: 2 } },
          { id: 'c', input: { result: 3 } },
          { id: 'd', input: { result: 4 } },
        ],
        aggregator: (_r, state) => state,
        concurrency: 2,
      });

      await executeParallelSubworkflows({ value: 0 }, config, createContext());

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('scatterGather', () => {
    it('scatters work across multiple workflows and gathers results', async () => {
      const addWf = new WorkflowBuilder<{ result: number }>('adder')
        .initialState({ result: 0 })
        .addNode('add', async (ctx) => ({
          state: { result: ctx.state.result + 100 },
        }))
        .build();

      const mulWf = new WorkflowBuilder<{ result: number }>('multiplier')
        .initialState({ result: 0 })
        .addNode('mul', async (ctx) => ({
          state: { result: ctx.state.result * 3 },
        }))
        .build();

      const workflows = new Map([
        ['adder', addWf],
        ['multiplier', mulWf],
      ]);

      const config = scatterGather<TestState, { result: number }>('scatter-test', {
        workflows,
        inputMapper: (state) => ({ result: state.value }),
        outputMapper: (results, state) => {
          let sum = 0;
          for (const [, r] of results) {
            sum += r.state.result;
          }
          return { ...state, value: sum };
        },
      });

      const result = await executeParallelSubworkflows({ value: 5 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.parentState.value).toBe(105 + 15);
      expect(result.stats.total).toBe(2);
    });

    it('provides workflowId to inputMapper', async () => {
      const wf = new WorkflowBuilder<{ result: number }>('scatter-wf')
        .initialState({ result: 0 })
        .addNode('pass', async (ctx) => ({
          state: { result: ctx.state.result },
        }))
        .build();

      const receivedIds: string[] = [];

      const workflows = new Map([
        ['alpha', wf],
        ['beta', wf],
      ]);

      const config = scatterGather<TestState, { result: number }>('id-test', {
        workflows,
        inputMapper: (state, workflowId) => {
          receivedIds.push(workflowId);
          return { result: state.value };
        },
        outputMapper: (_r, state) => state,
      });

      await executeParallelSubworkflows({ value: 0 }, config, createContext());

      expect(receivedIds).toContain('alpha');
      expect(receivedIds).toContain('beta');
    });

    it('handles partial failures with continueOnError=true', async () => {
      const goodWf = new WorkflowBuilder<{ result: number }>('good-scatter')
        .initialState({ result: 0 })
        .addNode('ok', async (ctx) => ({
          state: { result: ctx.state.result + 1 },
        }))
        .build();

      const badWf = new WorkflowBuilder<{ result: number }>('bad-scatter')
        .initialState({ result: 0 })
        .addNode('fail', async () => {
          throw new Error('scatter fail');
        })
        .build();

      const workflows = new Map([
        ['good', goodWf],
        ['bad', badWf],
      ]);

      const config = scatterGather<TestState, { result: number }>('scatter-partial', {
        workflows,
        inputMapper: (state) => ({ result: state.value }),
        outputMapper: (results, state) => {
          let sum = 0;
          for (const [, r] of results) {
            sum += r.state.result;
          }
          return { ...state, value: sum };
        },
      });

      const result = await executeParallelSubworkflows({ value: 5 }, config, createContext());

      expect(result.success).toBe(true);
      expect(result.stats.total).toBe(2);
    });
  });
});
