import type { WorkflowNode, WorkflowState, NodeResult, NodeContext } from '@cogitator-ai/types';

export type SimpleNodeFn<S, O = unknown> = (state: S, input?: unknown) => Promise<O>;

export type FullNodeFn<S> = (ctx: NodeContext<S>) => Promise<NodeResult<S>>;

export interface FunctionNodeOptions<S = WorkflowState> {
  stateMapper?: (output: unknown) => Partial<S>;
}

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

export function customNode<S extends WorkflowState = WorkflowState>(
  name: string,
  fn: FullNodeFn<S>
): WorkflowNode<S> {
  return {
    name,
    fn,
  };
}
