import { NextResponse } from 'next/server';
import { getAllLogs, createLog, getLogStats } from '@/lib/db/logs';
import { initializeSchema } from '@/lib/db';
import { publish, CHANNELS } from '@/lib/redis';
import { withAuth } from '@/lib/auth/middleware';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    try {
      await initializeSchema();
      initialized = true;
    } catch (error) {
      console.error('Failed to initialize database:', error);
    }
  }
}

export const GET = withAuth(async (request) => {
  try {
    await ensureInitialized();

    const searchParams = request.nextUrl.searchParams;
    const level = searchParams.get('level') || undefined;
    const source = searchParams.get('source') || undefined;
    const runId = searchParams.get('runId') || undefined;
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');
    const since = searchParams.get('since');

    const logs = await getAllLogs({
      level,
      source,
      runId,
      limit,
      offset,
      since: since ? new Date(since) : undefined,
    });

    const stats = await getLogStats();

    return NextResponse.json({
      logs,
      stats,
      pagination: { limit, offset },
    });
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
});

export const POST = withAuth(async (request) => {
  try {
    await ensureInitialized();
    const body = await request.json();

    if (!body.level || !body.message) {
      return NextResponse.json({ error: 'level and message are required' }, { status: 400 });
    }

    const log = await createLog({
      level: body.level,
      message: body.message,
      source: body.source,
      agentId: body.agentId,
      runId: body.runId,
      metadata: body.metadata,
    });

    try {
      await publish(CHANNELS.LOG_ENTRY, log);
    } catch {}

    return NextResponse.json(log, { status: 201 });
  } catch (error) {
    console.error('Failed to create log:', error);
    return NextResponse.json({ error: 'Failed to create log' }, { status: 500 });
  }
});
