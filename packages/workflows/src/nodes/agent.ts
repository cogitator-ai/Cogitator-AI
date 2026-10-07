import type {
  NodeResult,
  ResumeOptions,
  ToolApprovalDecision,
  ToolApprovalRequest,
  WorkflowNode,
  WorkflowState,
} from '@cogitator-ai/types';
import {
  AgentRunPausedError,
  isPausedRun,
  type Agent,
  type RunOptions,
  type RunResult,
} from '@cogitator-ai/core';
import type { ExtendedNodeContext } from './base';
import { askToolApproval, type NodeApprovalOptions } from './approvals';

export interface AgentNodeOptions<S = WorkflowState> {
  stateMapper?: (result: RunResult) => Partial<S>;
  inputMapper?: (state: S, input?: unknown) => string;
  runOptions?: Partial<RunOptions>;
  /**
   * Tool calls that need approval while the node runs. By default (and with an object) each
   * waiting call becomes a request in the workflow's approval store, and the run goes on once it
   * is answered. `false`, or no approval store at all, fails the node with an
   * `AgentRunPausedError` that holds the checkpoint to resume the run with. An `onApproval` in
   * `runOptions` decides calls before they ever pause.
   */
  approvals?: NodeApprovalOptions | false;
}

function resumeOptions(runOptions: Partial<RunOptions> | undefined): ResumeOptions {
  const {
    input: _input,
    images: _images,
    audio: _audio,
    context: _context,
    threadId: _threadId,
    threadAccess: _threadAccess,
    ...rest
  } = runOptions ?? {};
  return rest;
}

/**
 * Run an agent as a workflow step. Its answer is the node's output; `stateMapper` copies what
 * the next steps need into the state. A run that pauses for tool approvals never passes as an
 * answer: the node asks for the calls through the approval store and waits, or fails with an
 * `AgentRunPausedError` (see `approvals`).
 */
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

      const where = `workflow "${ctx.workflowId}", node "${ctx.nodeId}"`;
      const askApprovals = async (
        pending: readonly ToolApprovalRequest[]
      ): Promise<Record<string, ToolApprovalDecision> | undefined> => {
        const answers = await Promise.all(
          pending.map(async (request) => {
            const decision = await askToolApproval(request, agent.name, options?.approvals, extCtx);
            return decision && ([request.toolCallId, decision] as const);
          })
        );
        const decisions: Record<string, ToolApprovalDecision> = {};
        for (const answer of answers) {
          if (!answer) return undefined;
          decisions[answer[0]] = answer[1];
        }
        return decisions;
      };

      try {
        let result = await extCtx.cogitator.run(agent, {
          input,
          ...(extCtx.signal && { signal: extCtx.signal }),
          ...options?.runOptions,
        });

        while (isPausedRun(result)) {
          const decisions = await askApprovals(result.pendingApprovals);
          if (!decisions || !result.checkpoint) {
            throw new AgentRunPausedError(result, agent.name, where);
          }
          result = await extCtx.cogitator.resume(agent, result.checkpoint, {
            ...(extCtx.signal && { signal: extCtx.signal }),
            ...resumeOptions(options?.runOptions),
            decisions,
          });
        }

        const stateUpdate = options?.stateMapper?.(result);

        return {
          state: stateUpdate,
          output: result.output,
        };
      } catch (error) {
        if (error instanceof AgentRunPausedError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`agentNode "${agent.name}" failed in ${where}: ${message}`, {
          cause: error,
        });
      }
    },
  };
}
