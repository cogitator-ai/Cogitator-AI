import { NextRequest, NextResponse } from 'next/server';
import { getRuns, initializeExtendedSchema } from '@/lib/cogitator/db';
import { initializeSchema } from '@/lib/db';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    try {
      await initializeSchema();
      await initializeExtendedSchema();
      initialized = true;
    } catch (error) {
      console.error('[api/runs] Failed to initialize database:', error);
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    await ensureInitialized();

    const searchParams = request.nextUrl.searchParams;
    const agentId = searchParams.get('agentId') || undefined;
    const status = searchParams.get('status') || undefined;
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');

    const runs = await getRuns({ agentId, status, limit, offset });
    return NextResponse.json(runs);
  } catch (error) {
    console.error('[api/runs] Failed to fetch runs:', error);
    return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 });
  }
}
