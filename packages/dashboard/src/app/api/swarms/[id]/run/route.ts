import { NextResponse } from 'next/server';
import { getSwarm, getAgent, createSwarmRun, updateSwarmRun } from '@/lib/cogitator/db';
import { getCogitator } from '@/lib/cogitator';
import { Swarm } from '@cogitator-ai/swarms';
import { Agent } from '@cogitator-ai/core';
import type {
  SwarmConfig,
  SwarmStrategy,
  DebateConfig,
  RoundRobinConfig,
  ConsensusConfig,
} from '@cogitator-ai/types';
import { withAuth } from '@/lib/auth/middleware';
import { swarmRunSchema } from '@/lib/validation';

export const POST = withAuth(async (request, context) => {
  try {
    const { id } = await context!.params!;
    const body = await request.json();

    const parsed = swarmRunSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: parsed.error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 }
      );
    }

    const { input } = parsed.data;

    const swarmData = await getSwarm(id);
    if (!swarmData) {
      return NextResponse.json({ error: 'Swarm not found' }, { status: 404 });
    }

    const agentDataList = await Promise.all(
      swarmData.agentIds.map((agentId: string) => getAgent(agentId))
    );
    const validAgentData = agentDataList.filter(Boolean);

    if (validAgentData.length === 0) {
      return NextResponse.json({ error: 'No valid agents found for this swarm' }, { status: 400 });
    }

    const run = await createSwarmRun({
      swarmId: id,
      input,
      status: 'running',
    });

    const startTime = Date.now();

    try {
      console.log('[swarm-run] Starting swarm execution for:', id);
      const cogitator = await getCogitator();
      console.log('[swarm-run] Got cogitator instance');

      const agents = validAgentData
        .filter((d): d is NonNullable<typeof d> => d !== null)
        .map(
          (agentData) =>
            new Agent({
              id: agentData.id,
              name: agentData.name,
              model: agentData.model,
              instructions:
                agentData.instructions || `You are ${agentData.name}, a helpful assistant.`,
              tools: [],
            })
        );

      const strategy = swarmData.strategy as SwarmStrategy;

      const swarmConfig: SwarmConfig = {
        name: swarmData.name,
        strategy,
        agents,
      };

      switch (strategy) {
        case 'debate':
          if (agents.length < 2) {
            throw new Error('Debate strategy requires at least 2 agents');
          }
          swarmConfig.agents = agents.map((agent, i) => {
            const newAgent = agent.clone({
              instructions:
                i === 0
                  ? `${agent.instructions}\n\nYou are an ADVOCATE. Argue IN FAVOR of propositions.`
                  : i === 1
                    ? `${agent.instructions}\n\nYou are a CRITIC. Argue AGAINST propositions and find weaknesses.`
                    : `${agent.instructions}\n\nYou are a MODERATOR. Synthesize arguments fairly.`,
            });
            return newAgent;
          });
          if (agents.length >= 3) {
            swarmConfig.moderator = agents[2].clone({
              instructions: `${agents[2].instructions}\n\nAs MODERATOR, summarize debates and provide balanced conclusions.`,
            });
          }
          swarmConfig.debate = {
            rounds: 2,
            format: 'structured',
          } as DebateConfig;
          break;

        case 'round-robin':
          swarmConfig.roundRobin = {
            sticky: false,
            rotation: 'sequential',
          } as RoundRobinConfig;
          break;

        case 'consensus':
          if (agents.length < 2) {
            throw new Error('Consensus strategy requires at least 2 agents');
          }
          swarmConfig.consensus = {
            threshold: 0.6,
            maxRounds: 3,
            resolution: 'majority',
            onNoConsensus: 'supervisor-decides',
          } as ConsensusConfig;
          break;

        case 'hierarchical':
          if (agents.length < 2) {
            throw new Error('Hierarchical strategy requires at least 2 agents');
          }
          swarmConfig.supervisor = agents[0].clone({
            instructions: `${agents[0].instructions}\n\nYou are the SUPERVISOR. Delegate tasks to workers and synthesize results.`,
          });
          swarmConfig.workers = agents.slice(1);
          swarmConfig.agents = undefined;
          break;

        case 'pipeline':
          swarmConfig.pipeline = {
            stages: agents.map((agent, i) => ({
              name: `stage_${i + 1}`,
              agent,
            })),
          };
          break;

        case 'auction':
          swarmConfig.auction = {
            bidding: 'capability-match',
            selection: 'highest-bid',
          };
          break;

        default:
          break;
      }

      console.log('[swarm-run] Creating Swarm with config:', {
        name: swarmConfig.name,
        strategy: swarmConfig.strategy,
        agentCount: swarmConfig.agents?.length || 0,
      });
      const swarm = new Swarm(cogitator, swarmConfig);
      console.log('[swarm-run] Swarm created, id:', swarm.id);

      const eventLog: string[] = [];
      swarm.on('*', (event) => {
        console.log('[swarm-event]', event.type, event.data);
        eventLog.push(`[${new Date().toISOString()}] ${event.type}: ${JSON.stringify(event.data)}`);
      });

      console.log('[swarm-run] Starting swarm.run() with input:', input.slice(0, 50));
      const result = await swarm.run({
        input,
        context: {
          swarmId: swarmData.id,
          strategy: swarmData.strategy,
        },
      });

      const duration = Date.now() - startTime;

      let totalTokens = 0;
      const agentsUsed: string[] = [];
      for (const [agentName, agentResult] of result.agentResults) {
        agentsUsed.push(agentName);
        totalTokens += agentResult.usage?.totalTokens || 0;
      }

      const output =
        typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);

      await updateSwarmRun(run.id, {
        status: 'completed',
        output,
        duration,
        tokensUsed: totalTokens,
      });

      return NextResponse.json({
        runId: run.id,
        output,
        status: 'completed',
        duration,
        tokensUsed: totalTokens,
        agentsUsed,
        strategy: swarmData.strategy,
        structured: result.structured,
        eventLog: eventLog.slice(-20),
      });
    } catch (runError) {
      const duration = Date.now() - startTime;
      const errorMessage = runError instanceof Error ? runError.message : 'Run failed';

      await updateSwarmRun(run.id, {
        status: 'failed',
        error: errorMessage,
        duration,
      });

      return NextResponse.json(
        {
          runId: run.id,
          error: errorMessage,
          status: 'failed',
          duration,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('[api/swarms/run] Failed to run swarm:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to run swarm' },
      { status: 500 }
    );
  }
});
