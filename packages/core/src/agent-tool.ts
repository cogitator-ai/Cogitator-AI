import type { RunOptions, Tool, ToolApprovalDecision, ToolContext } from '@cogitator-ai/types';
import type { Agent } from './agent';
import type { Cogitator } from './runtime';
import { tool } from './tool';
import { z } from 'zod';

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

export function agentAsTool(
  cogitator: Cogitator,
  agent: Agent,
  options: AgentAsToolOptions
): Tool<{ task: string }, AgentToolResult> {
  const {
    name,
    description,
    timeout,
    includeUsage = false,
    includeToolCalls = false,
    onApproval,
  } = options;

  return tool({
    name,
    description,
    parameters: DEFAULT_SCHEMA,
    timeout,
    sideEffects: ['external'],

    execute: async (params: { task: string }, context: ToolContext): Promise<AgentToolResult> => {
      try {
        const effectiveTimeout = timeout ?? agent.config.timeout;

        const result = await cogitator.run(agent, {
          input: params.task,
          timeout: effectiveTimeout,
          signal: context.signal,
          ...(context.userId !== undefined && { userId: context.userId }),
          onApproval: async (request) => {
            const decision = onApproval ? await onApproval(request) : 'pause';
            return decision === 'pause' ? DELEGATED_DECLINE : decision;
          },
        });

        if (result.status === 'paused') {
          return {
            output: result.output,
            success: false,
            error: `The delegated agent paused for approval of ${(result.pendingApprovals ?? []).map((p) => p.toolName).join(', ')}, which a delegated run cannot wait for`,
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
        return {
          output: '',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
