import { NextRequest, NextResponse } from 'next/server';
import {
  getThreads,
  createThread,
  initializeExtendedSchema,
} from '@/lib/cogitator/db';
import { initializeSchema } from '@/lib/db';
import { nanoid } from 'nanoid';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    try {
      await initializeSchema();
      await initializeExtendedSchema();
      initialized = true;
    } catch (error) {
      console.error('[api/threads] Failed to initialize database:', error);
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    await ensureInitialized();

    const searchParams = request.nextUrl.searchParams;
    const agentId = searchParams.get('agentId') || undefined;
    const limit = parseInt(searchParams.get('limit') || '50');

    const threads = await getThreads({ agentId, limit });
    return NextResponse.json(threads);
  } catch (error) {
    console.error('[api/threads] Failed to fetch threads:', error);
    return NextResponse.json({ error: 'Failed to fetch threads' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureInitialized();
    const body = await request.json();

    const thread = await createThread({
      id: `thread_${nanoid(12)}`,
      agentId: body.agentId,
      title: body.title,
    });

    return NextResponse.json(thread, { status: 201 });
  } catch (error) {
    console.error('[api/threads] Failed to create thread:', error);
    return NextResponse.json({ error: 'Failed to create thread' }, { status: 500 });
  }
}

