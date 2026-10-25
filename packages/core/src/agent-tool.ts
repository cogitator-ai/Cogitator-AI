import type {
  DelegationApprovalMode,
  DelegationHooks,
  DelegationMessages,
  RunOptions,
  Tool,
  ToolContext,
} from '@cogitator-ai/types';
import type { Agent } from './agent';
import type { Cogitator } from './runtime';
import { tool } from './tool';
import { z } from 'zod';
import { isTripwire } from './middleware/tripwire';
import { isDelegatePause, pausedDelegateError, runDelegate } from './subagents/delegate';

export interface AgentAsToolOptions extends DelegationHooks {
  name: string;
  description: string;
  timeout?: number;
  includeUsage?: boolean;
  includeToolCalls?: boolean;
  /**
   * Decides the calls of the inner agent that need approval in `decline` mode. Without it, or
   * when it answers `'pause'`, they are declined, and the inner agent is told why and answers
   * accordingly.
   */
  onApproval?: RunOptions['onApproval'];
  /**
   * What happens to the approvals and questions the inner agent stops at: `decline` (default)
   * answers them no as above, `bubble` hands its approvals to the calling run's `onApproval` and
   * pauses the calling run when the inner one pauses, so a resume of the calling run answers
   * them (their ids start with the tool call's id and `/`) and the inner run goes on
   */
  approvalMode?: DelegationApprovalMode;
  /** Which messages of the calling run the inner agent reads before its task (default `none`) */
  messages?: DelegationMessages;
}

export interface AgentToolResult {
  output: string;
  success: boolean;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
  };
  toolCalls?: Array<{ name: string; arguments: unknown }>;
}

const DEFAULT_SCHEMA = z.object({
  task: z.string().describe('The task to delegate to the agent'),
});

/**
 * The agent as a tool another agent calls with a task. The inner run gets the caller's signal,
 * user, deps, permission mode and `session` rules (so a caller in `plan` mode delegates no edits,
 * and its deny rules hold for the delegate) and, unless the inner agent has a workspace of its
 * own, the caller's workspace. Its calls go through the same permission decision as the caller's,
 * the settings files of the runtime included. Its approvals are declined unless `onApproval`
 * decides them, or bubble up to the calling run with `approvalMode: 'bubble'`.
 */
export function agentAsTool<TDeps = unknown>(
  cogitator: Cogitator,
  agent: Agent<TDeps>,
  options: AgentAsToolOptions
): Tool<{ task: string }, AgentToolResult, TDeps> {
  const delegate: Agent = agent;
  const {
    name,
    description,
    timeout,
    includeUsage = false,
    includeToolCalls = false,
    onApproval,
  } = options;

  return tool<{ task: string }, AgentToolResult, TDeps>({
    name,
    description,
    parameters: DEFAULT_SCHEMA,
    timeout,
    sideEffects: ['external'],
    access: { kind: 'agent', agent: agent.name },

    execute: async (
      params: { task: string },
      context: ToolContext<TDeps>
    ): Promise<AgentToolResult> => {
      try {
        const result = await runDelegate(
          cogitator,
          {
            agent: delegate,
            task: params.task,
            approvalMode: options.approvalMode ?? 'decline',
            ...(onApproval && { onApproval }),
            ...(options.messages !== undefined && { messages: options.messages }),
            ...(timeout !== undefined && { timeout }),
            ...(options.onDelegationStart && { onDelegationStart: options.onDelegationStart }),
            ...(options.onDelegationComplete && {
              onDelegationComplete: options.onDelegationComplete,
            }),
          },
          context
        );

        if (result.status === 'paused') {
          return { output: result.output, success: false, error: pausedDelegateError(result) };
        }

        return {
          output: result.output,
          success: true,
          ...(includeUsage && { usage: { ...result.usage } }),
          ...(includeToolCalls && {
            toolCalls: result.toolCalls.map((tc) => ({
              name: tc.name,
              arguments: tc.arguments,
            })),
          }),
        };
      } catch (error) {
        if (isTripwire(error) || isDelegatePause(error)) throw error;
        return {
          output: '',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
