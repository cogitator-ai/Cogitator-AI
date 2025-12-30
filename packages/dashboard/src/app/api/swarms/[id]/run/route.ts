import { NextRequest, NextResponse } from 'next/server';
import { getSwarm, getAgent, createSwarmRun, updateSwarmRun } from '@/lib/cogitator/db';
import { getCogitator } from '@/lib/cogitator';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { input } = body;

    if (!input || typeof input !== 'string') {
      return NextResponse.json({ error: 'Input is required' }, { status: 400 });
    }

    const swarm = await getSwarm(id);
    if (!swarm) {
      return NextResponse.json({ error: 'Swarm not found' }, { status: 404 });
    }

    // Get agents for this swarm
    const agents = await Promise.all(
      swarm.agentIds.map((agentId: string) => getAgent(agentId))
    );
    const validAgents = agents.filter(Boolean);

    if (validAgents.length === 0) {
      return NextResponse.json(
        { error: 'No valid agents found for this swarm' },
        { status: 400 }
      );
    }

    // Create a run record
    const run = await createSwarmRun({
      swarmId: id,
      input,
      status: 'running',
    });

    const startTime = Date.now();

    try {
      const cogitator = await getCogitator();

      // For now, run a simple sequential execution with first agent
      // Full swarm execution would use @cogitator/swarms package
      const firstAgent = validAgents[0]!;
      
      // Create a simple agent config for the run
      const agentConfig = {
        id: firstAgent.id,
        name: firstAgent.name,
        model: firstAgent.model,
        instructions: firstAgent.instructions || `You are ${firstAgent.name}, part of a ${swarm.strategy} swarm. ${swarm.description || ''}`,
        maxIterations: 5,
      };
      
      const result = await cogitator.run(
        {
          id: agentConfig.id,
          name: agentConfig.name,
          model: agentConfig.model,
          instructions: agentConfig.instructions,
          tools: [],
          config: agentConfig,
          clone: () => { throw new Error('Clone not supported'); },
        },
        { input }
      );

      const duration = Date.now() - startTime;

      // Update run with result
      await updateSwarmRun(run.id, {
        status: 'completed',
        output: result.output,
        duration,
        tokensUsed: result.usage?.totalTokens || 0,
      });

      return NextResponse.json({
        runId: run.id,
        output: result.output,
        status: 'completed',
        duration,
        tokensUsed: result.usage?.totalTokens || 0,
        agentsUsed: [firstAgent.id],
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
}

