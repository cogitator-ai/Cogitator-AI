/**
 * AgentNode - Run a Cogitator agent as a workflow node
 */

import type { WorkflowNode, WorkflowState, NodeResult } from '@cogitator-ai/types';
import type { Agent, RunOptions, RunResult } from '@cogitator-ai/core';
import type { ExtendedNodeContext } from './base';

export interface AgentNodeOptions<S = WorkflowState> {
  /**
   * Map agent result to state updates
   */
  stateMapper?: (result: RunResult) => Partial<S>;

  /**
   * Map current state to agent input
   */
  inputMapper?: (state: S, input?: unknown) => string;

  /**
   * Additional run options for the agent
   */
  runOptions?: Partial<RunOptions>;
}

/**
 * Create a workflow node that runs a Cogitator agent
 */
export function agentNode<S extends WorkflowState = WorkflowState>(
  agent: Agent,
  options?: AgentNodeOptions<S>
): WorkflowNode<S> {
  return {
    name: agent.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const extCtx = ctx as ExtendedNodeContext<S>;

      let input: string;
      if (options?.inputMapper) {
        input = options.inputMapper(ctx.state, ctx.input);
      } else if (typeof ctx.input === 'string') {
        input = ctx.input;
      } else if (ctx.input !== undefined) {
        input = JSON.stringify(ctx.input);
      } else {
        input = JSON.stringify(ctx.state);
      }

      const result = await extCtx.cogitator.run(agent, {
        input,
        ...options?.runOptions,
      });

      const stateUpdate = options?.stateMapper?.(result);

      return {
        state: stateUpdate,
        output: result.output,
      };
    },
  };
}
