import { NextRequest, NextResponse } from 'next/server';
import { getRun } from '@/lib/cogitator/db';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const run = await getRun(id);

    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    return NextResponse.json(run);
  } catch (error) {
    console.error('[api/runs] Failed to fetch run:', error);
    return NextResponse.json({ error: 'Failed to fetch run' }, { status: 500 });
  }
}
