import { NextRequest, NextResponse } from 'next/server';
import {
  getSwarms,
  createSwarm,
  getAgents,
  initializeExtendedSchema,
} from '@/lib/cogitator/db';
import { initializeSchema } from '@/lib/db';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    try {
      await initializeSchema();
      await initializeExtendedSchema();
      initialized = true;
    } catch (error) {
      console.error('[api/swarms] Failed to initialize database:', error);
    }
  }
}

const VALID_STRATEGIES = [
  'hierarchical',
  'round-robin',
  'consensus',
  'auction',
  'pipeline',
  'debate',
] as const;

export async function GET(request: NextRequest) {
  try {
    await ensureInitialized();

    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');
    const search = searchParams.get('search') || undefined;
    const strategy = searchParams.get('strategy') || undefined;

    const result = await getSwarms({ limit, offset, search, strategy });

    return NextResponse.json({
      swarms: result.swarms,
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[api/swarms] Failed to fetch swarms:', error);
    return NextResponse.json({ error: 'Failed to fetch swarms' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureInitialized();
    const body = await request.json();

    if (!body.name || !body.strategy || !body.config) {
      return NextResponse.json(
        { error: 'Name, strategy, and config are required' },
        { status: 400 }
      );
    }

    if (!VALID_STRATEGIES.includes(body.strategy)) {
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

    const swarm = await createSwarm({
      name: body.name,
      description: body.description,
      strategy: body.strategy,
      config: body.config,
      agentIds: body.agentIds,
    });

    return NextResponse.json(swarm, { status: 201 });
  } catch (error) {
    console.error('[api/swarms] Failed to create swarm:', error);
    return NextResponse.json({ error: 'Failed to create swarm' }, { status: 500 });
  }
}

