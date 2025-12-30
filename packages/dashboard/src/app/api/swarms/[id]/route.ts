import { NextRequest, NextResponse } from 'next/server';
import { getSwarm, updateSwarm, deleteSwarm, getAgents } from '@/lib/cogitator/db';

interface RouteParams {
  params: Promise<{ id: string }>;
}

const VALID_STRATEGIES = [
  'hierarchical',
  'round-robin',
  'consensus',
  'auction',
  'pipeline',
  'debate',
] as const;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const swarm = await getSwarm(id);

    if (!swarm) {
      return NextResponse.json({ error: 'Swarm not found' }, { status: 404 });
    }

    return NextResponse.json(swarm);
  } catch (error) {
    console.error('[api/swarms] Failed to fetch swarm:', error);
    return NextResponse.json({ error: 'Failed to fetch swarm' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.strategy && !VALID_STRATEGIES.includes(body.strategy)) {
      return NextResponse.json(
        { error: `Invalid strategy. Must be one of: ${VALID_STRATEGIES.join(', ')}` },
        { status: 400 }
      );
    }

    if (body.agentIds && body.agentIds.length > 0) {
      const agents = await getAgents();
      const validIds = new Set(agents.map((a) => a.id));
      const invalidIds = body.agentIds.filter((id: string) => !validIds.has(id));
      if (invalidIds.length > 0) {
        return NextResponse.json(
          { error: `Invalid agent IDs: ${invalidIds.join(', ')}` },
          { status: 400 }
        );
      }
    }

    const swarm = await updateSwarm(id, {
      name: body.name,
      description: body.description,
      strategy: body.strategy,
      config: body.config,
      agentIds: body.agentIds,
    });

    if (!swarm) {
      return NextResponse.json({ error: 'Swarm not found' }, { status: 404 });
    }

    return NextResponse.json(swarm);
  } catch (error) {
    console.error('[api/swarms] Failed to update swarm:', error);
    return NextResponse.json({ error: 'Failed to update swarm' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const deleted = await deleteSwarm(id);

    if (!deleted) {
      return NextResponse.json({ error: 'Swarm not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api/swarms] Failed to delete swarm:', error);
    return NextResponse.json({ error: 'Failed to delete swarm' }, { status: 500 });
  }
}

