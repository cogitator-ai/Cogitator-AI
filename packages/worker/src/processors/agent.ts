/**
 * Agent job processor
 *
 * Recreates an Agent from serialized config and executes it.
 */

import { Cogitator, Agent } from '@cogitator-ai/core';
import type { AgentJobPayload, AgentJobResult } from '../types';
import { recreateTools } from './shared.js';

export async function processAgentJob(payload: AgentJobPayload): Promise<AgentJobResult> {
  const { agentConfig, input, threadId } = payload;

  const cogitator = new Cogitator();

  const tools = recreateTools(agentConfig.tools);

  const agent = new Agent({
    name: agentConfig.name,
    model: `${agentConfig.provider}/${agentConfig.model}`,
    instructions: agentConfig.instructions,
    temperature: agentConfig.temperature,
    maxTokens: agentConfig.maxTokens,
    tools,
  });

  const result = await cogitator.run(agent, {
    input,
    threadId,
  });

  const toolCalls = result.toolCalls.map((tc) => ({
    name: tc.name,
    input: tc.arguments,
    output: undefined,
  }));

  return {
    type: 'agent',
    output: result.output,
    toolCalls,
    tokenUsage: {
      prompt: result.usage.inputTokens,
      completion: result.usage.outputTokens,
      total: result.usage.totalTokens,
    },
  };
}
