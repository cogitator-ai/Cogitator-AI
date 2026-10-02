/**
 * Swarm job processor
 *
 * Recreates a Swarm from serialized config and executes it.
 */

import type { Agent } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmConfig } from '@cogitator-ai/types';
import type {
  SerializedAgent,
  SerializedSwarm,
  SwarmJobPayload,
  SwarmJobResult,
  WorkerRuntime,
} from '../types';
import { createAgentFromConfig, resolveCogitator } from './shared.js';

const DEFAULT_MAX_ROUNDS = 3;

/**
 * Translate a serialized swarm topology into a full swarm configuration.
 */
export function buildSwarmConfig(
  serialized: SerializedSwarm,
  runtime: WorkerRuntime,
  name = `worker-swarm-${Date.now()}`
): SwarmConfig {
  const create = (agent: SerializedAgent): Agent => createAgentFromConfig(agent, runtime);
  const agents = serialized.agents.map(create);
  const coordinator = serialized.coordinator ? create(serialized.coordinator) : undefined;
  const maxRounds = serialized.maxRounds ?? DEFAULT_MAX_ROUNDS;

  switch (serialized.topology) {
    case 'sequential':
      return {
        name,
        strategy: 'pipeline',
        pipeline: { stages: agents.map((agent) => ({ name: agent.name, agent })) },
      };

    case 'hierarchical':
      if (!coordinator) {
        throw new Error("Swarm topology 'hierarchical' requires a coordinator agent");
      }
      return { name, strategy: 'hierarchical', supervisor: coordinator, workers: agents };

    case 'debate':
      return {
        name,
        strategy: 'debate',
        agents,
        moderator: coordinator,
        debate: { rounds: maxRounds },
      };

    case 'voting':
      return {
        name,
        strategy: 'consensus',
        agents,
        supervisor: coordinator,
        consensus: {
          threshold: serialized.consensusThreshold ?? 0.5,
          maxRounds,
          resolution: 'majority',
          onNoConsensus: coordinator ? 'supervisor-decides' : 'escalate',
        },
      };

    case 'collaborative':
      return { name, strategy: 'round-robin', agents };

    default: {
      const exhaustive: never = serialized.topology;
      throw new Error(`Unknown swarm topology: ${String(exhaustive)}`);
    }
  }
}

function countRounds(config: SwarmConfig, votes: Map<string, unknown> | undefined): number {
  if (config.strategy === 'debate') return config.debate?.rounds ?? 1;
  if (config.strategy === 'consensus' && votes) {
    const rounds = new Set<number>();
    for (const key of votes.keys()) {
      const match = /_round(\d+)$/.exec(key);
      if (match) rounds.add(Number(match[1]));
    }
    return Math.max(rounds.size, 1);
  }
  return 1;
}

export async function processSwarmJob(
  payload: SwarmJobPayload,
  runtime: WorkerRuntime = {}
): Promise<SwarmJobResult> {
  const config = buildSwarmConfig(payload.swarmConfig, runtime, `worker-swarm-${payload.jobId}`);
  const swarm = new Swarm(resolveCogitator(runtime), config);

  try {
    const result = await swarm.run({ input: payload.input });

    return {
      type: 'swarm',
      output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
      rounds: countRounds(config, result.votes),
      agentOutputs: Array.from(result.agentResults, ([agent, runResult]) => ({
        agent,
        output: runResult.output,
      })),
    };
  } finally {
    await swarm.close();
  }
}
