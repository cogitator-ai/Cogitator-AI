import type { WorkflowNode, WorkflowState, NodeResult } from '@cogitator-ai/types';
import type { Agent, RunOptions, RunResult } from '@cogitator-ai/core';
import type { ExtendedNodeContext } from './base';

export interface AgentNodeOptions<S = WorkflowState> {
  stateMapper?: (result: RunResult) => Partial<S>;
  inputMapper?: (state: S, input?: unknown) => string;
  runOptions?: Partial<RunOptions>;
}

export function agentNode<S extends WorkflowState = WorkflowState>(
  agent: Agent,
  options?: AgentNodeOptions<S>
): WorkflowNode<S> {
  return {
    name: agent.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const extCtx = ctx as ExtendedNodeContext<S>;

      if (!extCtx.cogitator) {
        throw new Error(
          `agentNode "${agent.name}" requires a Cogitator instance in the node context`
        );
      }

      let input: string;
      if (options?.inputMapper) {
        input = options.inputMapper(ctx.state, ctx.input);
      } else if (typeof ctx.input === 'string') {
        input = ctx.input;
      } else if (ctx.input != null) {
        input = JSON.stringify(ctx.input);
      } else {
        input = JSON.stringify(ctx.state);
      }

      try {
        const result = await extCtx.cogitator.run(agent, {
          input,
          ...options?.runOptions,
        });

        const stateUpdate = options?.stateMapper?.(result);

        return {
          state: stateUpdate,
          output: result.output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `agentNode "${agent.name}" failed in workflow "${ctx.workflowId}", node "${ctx.nodeId}": ${message}`
        );
      }
    },
  };
}
