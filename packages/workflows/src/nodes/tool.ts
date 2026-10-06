import type { WorkflowNode, WorkflowState, NodeResult, Tool } from '@cogitator-ai/types';
import type { ExtendedNodeContext } from './base';
import { askToolApproval, type NodeApprovalOptions } from './approvals';

export interface ToolNodeOptions<S = WorkflowState, TArgs = unknown> {
  argsMapper: (state: S, input?: unknown) => TArgs;
  stateMapper?: (result: unknown) => Partial<S>;
  signal?: AbortSignal;
  /**
   * Where a call of a tool that needs approval is asked. By default (and with an object) it
   * becomes a request in the workflow's approval store and the tool runs once it is approved.
   * `false`, or no approval store at all, fails the node without running the tool.
   */
  approvals?: NodeApprovalOptions | false;
}

/**
 * Run one tool as a workflow step, the way an agent run calls it: through the node context's
 * `cogitator.invokeTool`, so the mapped arguments are validated against the tool's schema, a call
 * that needs approval is asked for (see `approvals`), the guardrails apply, a sandboxed tool runs
 * in the sandbox and `tool.timeout` is kept. A call that fails, or is declined, fails the node.
 */
export function toolNode<S extends WorkflowState = WorkflowState, TArgs = unknown>(
  tool: Tool<TArgs, unknown>,
  options: ToolNodeOptions<S, TArgs>
): WorkflowNode<S> {
  return {
    name: tool.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const extCtx = ctx as Partial<ExtendedNodeContext<S>> & typeof ctx;
      const cogitator = extCtx.cogitator;
      if (!cogitator) {
        throw new Error(
          `toolNode "${tool.name}" requires a Cogitator instance in the node context`
        );
      }

      const args = options.argsMapper(ctx.state, ctx.input);
      const signal = options.signal ?? extCtx.signal;
      const invocation = await cogitator.invokeTool(tool as Tool, args, {
        agentId: `workflow:${ctx.workflowId}:${ctx.nodeId}`,
        runId: ctx.workflowId,
        ...(signal && { signal }),
        onApproval: async (request) =>
          (await askToolApproval(
            request,
            `workflow node "${ctx.nodeId}"`,
            options.approvals,
            extCtx as ExtendedNodeContext<S>
          )) ?? 'pause',
      });

      if (invocation.error !== undefined) {
        throw new Error(
          `toolNode "${tool.name}" failed in workflow "${ctx.workflowId}", node "${ctx.nodeId}": ${invocation.error}`
        );
      }

      return {
        state: options.stateMapper?.(invocation.result),
        output: invocation.result,
      };
    },
  };
}
