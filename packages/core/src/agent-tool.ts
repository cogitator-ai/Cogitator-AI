import type { Tool, ToolContext } from '@cogitator-ai/types';
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

export function agentAsTool(
  cogitator: Cogitator,
  agent: Agent,
  options: AgentAsToolOptions
): Tool<{ task: string }, AgentToolResult> {
  const { name, description, timeout, includeUsage = false, includeToolCalls = false } = options;

  return tool({
    name,
    description,
    parameters: DEFAULT_SCHEMA,
    timeout,
    sideEffects: ['external'],

    execute: async (params: { task: string }, _context: ToolContext): Promise<AgentToolResult> => {
      try {
        const effectiveTimeout = timeout ?? agent.config.timeout;

        const result = await cogitator.run(agent, {
          input: params.task,
          timeout: effectiveTimeout,
        });

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
