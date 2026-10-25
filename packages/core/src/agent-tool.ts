import type { RunOptions, Tool, ToolApprovalDecision, ToolContext } from '@cogitator-ai/types';
import type { Agent } from './agent';
import type { Cogitator } from './runtime';
import { tool } from './tool';
import { z } from 'zod';
import { isTripwire } from './middleware/tripwire';
import { pendingQuestions } from './run-pause';

export interface AgentAsToolOptions {
  name: string;
  description: string;
  timeout?: number;
  includeUsage?: boolean;
  includeToolCalls?: boolean;
  /**
   * Decides the calls of the inner agent that need approval. Without it — or
   * when it answers `'pause'` — they are declined, since a delegated run
   * cannot wait for a person; the inner agent is told why and answers
   * accordingly.
   */
  onApproval?: RunOptions['onApproval'];
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

const DELEGATED_DECLINE: ToolApprovalDecision = {
  approved: false,
  reason: 'no one can approve calls of a delegated agent',
};

const DEFAULT_SCHEMA = z.object({
  task: z.string().describe('The task to delegate to the agent'),
});

/**
 * The agent as a tool another agent calls with a task. The inner run gets the caller's signal,
 * user, deps, permission mode and `session` rules (so a caller in `plan` mode delegates no edits,
 * and its deny rules hold for the delegate) and, unless the inner agent has a workspace of its
 * own, the caller's workspace. Its calls go through the same permission decision as the caller's,
 * the settings files of the runtime included.
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
        const effectiveTimeout = timeout ?? agent.config.timeout;

        const result = await cogitator.run(delegate, {
          input: params.task,
          timeout: effectiveTimeout,
          signal: context.signal,
          ...(context.userId !== undefined && { userId: context.userId }),
          ...(context.deps !== undefined && { deps: context.deps }),
          ...(!delegate.config.workspace && context.workspace && { workspace: context.workspace }),
          ...(context.permissions && {
            permissions: {
              mode: context.permissions.mode,
              inherited: context.permissions.inherited,
            },
          }),
          onApproval: async (request) => {
            const decision = onApproval ? await onApproval(request) : 'pause';
            return decision === 'pause' ? DELEGATED_DECLINE : decision;
          },
        });

        if (result.status === 'paused') {
          const questions = pendingQuestions(result);
          return {
            output: result.output,
            success: false,
            error:
              questions.length > 0
                ? `The delegated agent paused to ask ${questions.map((question) => `"${question.message}"`).join(', ')}, which a delegated run cannot wait for`
                : `The delegated agent paused for approval of ${(result.pendingApprovals ?? []).map((p) => p.toolName).join(', ')}, which a delegated run cannot wait for`,
          };
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
        if (isTripwire(error)) throw error;
        return {
          output: '',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
