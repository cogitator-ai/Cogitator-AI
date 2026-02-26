/**
 * Swarm job processor
 *
 * Recreates a Swarm from serialized config and executes it.
 */

import { Cogitator, Agent } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmStrategy, SwarmConfig } from '@cogitator-ai/types';
import type { SwarmJobPayload, SwarmJobResult, SerializedAgent } from '../types';
import { recreateTools } from './shared.js';

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

export async function processSwarmJob(payload: SwarmJobPayload): Promise<SwarmJobResult> {
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

  const agentOutputs: { agent: string; output: string }[] = [];
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
