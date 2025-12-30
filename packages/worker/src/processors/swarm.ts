/**
 * Swarm job processor
 *
 * Recreates a Swarm from serialized config and executes it.
 */

import { Cogitator, Agent, tool } from '@cogitator/core';
import { Swarm } from '@cogitator/swarms';
import { z } from 'zod';
import type { Tool, ToolSchema, SwarmStrategy, SwarmConfig } from '@cogitator/types';
import type { SwarmJobPayload, SwarmJobResult, SerializedAgent } from '../types.js';

/**
 * Convert JSON Schema to permissive Zod schema
 */
function jsonSchemaToZod(params: ToolSchema['parameters']): z.ZodType {
  const properties = params.properties;
  const required = params.required ?? [];

  if (Object.keys(properties).length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodType> = {};
  for (const [key, _] of Object.entries(properties)) {
    shape[key] = required.includes(key) ? z.unknown() : z.unknown().optional();
  }

  return z.object(shape).passthrough();
}

/**
 * Recreate tools from schemas
 */
function recreateTools(schemas: ToolSchema[]): Tool[] {
  return schemas.map((schema) =>
    tool({
      name: schema.name,
      description: schema.description,
      parameters: jsonSchemaToZod(schema.parameters),
      execute: async (input) => {
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
 * Recreate an agent from serialized config
 */
function recreateAgent(config: SerializedAgent): Agent {
  const tools = recreateTools(config.tools);
  return new Agent({
    name: config.name,
    model: `${config.provider}/${config.model}`,
    instructions: config.instructions,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    tools,
  });
}

/**
 * Map topology to strategy type
 */
function getStrategyType(
  topology: 'sequential' | 'hierarchical' | 'collaborative' | 'debate' | 'voting'
): SwarmStrategy {
  switch (topology) {
    case 'sequential':
      return 'pipeline';
    case 'hierarchical':
      return 'hierarchical';
    case 'collaborative':
      return 'round-robin';
    case 'debate':
      return 'debate';
    case 'voting':
      return 'consensus';
    default:
      return 'round-robin';
  }
}

/**
 * Process a swarm job
 */
export async function processSwarmJob(
  payload: SwarmJobPayload
): Promise<SwarmJobResult> {
  const { swarmConfig, input } = payload;

  const cogitator = new Cogitator();

  const agents = swarmConfig.agents.map(recreateAgent);

  const strategyType = getStrategyType(swarmConfig.topology);

  const config: SwarmConfig = {
    name: `worker-swarm-${Date.now()}`,
    agents,
    strategy: strategyType,
  };

  const swarm = new Swarm(cogitator, config);

  const result = await swarm.run({
    input,
  });

  const agentOutputs: Array<{ agent: string; output: string }> = [];
  if (result.agentResults) {
    for (const [agentId, runResult] of result.agentResults) {
      agentOutputs.push({
        agent: agentId,
        output: runResult.output,
      });
    }
  }

  return {
    type: 'swarm',
    output: String(result.output ?? ''),
    rounds: 1,
    agentOutputs,
  };
}
