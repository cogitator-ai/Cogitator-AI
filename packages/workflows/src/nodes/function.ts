/**
 * FunctionNode - Run a custom function as a workflow node
 */

import type {
  WorkflowNode,
  WorkflowState,
  NodeResult,
  NodeContext,
} from '@cogitator-ai/types';

/**
 * Simple function that takes state and returns output
 */
export type SimpleNodeFn<S, O = unknown> = (state: S, input?: unknown) => Promise<O>;

/**
 * Full function that receives context and returns result
 */
export type FullNodeFn<S> = (ctx: NodeContext<S>) => Promise<NodeResult<S>>;

export interface FunctionNodeOptions<S = WorkflowState> {
  /**
   * Map function output to state updates
   */
  stateMapper?: (output: unknown) => Partial<S>;
}

/**
 * Create a workflow node from a simple async function
 */
export function functionNode<S extends WorkflowState = WorkflowState, O = unknown>(
  name: string,
  fn: SimpleNodeFn<S, O>,
  options?: FunctionNodeOptions<S>
): WorkflowNode<S> {
  return {
    name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const output = await fn(ctx.state, ctx.input);
      const stateUpdate = options?.stateMapper?.(output);

      return {
        state: stateUpdate,
        output,
      };
    },
  };
}

/**
 * Create a workflow node from a full node function
 */
export function customNode<S extends WorkflowState = WorkflowState>(
  name: string,
  fn: FullNodeFn<S>
): WorkflowNode<S> {
  return {
    name,
    fn,
  };
}
