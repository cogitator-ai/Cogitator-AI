/**
 * ToolNode - Run a single tool as a workflow node
 */

import type {
  WorkflowNode,
  WorkflowState,
  NodeResult,
  Tool,
  ToolContext,
} from '@cogitator-ai/types';

export interface ToolNodeOptions<S = WorkflowState, TArgs = unknown> {
  /**
   * Map current state to tool arguments
   */
  argsMapper: (state: S, input?: unknown) => TArgs;

  /**
   * Map tool result to state updates
   */
  stateMapper?: (result: unknown) => Partial<S>;
}

/**
 * Create a workflow node that runs a single tool
 */
export function toolNode<
  S extends WorkflowState = WorkflowState,
  TArgs = unknown,
>(tool: Tool<TArgs, unknown>, options: ToolNodeOptions<S, TArgs>): WorkflowNode<S> {
  return {
    name: tool.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const args = options.argsMapper(ctx.state, ctx.input);

      const toolContext: ToolContext = {
        agentId: 'workflow',
        runId: ctx.workflowId,
        signal: new AbortController().signal,
      };

      const result = await tool.execute(args, toolContext);

      const stateUpdate = options.stateMapper?.(result);

      return {
        state: stateUpdate,
        output: result,
      };
    },
  };
}
