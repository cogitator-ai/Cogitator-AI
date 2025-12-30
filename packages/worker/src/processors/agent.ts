/**
 * Agent job processor
 *
 * Recreates an Agent from serialized config and executes it.
 */

import { Cogitator, Agent, tool } from '@cogitator/core';
import { z } from 'zod';
import type { Tool, ToolSchema } from '@cogitator/types';
import type { AgentJobPayload, AgentJobResult } from '../types.js';

/**
 * Convert JSON Schema parameters to a permissive Zod schema
 *
 * Since we only have the JSON Schema and not the original Zod type,
 * we create a schema that accepts any object matching the required structure.
 */
function jsonSchemaToZod(params: ToolSchema['parameters']): z.ZodType {
  const properties = params.properties;
  const required = params.required ?? [];

  if (Object.keys(properties).length === 0) {
    return z.object({});
  }

  // Create a permissive object schema
  const shape: Record<string, z.ZodType> = {};
  for (const [key, _] of Object.entries(properties)) {
    shape[key] = required.includes(key) ? z.unknown() : z.unknown().optional();
  }

  return z.object(shape).passthrough();
}

/**
 * Recreate tools from schemas
 *
 * Note: This creates stub tools that log execution but can't actually run
 * the original code. For full tool support, tools need to be registered
 * separately on the worker or use a remote execution mechanism.
 */
function recreateTools(schemas: ToolSchema[]): Tool[] {
  return schemas.map((schema) =>
    tool({
      name: schema.name,
      description: schema.description,
      parameters: jsonSchemaToZod(schema.parameters),
      execute: async (input) => {
        // Stub implementation - actual tool execution requires
        // either built-in tools or a remote execution mechanism
        console.warn(
          `[worker] Tool "${schema.name}" called with input:`,
          JSON.stringify(input)
        );
        return {
          warning: 'Tool executed in worker with stub implementation',
          input,
        };
      },
    })
  );
}

/**
 * Process an agent job
 */
export async function processAgentJob(
  payload: AgentJobPayload
): Promise<AgentJobResult> {
  const { agentConfig, input, threadId } = payload;

  // Create Cogitator instance
  // TODO: Support worker-level config for memory, sandbox, etc.
  const cogitator = new Cogitator();

  // Recreate tools from schemas
  const tools = recreateTools(agentConfig.tools);

  // Create Agent
  const agent = new Agent({
    name: agentConfig.name,
    model: `${agentConfig.provider}/${agentConfig.model}`,
    instructions: agentConfig.instructions,
    temperature: agentConfig.temperature,
    maxTokens: agentConfig.maxTokens,
    tools,
  });

  // Execute
  const result = await cogitator.run(agent, {
    input,
    threadId,
  });

  // Format tool calls - ToolCall has id, name, arguments
  const toolCalls = result.toolCalls.map((tc) => ({
    name: tc.name,
    input: tc.arguments,
    output: undefined, // ToolCall doesn't store output directly
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
