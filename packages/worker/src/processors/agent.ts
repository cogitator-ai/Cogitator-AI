/**
 * Agent job processor
 *
 * Recreates an Agent from serialized config and executes it.
 */

import type { AgentJobPayload, AgentJobResult, WorkerRuntime } from '../types';
import { createAgentFromConfig, resolveCogitator } from './shared.js';

export async function processAgentJob(
  payload: AgentJobPayload,
  runtime: WorkerRuntime = {}
): Promise<AgentJobResult> {
  const { agentConfig, input, threadId } = payload;

  const agent = createAgentFromConfig(agentConfig, runtime);
  const result = await resolveCogitator(runtime).run(agent, { input, threadId });

  return {
    type: 'agent',
    output: result.output,
    toolCalls: result.toolCalls.map((tc) => ({
      name: tc.name,
      input: tc.arguments,
      output: findToolOutput(result.messages, tc.id),
    })),
    tokenUsage: {
      prompt: result.usage.inputTokens,
      completion: result.usage.outputTokens,
      total: result.usage.totalTokens,
    },
  };
}

interface ToolMessageLike {
  role: string;
  toolCallId?: string;
  content: unknown;
}

/**
 * Tool results are recorded as `tool` messages; recover the output for a tool call.
 */
export function findToolOutput(messages: readonly ToolMessageLike[], toolCallId: string): unknown {
  const message = messages.find((m) => m.role === 'tool' && m.toolCallId === toolCallId);
  if (!message) return undefined;
  if (typeof message.content !== 'string') return message.content;
  try {
    return JSON.parse(message.content) as unknown;
  } catch {
    return message.content;
  }
}
