/**
 * Swarm job processor
 *
 * Recreates a Swarm from serialized config and executes it.
 */

import type { Agent } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { PipelineConfig, PipelineStage, SwarmConfig } from '@cogitator-ai/types';
import type {
  SerializedAgent,
  SerializedSwarm,
  SwarmTopology,
  SwarmJobPayload,
  SwarmJobResult,
  WorkerRuntime,
  JobExecutionOptions,
} from '../types';
import { createAgentFromConfig, resolveRuntime } from './shared.js';

const DEFAULT_MAX_ROUNDS = 3;

function stringifyOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * The `collaborative` topology as a pipeline: in each of `rounds` rounds every agent contributes
 * in turn, seeing the task and every contribution so far. The coordinator, when there is one,
 * combines the contributions into the answer, otherwise the last contribution is the answer and
 * its agent is asked to make it complete.
 */
export function collaborativePipeline(
  agents: readonly Agent[],
  coordinator: Agent | undefined,
  rounds: number
): PipelineConfig {
  if (agents.length === 0) {
    throw new Error("Swarm topology 'collaborative' requires at least one agent");
  }
  const totalRounds = Math.max(1, Math.floor(rounds));
  const stages: PipelineStage[] = [];
  const labels = new Map<string, { agent: string; round: number }>();
  for (let round = 1; round <= totalRounds; round++) {
    for (const agent of agents) {
      const name = `${agent.name} (round ${round})`;
      labels.set(name, { agent: agent.name, round });
      stages.push({ name, agent });
    }
  }
  const synthesis = coordinator ? `${coordinator.name} (synthesis)` : undefined;
  if (coordinator && synthesis) stages.push({ name: synthesis, agent: coordinator });
  const lastContribution = stages[stages.length - (coordinator ? 2 : 1)].name;
  const team = agents.map((agent) => agent.name).join(', ');

  return {
    stages,
    stageInput: (_previous, stage, ctx) => {
      const contributions = [...ctx.previousOutputs].map(([stageName, output]) => {
        const label = labels.get(stageName);
        const heading = label ? `${label.agent}, round ${label.round}` : stageName;
        return `[${heading}]\n${stringifyOutput(output)}`;
      });
      const transcript =
        contributions.length > 0 ? contributions.join('\n\n') : 'None yet: you contribute first.';
      const header = `Task:\n${stringifyOutput(ctx.input)}\n\nContributions so far:\n${transcript}\n\n`;

      if (stage.name === synthesis) {
        return (
          header +
          `You lead a collaboration of ${team}. Combine their contributions into one complete ` +
          'answer to the task: keep what is right, settle what they disagree on, and leave out ' +
          'what is wrong. Reply with the answer only.'
        );
      }
      const label = labels.get(stage.name)!;
      const finalTurn =
        stage.name === lastContribution
          ? ' Yours is the last contribution: write the complete answer to the task, taking in ' +
            'everything above.'
          : '';
      return (
        header +
        `You are ${label.agent}, working with ${team}, in round ${label.round} of ${totalRounds}. ` +
        'Add your contribution: build on what is there, fill in what is missing and correct ' +
        `what is wrong.${finalTurn} Reply with your contribution only.`
      );
    },
  };
}

/**
 * Translate a serialized swarm topology into a full swarm configuration.
 */
export function buildSwarmConfig(
  serialized: SerializedSwarm,
  runtime: WorkerRuntime,
  name = `worker-swarm-${Date.now()}`
): SwarmConfig {
  const resolved = resolveRuntime(runtime);
  const create = (agent: SerializedAgent): Agent => createAgentFromConfig(agent, resolved);
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
      return {
        name,
        strategy: 'pipeline',
        pipeline: collaborativePipeline(agents, coordinator, maxRounds),
      };

    default: {
      const exhaustive: never = serialized.topology;
      throw new Error(`Unknown swarm topology: ${String(exhaustive)}`);
    }
  }
}

function countRounds(
  topology: SwarmTopology,
  config: SwarmConfig,
  votes: Map<string, unknown> | undefined,
  maxRounds: number
): number {
  if (topology === 'collaborative') return Math.max(1, Math.floor(maxRounds));
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
  runtime: WorkerRuntime = {},
  execution: JobExecutionOptions = {}
): Promise<SwarmJobResult> {
  const resolved = resolveRuntime(runtime);
  const config = buildSwarmConfig(payload.swarmConfig, resolved, `worker-swarm-${payload.jobId}`);
  const swarm = new Swarm(resolved.cogitator, config);

  const stageAgents = new Map(
    (config.pipeline?.stages ?? []).map((stage) => [stage.name, stage.agent.name])
  );

  try {
    const result = await swarm.run({
      input: payload.input,
      ...(execution.signal && { signal: execution.signal }),
    });

    return {
      type: 'swarm',
      output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
      rounds: countRounds(
        payload.swarmConfig.topology,
        config,
        result.votes,
        payload.swarmConfig.maxRounds ?? DEFAULT_MAX_ROUNDS
      ),
      agentOutputs: Array.from(result.agentResults, ([key, runResult]) => ({
        agent: stageAgents.get(key) ?? key,
        output: runResult.output,
      })),
    };
  } finally {
    await swarm.close();
  }
}
