import type {
  WorkflowNode,
  WorkflowState,
  NodeResult,
  Tool,
  ToolContext,
} from '@cogitator-ai/types';

export interface ToolNodeOptions<S = WorkflowState, TArgs = unknown> {
  argsMapper: (state: S, input?: unknown) => TArgs;
  stateMapper?: (result: unknown) => Partial<S>;
  signal?: AbortSignal;
}

export function toolNode<S extends WorkflowState = WorkflowState, TArgs = unknown>(
  tool: Tool<TArgs, unknown>,
  options: ToolNodeOptions<S, TArgs>
): WorkflowNode<S> {
  return {
    name: tool.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const args = options.argsMapper(ctx.state, ctx.input);

      const toolContext: ToolContext = {
        agentId: `workflow:${ctx.workflowId}:${ctx.nodeId}`,
        runId: ctx.workflowId,
        signal: options.signal ?? new AbortController().signal,
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
